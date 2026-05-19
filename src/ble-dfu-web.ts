/**
 * Nordic Secure DFU over Web Bluetooth.
 *
 * Mirrors the path the iOS / Android Calliope app uses when partial flashing
 * is impossible (typically because the DAL hash on the device doesn't match
 * the hex's DAL hash — e.g. flashing a plain MakeCode hex onto a Calliope
 * currently running MakeCode + pxt-blocks, or vice versa).
 *
 * iOS/Android use `@microbit/capacitor-community-nordic-dfu`, which wraps the
 * native Nordic DFU libraries. The native libraries bundle the full Secure
 * DFU protocol; that protocol is itself transport-agnostic and works just
 * fine over Web Bluetooth's `BluetoothRemoteGATTCharacteristic` API. This
 * file is a hand-written JS implementation tuned to the Calliope CODAL build:
 *
 *   - Calliope CODAL enables `MICROBIT_BLE_DFU_SERVICE` (default) and uses
 *     Nordic SDK 17's `ble_dfu_buttonless_init` with bonds (the bootloader is
 *     built with `NRF_DFU_BLE_REQUIRES_BONDS=1`).
 *   - Therefore the in-application "buttonless" characteristic is the
 *     **with-bonds** variant (8EC90004-…).
 *   - The bootloader, once entered, advertises the standard Nordic DFU
 *     service (16-bit UUID 0xFE59) with the secure DFU control / packet
 *     characteristics (8EC90001 / 8EC90002).
 *
 * Procedure:
 *
 *   1. Buttonless DFU enter — write 0x01 to the with-bonds characteristic
 *      on the running app. The device responds with 0x20 0x01 0x01
 *      (success), then disconnects and reboots into the bootloader.
 *   2. Reconnect — Web Bluetooth lets us call `gatt.connect()` on the same
 *      `BluetoothDevice`. The bootloader inherits the application's BD_ADDR
 *      (a Public address on nRF52833) so the same `BluetoothDevice` id
 *      resolves to it. The advertised name changes to "DfuTarg" but that
 *      doesn't matter once we already hold permission for the device.
 *   3. Set Packet Receipt Notification (PRN) — the bootloader will emit a
 *      checksum notification every N packets we write. PRN is the canonical
 *      flow-control mechanism for Nordic Secure DFU: without it, Chrome
 *      cheerfully queues writes faster than the bootloader's small RX
 *      buffer (NRF_DFU_BLE_BUFFERS, default 8) can drain, and packets
 *      silently get dropped — the bootloader keeps showing flash progress
 *      from the bytes it did receive, but our local CRC drifts and the
 *      next CalcChecksum / Execute trips. We pick PRN=12 (Nordic's
 *      reference default) — enough to amortise notification round-trips
 *      while staying well inside the RX buffer.
 *   4. Init packet phase:
 *        - Select Command Object → get max size, current offset, current CRC.
 *        - Create Command Object with the init packet's size.
 *        - Stream the init packet to the Packet characteristic.
 *        - Calculate Checksum → verify CRC matches our local CRC32.
 *        - Execute → bootloader commits the init packet.
 *   5. Firmware phase:
 *        - Select Data Object → get max chunk size.
 *        - Loop until firmware exhausted:
 *            - Create Data Object with min(remaining, max chunk size).
 *            - Stream that chunk to Packet characteristic in 20-byte writes
 *              (kept conservative to avoid MTU issues across phones), with
 *              PRN throttling.
 *            - Calculate Checksum → verify CRC.
 *            - Execute → bootloader writes the chunk to flash.
 *   6. The bootloader reboots into the freshly-flashed application.
 *
 * The microbit-specific init packet format is documented in
 * `node_modules/@microbit/microbit-connection/build/esm/bluetooth/flashing/nordic-dfu.js`
 * — kept byte-for-byte identical here so the V2 bootloader's
 * `nrf_dfu_validation_hash_ok` accepts it.
 */

import MemoryMap from 'nrf-intel-hex';
import { appendLog } from './log';

// ---- Service / characteristic UUIDs ----------------------------------------

/**
 * 16-bit Nordic Semiconductor assigned UUID for the Secure DFU service.
 * Both the in-application "buttonless" entry service and the bootloader's
 * full DFU service advertise under this UUID — only the characteristics
 * differ.
 */
const NORDIC_DFU_SERVICE = 0xfe59;

/**
 * In-application "buttonless" characteristic — with bonds. Written with
 * 0x01 to ask the device to reboot into the bootloader, preserving the
 * existing OS bond (the bootloader inherits the bond keys via the
 * peer-data shared region set up by `ble_dfu_buttonless_async_svci_init`).
 */
const BUTTONLESS_DFU_WITH_BONDS = '8ec90004-f315-4f60-9fb8-838830daea50';

/**
 * In-application "buttonless" characteristic — without bonds. We try this
 * as a fallback in case a future CODAL build flips `NRF_DFU_BLE_REQUIRES_BONDS`
 * to 0. Functionally identical from the central's point of view.
 */
const BUTTONLESS_DFU_WITHOUT_BONDS = '8ec90003-f315-4f60-9fb8-838830daea50';

/** Bootloader: Secure DFU control point. Commands + responses live here. */
const SECURE_DFU_CONTROL_POINT = '8ec90001-f315-4f60-9fb8-838830daea50';

/** Bootloader: Secure DFU packet. Raw firmware bytes get streamed here. */
const SECURE_DFU_PACKET = '8ec90002-f315-4f60-9fb8-838830daea50';

// ---- Protocol opcodes ------------------------------------------------------

/** Secure DFU control-point command opcodes (Nordic SDK 17 `nrf_dfu_op_t`). */
const Op = {
  CreateObject: 0x01,
  SetPRN: 0x02,
  CalcChecksum: 0x03,
  Execute: 0x04,
  SelectObject: 0x06,
  MtuGet: 0x07,
  Abort: 0x0c,
  Response: 0x60,
} as const;

/** Object types for Create/Select commands. */
const ObjType = {
  Command: 0x01,
  Data: 0x02,
} as const;

/** Result codes returned in control-point response packets. */
const Res = {
  Success: 0x01,
} as const;

// ---- Tunables --------------------------------------------------------------

/**
 * Per-packet payload sizes we'll try when the bootloader doesn't expose
 * MTU via `MTU_GET (0x07)` — the Calliope v2-bootloader rejects that
 * opcode the same way it rejects Abort.
 *
 * 20 ONLY. Confirmed empirically (rc07 campus-open debugging session
 * 2026-05-19) against the Calliope mini v2-bootloader using native
 * bleak/Python on Windows: the bootloader negotiates ATT MTU 23 even
 * though the OS reports `max_write_without_response_size=244`. Any
 * write >20 bytes to the Packet characteristic (8EC90002) succeeds at
 * the host's BLE stack but is silently dropped at the bootloader's
 * ATT layer — no PRN fires, the bootloader's offset stays at zero.
 * After enough silent drops, Windows tries to upgrade encryption
 * "just-works" thinking it'll help; the bonded bootloader rejects
 * the pairing → "X" on the LED matrix and the device is wedged until
 * reset.
 *
 * iOS Nordic DFU works because Apple's library hardcodes 20-byte
 * writes per Nordic Secure DFU recommendations — we do the same.
 *
 * Trade-off: ~4 KB/s wire speed. 180 KB firmware = ~45 s. Slow but
 * reliable. Larger payloads can be revisited once the firmware
 * properly exposes MTU exchange (probably needs SDK_CONFIG change in
 * v3-bootloader's nrf_dfu_ble.c — Nordic SDK 17's BLE manager
 * normally responds to MTU exchange but maybe the Calliope build
 * has it disabled or the GATT MTU is hardcoded).
 *
 * The fallback ladder is kept so we still have a defensive step-down
 * if the single 20-byte step fails; in practice it's never hit.
 */
const PACKET_PAYLOAD_STEPS: readonly number[] = [20];
const PACKET_PAYLOAD_SAFE = PACKET_PAYLOAD_STEPS[PACKET_PAYLOAD_STEPS.length - 1];
const PACKET_PAYLOAD_MAX = PACKET_PAYLOAD_STEPS[0];

/**
 * Packets per PRN (Packet Receipt Notification). After every N packets we
 * write to the Packet characteristic, the bootloader sends a checksum
 * notification on the Control Point with the running offset+CRC.
 *
 * Stays under Nordic SDK 17's default `NRF_DFU_BLE_BUFFERS=8` — the
 * bootloader can hold at most 8 unprocessed inbound packets in RAM, and it
 * stops processing during page-erase right after `CreateObject(Data)`
 * (each erase is ~85 ms on nRF52833). If we send more than 8 packets
 * during that window the BLE RX buffer overflows and the extras get
 * dropped silently — the bootloader keeps writing the bytes it did
 * receive (so the on-device display shows progress), but our local CRC
 * drifts from the device's and the next PRN tells us the offset mismatched.
 *
 * 6 leaves headroom for the BLE link layer's own queueing.
 */
const PRN_INTERVAL = 6;

/** Timeout for every CalcChecksum / PRN ack — chunk size × write rate worst case. */
const CHECKSUM_TIMEOUT_MS = 15_000;

/** Timeout for Execute — page erase + write + verify on V2 takes hundreds of ms. */
const EXECUTE_TIMEOUT_MS = 30_000;

// ---- Errors ----------------------------------------------------------------

/**
 * Generic DFU failure. Caller (flash dispatcher) treats this as recoverable —
 * tries USB next.
 */
export class BluetoothDfuFailedError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'BluetoothDfuFailedError';
  }
}

/**
 * The device doesn't expose the buttonless DFU characteristic. Most likely
 * the running hex was built with `MICROBIT_BLE_DFU_SERVICE=0` (rare for
 * Calliope) — full BLE flash is impossible and the caller should fall back
 * to USB. Distinct from BluetoothDfuFailedError so the dispatcher can show
 * a clearer message and not retry.
 */
export class BluetoothDfuServiceMissingError extends BluetoothDfuFailedError {
  constructor() {
    super('Calliope is not exposing the Nordic DFU service');
    this.name = 'BluetoothDfuServiceMissingError';
  }
}

// ---- Public entry point ----------------------------------------------------

export type BluetoothDfuPhase =
  | 'entering-bootloader'
  | 'awaiting-bootloader'
  | 'reconnecting'
  | 'sending-init'
  | 'flashing'
  | 'finalising';

export interface FlashOverNordicDfuOptions {
  /** The already-permitted Web Bluetooth device. Must currently be running the application. */
  device: BluetoothDevice;
  /** Raw .hex string (already stripped of MakeCode metadata). */
  hex: string;
  /** Board version — only V2 is supported; V1 Calliope mini doesn't ship. */
  boardVersion: 'V2';
  /**
   * Called only during the firmware-streaming phase (after the bootloader has
   * been entered, reconnected to, and accepted the init packet). Argument is
   * 0..1, mapped to *firmware bytes transferred*. Setup phases (entering the
   * bootloader, reconnecting, init packet) do NOT call this — the caller is
   * expected to render an indeterminate spinner until streaming starts.
   */
  onProgress?: (progress: number) => void;
  onPhase?: (phase: BluetoothDfuPhase) => void;
  signal?: AbortSignal;
}

/**
 * Run a full Nordic Secure DFU flash over Web Bluetooth.
 *
 * On success, the Calliope reboots into the freshly-flashed application and
 * the existing GATT drops. Caller is expected to reconnect via the regular
 * application flow afterwards (the BLE auto-reconnect in flash.ts handles
 * this).
 *
 * @throws `BluetoothDfuServiceMissingError` if the device isn't exposing the
 *         Nordic DFU service at all.
 * @throws `BluetoothDfuFailedError` for any protocol-level failure.
 */
export async function flashOverNordicDfuWeb(opts: FlashOverNordicDfuOptions): Promise<void> {
  const startedAt = Date.now();
  const trace = (m: string) => {
    const elapsed = Date.now() - startedAt;
    const line = `+${(elapsed / 1000).toFixed(2)}s ${m}`;
    appendLog({ direction: 'info', text: `dfu-ble: ${line}` });
    // Also mirror to console — the widget's log panel isn't always
    // visible (e.g. inside an iframe-embedded blocks editor), but
    // DevTools is. Use console.info so it's visible at default level.
    // eslint-disable-next-line no-console
    console.info(`%c[dfu-ble]%c ${line}`, 'color: #06b6d4; font-weight: bold;', 'color: inherit;');
  };
  const phase = (p: BluetoothDfuPhase) => {
    trace(`phase=${p}`);
    opts.onPhase?.(p);
  };

  if (opts.boardVersion !== 'V2') {
    throw new BluetoothDfuFailedError('Full BLE flash is only supported on Calliope mini 3 (V2).');
  }

  const appBin = extractAppBin(opts.hex);
  trace(`app bin extracted: ${appBin.length} bytes`);

  // Detect: is the device already advertising as DfuTarg? Happens when a
  // previous BLE-DFU was interrupted mid-transfer — the bootloader stays
  // in its DFU-in-progress state (showing "+" on the LED matrix from the
  // progress histogram) and keeps advertising the Nordic DFU service.
  // In that case we skip the buttonless-enter dance entirely — there's
  // no app running to host the buttonless characteristic, and trying to
  // write 0x01 to it throws and drops the link. A fresh
  // Select/Create on the existing bootloader connection resets the
  // in-progress object's offset/CRC, so we can resume from a clean
  // state without an Abort (the v2-bootloader disconnects on Abort).
  const alreadyInBootloader = /DfuTarg/i.test(opts.device.name ?? '');
  let dfuServer: BluetoothRemoteGATTServer;
  if (alreadyInBootloader) {
    trace('device is already DfuTarg — skipping buttonless enter, reusing the existing bootloader connection');
    phase('reconnecting');
    // The device might still be advertising or we might still have a live
    // GATT — either way, ensure we have a server handle. If the link
    // dropped between the classifier verdict and our flash call, the
    // reconnect helper handles it with the same retry/backoff used post-
    // enter-bootloader.
    if (opts.device.gatt && opts.device.gatt.connected) {
      dfuServer = opts.device.gatt;
    } else {
      dfuServer = await reconnectToBootloader(opts.device, trace, opts.signal);
    }
  } else {
    // Phase 1 — buttonless DFU enter. Causes the device to reboot into the
    // bootloader and disconnect.
    phase('entering-bootloader');
    await enterBootloader(opts.device, trace, opts.signal);

    // Phase 2 — wait for the bootloader to actually be ready, then reconnect
    // to the same BluetoothDevice (the bootloader keeps the application's
    // BD_ADDR by inheriting the SoftDevice peer data).
    //
    // Wait time matters: Nordic SDK 17's bootloader needs ~1.5–3 s after
    // reboot to finish SoftDevice init → bootloader init → advertising
    // start. Chrome's `gatt.connect()` will happily complete against a
    // device that has the LL-layer up but isn't a full GATT peer yet —
    // the bootloader then drops the connection a few hundred ms later
    // once it's actually ready, mid-service-discovery on our end. Two
    // seconds is the minimum that reliably catches the bootloader after
    // it has registered its DFU service.
    phase('awaiting-bootloader');
    await delay(2000);
    phase('reconnecting');
    dfuServer = await reconnectToBootloader(opts.device, trace, opts.signal);
  }

  // No settle here. `gatt.connect()` resolves the moment Chrome has an
  // ATT session, and Nordic SDK 17's secure-DFU bootloader runs an
  // "idle disconnect" timer that fires within a couple of seconds if no
  // GATT activity follows the new connection. Going idle right here is
  // what was dropping us mid-bootloader before this code change. Instead
  // we go straight to active GATT work — service discovery, characteristic
  // lookup, and notification enable — all of which keep the link alive
  // and also happen to be exactly what the bootloader expects next.
  const ctx = await openSecureDfuChannel(dfuServer, trace);

  // Watch for mid-DFU disconnect from this point on. If the bootloader's
  // GATT drops while we think we're streaming, every subsequent write
  // would silently queue or throw a generic GATT error — surface the
  // disconnect immediately so the dispatcher can fall back.
  const onDisconnect = () => {
    ctx.disconnected = true;
    trace('!!! GATT disconnected during DFU — bootloader may have aborted (inactivity, link loss, or rejection)');
    // Unblock any in-flight awaitResponse so we error out fast instead
    // of sitting on a 15–30 s timeout after the link is already gone.
    ctx.rejectPending?.(new BluetoothDfuFailedError('GATT disconnected mid-DFU'));
  };
  opts.device.addEventListener('gattserverdisconnected', onDisconnect);

  // Note: no Abort here. The standard Nordic SDK 17 secure-DFU bootloader
  // supports `NRF_DFU_OP_ABORT (0x0C)` and it just resets the in-progress
  // object — but the v2-bootloader Calliope ships disconnects the GATT
  // link when it receives 0x0C (observed at +0.07 s post-write on a
  // fresh reconnect; see commit history for traces). `CreateObject`
  // already resets the per-type offset/CRC counter on its own, so the
  // only thing Abort would have given us — clearing stale state from
  // a previously-interrupted DFU — happens implicitly when we start
  // sending the new init packet anyway.

  // Query the bootloader's view of the negotiated ATT MTU so we can
  // size every write to fill it. The legacy MTU of 23 caps us at
  // 20-byte payloads — fine for correctness, but ~1.8 KB/s in practice,
  // i.e. ~100 s for a 180 KB firmware. With MTU 247 (Chrome's normal
  // negotiated value on modern desktops/phones) we can write 244 bytes
  // per BLE transaction instead, cutting the wire-time by ~10×.
  // MtuGet is informational only now — see PACKET_PAYLOAD_STEPS comment for
  // why we hardcode 20-byte writes on the bootloader Packet characteristic.
  // The bootloader's actual ATT MTU is 23 (max payload 20) regardless of
  // what the host's BLE stack reports.
  const mtu = await mtuGet(ctx);
  ctx.payloadSize = PACKET_PAYLOAD_MAX; // == 20
  if (mtu !== null) {
    trace(`bootloader reports MTU=${mtu}; using ${ctx.payloadSize}-byte writes anyway (see ble-dfu-web.ts PACKET_PAYLOAD_STEPS comment)`);
  } else {
    trace(`bootloader MTU_GET unsupported; using ${ctx.payloadSize}-byte writes (Nordic Secure DFU baseline)`);
  }

  try {
    // Phase 4 — init packet. Small enough (~56 bytes = 3 packets) that PRN
    // doesn't help; send it without PRN to keep the protocol exchange simple.
    phase('sending-init');
    const initPacket = await createInitPacketV2(appBin);
    trace(`init packet: ${initPacket.length} bytes`);
    await setPRN(ctx, 0, trace);
    await sendCommandObject(ctx, initPacket, trace, opts.signal);

    // Phase 5 — firmware data. This is where we set up PRN throttling so the
    // bootloader can keep up. `onProgress` only fires from here on, so the
    // 0..1 the caller sees is firmware-streaming progress.
    phase('flashing');
    await setPRN(ctx, PRN_INTERVAL, trace);
    await sendDataObjectStream(
      ctx,
      appBin,
      (sent, total) => opts.onProgress?.(sent / total),
      trace,
      opts.signal,
    );

    phase('finalising');
    trace('done — device will reboot into application');
  } finally {
    opts.device.removeEventListener('gattserverdisconnected', onDisconnect);
    try { ctx.dispose(); } catch { /* ignore */ }
  }
}

// ---- Buttonless DFU enter --------------------------------------------------

async function enterBootloader(
  device: BluetoothDevice,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!device.gatt) throw new BluetoothDfuFailedError('Device has no GATT');
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();

  let service: BluetoothRemoteGATTService;
  try {
    service = await withTimeout(
      server.getPrimaryService(NORDIC_DFU_SERVICE),
      5000,
      'getPrimaryService(nordic-dfu)',
    );
  } catch (e) {
    void e;
    throw new BluetoothDfuServiceMissingError();
  }

  // Try "with bonds" first — that's the variant Calliope ships. Fall through
  // to "without bonds" if a future build flips the macro.
  let buttonless: BluetoothRemoteGATTCharacteristic | null = null;
  for (const uuid of [BUTTONLESS_DFU_WITH_BONDS, BUTTONLESS_DFU_WITHOUT_BONDS]) {
    try {
      buttonless = await withTimeout(
        service.getCharacteristic(uuid),
        3000,
        `getCharacteristic(${uuid})`,
      );
      trace(`using buttonless characteristic ${uuid}`);
      break;
    } catch { /* try next */ }
  }
  if (!buttonless) {
    throw new BluetoothDfuServiceMissingError();
  }

  // The buttonless characteristic uses **indications** (not notifications) on
  // Nordic SDK 17 builds. Either way, Chrome's `startNotifications()` handles
  // both — the characteristic descriptor determines the flavour.
  //
  // This is the most common failure point on open-mode firmware: Nordic SDK's
  // `ble_dfu_buttonless_init` registers the 8EC90004 CCCD with SEC_JUST_WORKS
  // (encryption required) regardless of `MICROBIT_BLE_OPEN` — the security
  // setting is baked in by the SDK config flag `NRF_DFU_BLE_REQUIRES_BONDS`,
  // not by CODAL's global mode. So `startNotifications()` will fail here
  // with a security error when there is no OS bond. To make BLE-DFU work
  // without a bond you have to rebuild the firmware with
  // `NRF_DFU_BLE_REQUIRES_BONDS=0` (which also flips the buttonless
  // characteristic UUID to 8EC90003 — the widget already tries that as a
  // fallback in the getCharacteristic loop above).
  try {
    await withTimeout(buttonless.startNotifications(), 3000, 'buttonless startNotifications');
    trace('buttonless notifications enabled');
  } catch (e) {
    trace(`buttonless startNotifications failed: ${(e as Error).message} — likely SDK enforces encrypted CCCD even under MICROBIT_BLE_OPEN`);
    throw e;
  }

  // Subscribe to the buttonless response, then write 0x01 (Enter Bootloader).
  // We don't actually need the response to succeed — the device disconnects
  // immediately after acknowledging — but listening for it gives us a clean
  // "command accepted" signal in the log.
  const responsePromise = new Promise<void>((resolve) => {
    const handler = (ev: Event) => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (!v) return;
      const u8 = new Uint8Array(v.buffer.slice(0));
      trace(`buttonless response: ${hexFmt(u8)}`);
      buttonless!.removeEventListener('characteristicvaluechanged', handler);
      resolve();
    };
    buttonless!.addEventListener('characteristicvaluechanged', handler);
    setTimeout(() => {
      try { buttonless!.removeEventListener('characteristicvaluechanged', handler); } catch { /* ignore */ }
      resolve();
    }, 2500);
  });

  // The bootloader-entry opcode is 0x01. The device replies via indication
  // and disconnects shortly after.
  const waitForDisconnect = oneShotEvent(device, 'gattserverdisconnected', 12000);
  try {
    trace('writing 0x01 to buttonless characteristic (enter-bootloader)');
    try {
      await withTimeout(buttonless.writeValue(new Uint8Array([0x01])), 3000, 'enter-bootloader write');
      trace('enter-bootloader command written');
    } catch (e) {
      trace(`enter-bootloader write threw — device may have already disconnected (${(e as Error).message})`);
    }
    await responsePromise;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await waitForDisconnect.promise;
    trace('device disconnected — bootloader expected next');
  } finally {
    waitForDisconnect.cancel();
  }
}

// ---- Reconnect to bootloader ----------------------------------------------

async function reconnectToBootloader(
  device: BluetoothDevice,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<BluetoothRemoteGATTServer> {
  // The bootloader inherits the SoftDevice peer data so the BD_ADDR stays
  // the same — Web Bluetooth's `device.gatt.connect()` re-establishes a
  // GATT link transparently. The advertising name changes ("DfuTarg") but
  // we don't filter by name on reconnect.
  //
  // Tuned for slow boot: nRF52833 SDK 17 bootloader takes ~1.5–3 s to come
  // up after a reboot, plus advertising. First try after 800 ms; back off
  // generously on retries.
  const delays = [800, 1200, 1800, 2500, 3500, 5000, 7000];
  let lastError: unknown = null;
  for (let i = 0; i < delays.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const server = await withTimeout(
        device.gatt!.connect(),
        12000,
        `bootloader reconnect attempt ${i + 1}`,
      );
      // Stability check: Chrome's `gatt.connect()` resolves the moment the
      // LL link is up, but the bootloader sometimes drops us a few hundred
      // ms later if its GATT layer / bond restoration isn't actually
      // ready yet. Verify the connection survives a brief window and a
      // real GATT round-trip (getPrimaryService) before claiming success.
      // If it doesn't, treat the attempt as failed and back off.
      await delay(400);
      if (!device.gatt!.connected) {
        throw new BluetoothDfuFailedError('connection dropped right after connect');
      }
      try {
        await withTimeout(
          device.gatt!.getPrimaryService(NORDIC_DFU_SERVICE),
          3000,
          `post-connect probe attempt ${i + 1}`,
        );
      } catch (probeErr) {
        throw new BluetoothDfuFailedError(
          `post-connect probe failed: ${(probeErr as Error).message}`,
        );
      }
      trace(`reconnected to bootloader on attempt ${i + 1} (stable)`);
      return server;
    } catch (e) {
      lastError = e;
      trace(`reconnect attempt ${i + 1} failed: ${(e as Error).message}`);
      // Make sure we're fully disconnected before the next try — a
      // half-up GATT confuses Chrome's next connect.
      try { device.gatt!.disconnect(); } catch { /* ignore */ }
      await delay(delays[i]);
    }
  }
  throw new BluetoothDfuFailedError(
    `Could not reconnect to bootloader after ${delays.length} attempts: ${(lastError as Error)?.message ?? lastError}`,
  );
}

// ---- Secure DFU channel ----------------------------------------------------

interface SecureDfuContext {
  control: BluetoothRemoteGATTCharacteristic;
  packet: BluetoothRemoteGATTCharacteristic;
  /** Pending response promise — resolved by the next notification on control. */
  awaitResponse: (opcode: number, timeoutMs?: number) => Promise<Uint8Array>;
  dispose: () => void;
  /**
   * Per-packet payload size to use for writes to the Packet characteristic.
   * Set from `MTU_GET` after the channel opens — populated to MTU-3, clamped
   * to `[PACKET_PAYLOAD_SAFE, PACKET_PAYLOAD_MAX]`. Stays at the safe value
   * if the bootloader doesn't support MTU_GET or returns the legacy MTU.
   */
  payloadSize: number;
  /**
   * Set to true by the outer `gattserverdisconnected` handler when the
   * link drops mid-DFU. Hot-path code (packet writes, control writes,
   * stream loops) checks this and bails immediately with a clear error
   * instead of waiting for protocol timeouts to fire.
   */
  disconnected: boolean;
  /**
   * Immediately fail whatever response we're currently awaiting on the
   * control point. Called from the disconnect handler so the in-flight
   * awaitResponse rejects right away instead of waiting on its own
   * timeout. Null when nothing is pending.
   */
  rejectPending: ((e: unknown) => void) | null;
}

async function openSecureDfuChannel(
  server: BluetoothRemoteGATTServer,
  trace: (m: string) => void,
): Promise<SecureDfuContext> {
  const service = await withTimeout(
    server.getPrimaryService(NORDIC_DFU_SERVICE),
    5000,
    'getPrimaryService(bootloader)',
  );
  const control = await withTimeout(
    service.getCharacteristic(SECURE_DFU_CONTROL_POINT),
    3000,
    'getCharacteristic(control-point)',
  );
  const packet = await withTimeout(
    service.getCharacteristic(SECURE_DFU_PACKET),
    3000,
    'getCharacteristic(packet)',
  );
  await withTimeout(control.startNotifications(), 3000, 'control startNotifications');

  // Single-pending-response state machine. The secure DFU protocol is
  // strictly request/response on the control point — we never have two
  // commands in flight. PRN notifications also land here (same opcode as
  // CalcChecksum); the streaming code sets up an `awaitResponse` slot
  // *before* writing the Nth packet so the PRN finds a resolver waiting.
  type Resolver = { resolve: (v: Uint8Array) => void; reject: (e: unknown) => void; opcode: number };
  let pending: Resolver | null = null;
  const onNotify = (ev: Event) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const u8 = new Uint8Array(v.buffer.slice(0));
    if (u8[0] !== Op.Response) {
      trace(`unexpected control-point packet: ${hexFmt(u8)}`);
      return;
    }
    const requestedOp = u8[1];
    const resultCode = u8[2];
    const r = pending;
    if (!r) {
      trace(`response without pending request: ${hexFmt(u8)}`);
      return;
    }
    if (r.opcode !== requestedOp) {
      trace(`response opcode mismatch (want 0x${r.opcode.toString(16)}, got 0x${requestedOp.toString(16)})`);
      pending = null;
      r.reject(new BluetoothDfuFailedError(`Unexpected DFU response opcode 0x${requestedOp.toString(16)}`));
      return;
    }
    if (resultCode !== Res.Success) {
      pending = null;
      // Extended error (0x0b) is followed by one byte of detail —
      // `NRF_DFU_EXT_ERROR_*` from Nordic SDK 17. Pulling it out makes
      // the failure mode debuggable instead of a generic "result=0x0b".
      let detail = '';
      if (resultCode === 0x0b && u8.length > 3) {
        detail = ` ext=0x${u8[3].toString(16).padStart(2, '0')}`;
      }
      r.reject(new BluetoothDfuFailedError(
        `DFU op 0x${requestedOp.toString(16)} failed: result=0x${resultCode.toString(16).padStart(2, '0')}${detail}`,
      ));
      return;
    }
    pending = null;
    r.resolve(u8.subarray(3)); // payload = bytes after [Response, op, result]
  };
  control.addEventListener('characteristicvaluechanged', onNotify);

  const awaitResponse = (opcode: number, timeoutMs = 6000): Promise<Uint8Array> => {
    if (pending) {
      return Promise.reject(new BluetoothDfuFailedError('DFU control point busy'));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const r: Resolver = { resolve, reject, opcode };
      pending = r;
      const t = setTimeout(() => {
        if (pending === r) {
          pending = null;
          reject(new BluetoothDfuFailedError(`Timeout waiting for response to op 0x${opcode.toString(16)}`));
        }
      }, timeoutMs);
      const origResolve = r.resolve;
      const origReject = r.reject;
      r.resolve = (v) => { clearTimeout(t); origResolve(v); };
      r.reject = (e) => { clearTimeout(t); origReject(e); };
    });
  };

  const ctx: SecureDfuContext = {
    control,
    packet,
    awaitResponse,
    payloadSize: PACKET_PAYLOAD_SAFE,
    disconnected: false,
    // Reads through to whatever the in-flight `awaitResponse` registered.
    // The outer disconnect handler reaches in via this getter so it can
    // unblock the await without us threading a reject callback through
    // every protocol step.
    get rejectPending(): ((e: unknown) => void) | null {
      return pending ? pending.reject : null;
    },
    set rejectPending(_v) { /* read-only proxy */ },
    dispose: () => {
      try { control.removeEventListener('characteristicvaluechanged', onNotify); } catch { /* ignore */ }
      try { control.stopNotifications().catch(() => undefined); } catch { /* ignore */ }
    },
  };
  return ctx;
}

// ---- Command-object send (init packet) -----------------------------------

/**
 * Send the init packet. Small enough to fit in a single Create+stream+Execute
 * cycle — no PRN needed.
 */
async function sendCommandObject(
  ctx: SecureDfuContext,
  data: Uint8Array,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const sel = await selectObject(ctx, ObjType.Command);
  trace(`select(command): maxSize=${sel.maxSize}, offset=${sel.offset}, crc=0x${sel.crc.toString(16)}`);
  if (data.length > sel.maxSize && sel.maxSize > 0) {
    throw new BluetoothDfuFailedError(
      `Init packet (${data.length} B) larger than command object max size (${sel.maxSize} B)`,
    );
  }

  await createObject(ctx, ObjType.Command, data.length);

  // Stream without PRN — the init packet is too small to benefit. Always
  // use the safe payload size here regardless of the data-phase optimistic
  // probe: the init packet is 56 bytes, splitting it into 20-byte chunks
  // is essentially free, and if Chrome's MTU is below the optimistic size
  // we'd `InvalidLengthError` here and abort the whole DFU before the
  // data-phase retry could kick in.
  for (let i = 0; i < data.length; i += PACKET_PAYLOAD_SAFE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const slice = data.subarray(i, Math.min(i + PACKET_PAYLOAD_SAFE, data.length));
    await writeOnePacket(ctx, slice);
  }

  // For a command object, the bootloader's offset/CRC reset on CreateObject
  // so the values we compare against are local-only.
  const expectedCrc = (~crc32Update(0xffffffff, data)) >>> 0;
  const cs = await calcChecksum(ctx);
  if (cs.offset !== data.length) {
    throw new BluetoothDfuFailedError(`Init packet offset mismatch: device=${cs.offset}, local=${data.length}`);
  }
  if (cs.crc !== expectedCrc) {
    throw new BluetoothDfuFailedError(
      `Init packet CRC mismatch: device=0x${cs.crc.toString(16).padStart(8, '0')}, local=0x${expectedCrc.toString(16).padStart(8, '0')}`,
    );
  }
  await execute(ctx);
}

// ---- Data-object stream (firmware) ----------------------------------------

/**
 * Stream the firmware in chunks. For each chunk:
 *   - CreateObject(Data, chunkSize)
 *   - Stream the chunk's bytes to the Packet characteristic with PRN throttling
 *   - Final CalcChecksum to verify
 *   - Execute to commit the chunk to flash
 *
 * The bootloader's offset+CRC for data objects are CUMULATIVE across all
 * CreateObject calls — they track the total firmware bytes received in the
 * current DFU session. Our local `cumulativeCrc` matches.
 */
async function sendDataObjectStream(
  ctx: SecureDfuContext,
  data: Uint8Array,
  onProgress: (sent: number, total: number) => void,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const sel = await selectObject(ctx, ObjType.Data);
  trace(`select(data): maxSize=${sel.maxSize}, offset=${sel.offset}, crc=0x${sel.crc.toString(16)}`);
  const maxChunk = sel.maxSize > 0 ? sel.maxSize : 4096;

  let sent = 0;
  let cumulativeCrc = 0xffffffff;
  let chunkIndex = 0;
  // Track which step in `PACKET_PAYLOAD_STEPS` we're on. We only fall
  // back during chunk 1 — if anything past that fails it's a real
  // protocol error, not an MTU mismatch.
  let payloadStepIdx = PACKET_PAYLOAD_STEPS.indexOf(ctx.payloadSize);
  if (payloadStepIdx < 0) payloadStepIdx = PACKET_PAYLOAD_STEPS.length - 1;
  const totalChunks = Math.ceil(data.length / maxChunk);
  while (sent < data.length) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunkSize = Math.min(maxChunk, data.length - sent);
    const chunk = data.subarray(sent, sent + chunkSize);
    chunkIndex++;
    trace(`chunk ${chunkIndex}/${totalChunks} (${chunkSize} B) at offset ${sent} payload=${ctx.payloadSize}`);

    const chunkStartedAt = Date.now();
    try {
      await createObject(ctx, ObjType.Data, chunkSize);
      // Settle after `CreateObject(Data)`. The page-erase is async and
      // acks before completing — ~200 ms gives the bootloader's DFU
      // state-machine reshuffle time to finish before we start streaming.
      // Nordic's iOS DFU library defaults to 400 ms here; this fork's
      // bootloader runs fine on 200 ms.
      await delay(200);
      const newCrc = await streamChunkWithPrn(ctx, chunk, cumulativeCrc, sent, signal);

      // Final CalcChecksum for the chunk. The bootloader reports the
      // cumulative offset+CRC — they should match `sent + chunkSize` and
      // our running CRC.
      const cs = await calcChecksum(ctx);
      const expectedCrc = (~newCrc) >>> 0;
      if (cs.offset !== sent + chunkSize) {
        throw new BluetoothDfuFailedError(
          `Data offset mismatch at chunk boundary: device=${cs.offset}, local=${sent + chunkSize}`,
        );
      }
      if (cs.crc !== expectedCrc) {
        throw new BluetoothDfuFailedError(
          `Data CRC mismatch at offset ${sent + chunkSize}: device=0x${cs.crc.toString(16).padStart(8, '0')}, local=0x${expectedCrc.toString(16).padStart(8, '0')}`,
        );
      }

      await execute(ctx);

      // Chunk committed — only NOW do we advance the cumulative trackers.
      // Doing this earlier would corrupt our state on a failed-then-retried
      // chunk, since the bootloader resets per-chunk state on each new
      // `CreateObject(Data)`.
      cumulativeCrc = newCrc;
      sent += chunkSize;
      const elapsed = Date.now() - chunkStartedAt;
      const pct = ((sent / data.length) * 100).toFixed(1);
      trace(`chunk ${chunkIndex}/${totalChunks} done in ${elapsed}ms — ${sent}/${data.length} B (${pct}%)`);
      onProgress(sent, data.length);
    } catch (err) {
      // First-chunk-only retry: step down through `PACKET_PAYLOAD_STEPS`.
      // Most likely cause when we started at a large payload is that
      // Chrome's negotiated ATT MTU is smaller than our optimistic
      // value — either Chrome threw `InvalidLengthError`, or it
      // fragmented silently and our PRN offset diverged. Drop one step
      // and retry chunk 1 from scratch (CreateObject resets the
      // bootloader's per-chunk state, and `sent`/`cumulativeCrc` only
      // advance on success). Failure past chunk 1, or after all steps
      // exhausted, is a real protocol error and gets thrown.
      if (chunkIndex === 1 && payloadStepIdx + 1 < PACKET_PAYLOAD_STEPS.length) {
        // The step-down only helps if the GATT link survived the failed
        // attempt. Some oversized writes (PACKET_PAYLOAD_STEPS[0] above the
        // negotiated ATT MTU) cause the bootloader to drop the link as a
        // side effect — every subsequent step then fails with "GATT
        // disconnected mid-DFU" and we bury the real cause under noise.
        // Bail early instead and let the dispatcher surface a clean
        // failure to the user.
        if (ctx.disconnected) {
          trace(`chunk 1 disconnected the GATT (payload=${ctx.payloadSize}); skipping step-down — link is gone`);
          throw err;
        }
        const oldPayload = ctx.payloadSize;
        payloadStepIdx++;
        ctx.payloadSize = PACKET_PAYLOAD_STEPS[payloadStepIdx];
        trace(`chunk 1 failed with payload=${oldPayload} (${(err as Error).message}) — falling back to ${ctx.payloadSize}-byte writes`);
        chunkIndex--;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Stream one chunk's bytes with Packet Receipt Notification throttling.
 *
 * Within each PRN window (PRN_INTERVAL packets) we fire all writes in a
 * tight loop **without per-packet await**, then `Promise.all` to wait for
 * Chrome's Web Bluetooth stack to accept the batch, then await the device's
 * PRN ack on the Control Point. This mirrors iOS's DFU pipelining
 * (`canSendWriteWithoutResponse` + per-packet pipelined writes) — Web
 * Bluetooth has no equivalent backpressure signal, so we use the PRN ack
 * as the only synchronisation point.
 *
 * Why bursts of exactly PRN_INTERVAL = 6:
 *   - Nordic SDK 17's `NRF_DFU_BLE_BUFFERS=8` caps how many unprocessed
 *     packets the bootloader can hold. 6 leaves headroom for the link
 *     layer's own queueing — see the PRN_INTERVAL comment.
 *   - The PRN ack is also our flow-control signal; we can't safely issue
 *     more packets in flight than the PRN window allows without risking
 *     RX buffer overflow.
 *
 * `cumulativeCrcInBefore` is the CRC32 state (pre-XOR) at the start of
 * this chunk. We update and return it so the caller can chain across
 * chunks.
 *
 * `cumulativeBytesBefore` is the byte count the bootloader's offset will
 * report once this chunk is finished. Used to verify PRN responses
 * mid-chunk.
 */
async function streamChunkWithPrn(
  ctx: SecureDfuContext,
  chunk: Uint8Array,
  cumulativeCrcInBefore: number,
  cumulativeBytesBefore: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  let writtenInChunk = 0;
  let crc = cumulativeCrcInBefore;
  while (writtenInChunk < chunk.length) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // How many packets fit in this PRN window, capped by chunk remainder.
    const remaining = chunk.length - writtenInChunk;
    const packetsRemaining = Math.ceil(remaining / ctx.payloadSize);
    const burstSize =
      PRN_INTERVAL > 0 ? Math.min(PRN_INTERVAL, packetsRemaining) : packetsRemaining;

    // Set up the PRN resolver BEFORE firing any writes. The bootloader
    // emits a PRN automatically after the Nth packet it receives — if
    // this burst contains that Nth packet, the notification must find a
    // resolver in place or it gets dropped silently.
    const isPrnBurst = PRN_INTERVAL > 0 && burstSize === PRN_INTERVAL;
    let prnPending: Promise<Uint8Array> | null = null;
    if (isPrnBurst) {
      prnPending = ctx.awaitResponse(Op.CalcChecksum, CHECKSUM_TIMEOUT_MS);
    }

    // Fan out the writes synchronously (no await between them) so Chrome
    // can pipeline them into the OS BLE TX queue back-to-back. This is
    // the actual perf win — `writeValueWithoutResponse` resolves when the
    // local stack has accepted the write, but issuing the next call only
    // after the previous resolution serialises us to one packet per
    // resolution turn-around. Issuing all 6 calls first lets the stack
    // batch them into a single connection interval where possible.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < burstSize; i++) {
      const sliceEnd = Math.min(writtenInChunk + ctx.payloadSize, chunk.length);
      const slice = chunk.subarray(writtenInChunk, sliceEnd);
      writes.push(writeOnePacket(ctx, slice));
      crc = crc32Update(crc, slice);
      writtenInChunk += slice.length;
    }
    await Promise.all(writes);

    if (prnPending) {
      const payload = await prnPending;
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const deviceOffset = dv.getUint32(0, true);
      const deviceCrc = dv.getUint32(4, true);
      const expectedOffset = cumulativeBytesBefore + writtenInChunk;
      const expectedCrc = (~crc) >>> 0;
      if (deviceOffset !== expectedOffset) {
        throw new BluetoothDfuFailedError(
          `PRN offset mismatch: device=${deviceOffset}, expected=${expectedOffset}`,
        );
      }
      if (deviceCrc !== expectedCrc) {
        throw new BluetoothDfuFailedError(
          `PRN CRC mismatch at offset ${expectedOffset}: device=0x${deviceCrc.toString(16).padStart(8, '0')}, local=0x${expectedCrc.toString(16).padStart(8, '0')}`,
        );
      }
    }
  }
  return crc;
}

// ---- Wire helpers ---------------------------------------------------------

async function selectObject(
  ctx: SecureDfuContext,
  type: number,
): Promise<{ maxSize: number; offset: number; crc: number }> {
  // Set up the response resolver BEFORE the write. The bootloader is
  // sometimes fast enough that its notification arrives between when
  // `writeControl` returns and when `awaitResponse` would set up
  // `pending` — the onNotify handler then drops the response as
  // "without pending request" and our await hangs until timeout.
  const responseP = ctx.awaitResponse(Op.SelectObject);
  await writeControl(ctx, new Uint8Array([Op.SelectObject, type]));
  const payload = await responseP;
  if (payload.length < 12) {
    throw new BluetoothDfuFailedError(`Short SelectObject response: ${hexFmt(payload)}`);
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    maxSize: dv.getUint32(0, true),
    offset: dv.getUint32(4, true),
    crc: dv.getUint32(8, true),
  };
}

async function setPRN(ctx: SecureDfuContext, prn: number, trace: (m: string) => void): Promise<void> {
  const buf = new Uint8Array(3);
  buf[0] = Op.SetPRN;
  buf[1] = prn & 0xff;
  buf[2] = (prn >> 8) & 0xff;
  const responseP = ctx.awaitResponse(Op.SetPRN);
  await writeControl(ctx, buf);
  await responseP;
  trace(`PRN set to ${prn}`);
}

async function createObject(ctx: SecureDfuContext, type: number, size: number): Promise<void> {
  const buf = new Uint8Array(6);
  buf[0] = Op.CreateObject;
  buf[1] = type;
  buf[2] = size & 0xff;
  buf[3] = (size >> 8) & 0xff;
  buf[4] = (size >> 16) & 0xff;
  buf[5] = (size >> 24) & 0xff;
  // CreateObject can take a moment on the data type — the bootloader
  // erases the target flash pages here — but it can also reply
  // remarkably quickly on short commands, so set up the resolver
  // before the write to avoid the race.
  const responseP = ctx.awaitResponse(Op.CreateObject, EXECUTE_TIMEOUT_MS);
  await writeControl(ctx, buf);
  await responseP;
}

async function calcChecksum(ctx: SecureDfuContext): Promise<{ offset: number; crc: number }> {
  const responseP = ctx.awaitResponse(Op.CalcChecksum, CHECKSUM_TIMEOUT_MS);
  await writeControl(ctx, new Uint8Array([Op.CalcChecksum]));
  const payload = await responseP;
  if (payload.length < 8) {
    throw new BluetoothDfuFailedError(`Short CalcChecksum response: ${hexFmt(payload)}`);
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    offset: dv.getUint32(0, true),
    crc: dv.getUint32(4, true),
  };
}

async function execute(ctx: SecureDfuContext): Promise<void> {
  const responseP = ctx.awaitResponse(Op.Execute, EXECUTE_TIMEOUT_MS);
  await writeControl(ctx, new Uint8Array([Op.Execute]));
  await responseP;
}

/**
 * Ask the bootloader for the actually-negotiated ATT MTU. Returns `null` if
 * the bootloader doesn't support `MTU_GET` (older microbit/Calliope
 * bootloaders may reject the opcode) or times out — callers should fall
 * back to the safe payload size in that case.
 *
 * Response payload format (after `[Response, MtuGet, Success]`): 2 bytes
 * MTU as little-endian uint16.
 */
async function mtuGet(ctx: SecureDfuContext): Promise<number | null> {
  try {
    const responseP = ctx.awaitResponse(Op.MtuGet, 3000);
    await writeControl(ctx, new Uint8Array([Op.MtuGet]));
    const payload = await responseP;
    if (payload.length < 2) return null;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return dv.getUint16(0, true);
  } catch {
    return null;
  }
}

async function writeOnePacket(ctx: SecureDfuContext, slice: Uint8Array): Promise<void> {
  if (ctx.disconnected) throw new BluetoothDfuFailedError('GATT disconnected mid-DFU');
  const ch = ctx.packet as BluetoothRemoteGATTCharacteristic & {
    writeValueWithoutResponse?: (b: BufferSource) => Promise<void>;
  };
  const buf = slice as unknown as BufferSource;
  if (ch.writeValueWithoutResponse) {
    await ch.writeValueWithoutResponse(buf);
  } else {
    await ctx.packet.writeValue(buf);
  }
}

async function writeControl(ctx: SecureDfuContext, payload: Uint8Array): Promise<void> {
  if (ctx.disconnected) throw new BluetoothDfuFailedError('GATT disconnected mid-DFU');
  // Control point is write-with-response (acknowledged).
  await ctx.control.writeValue(payload as unknown as BufferSource);
}

// ---- Hex / app-bin extraction ---------------------------------------------

/**
 * Extract the application binary from a MakeCode-format hex file.
 *
 * Mirrors `createAppBin` in upstream `flashing-full.js`: take the V2 app
 * region [0x1C000, 0x77000), zero-pad up to the highest address actually
 * populated by the hex, and align the total length to 4 bytes (DFU
 * requirement).
 */
function extractAppBin(hex: string): Uint8Array {
  const map = MemoryMap.fromHex(hex);
  const V2 = { start: 0x1c000, end: 0x77000 };
  let maxAddress = V2.start;
  for (const [blockAddr, block] of map) {
    const blockEnd = blockAddr + block.length;
    if (blockEnd > V2.start && blockAddr < V2.end) {
      maxAddress = Math.max(maxAddress, Math.min(blockEnd, V2.end));
    }
  }
  let size = maxAddress - V2.start;
  if (size <= 0) {
    throw new BluetoothDfuFailedError('Hex does not contain any data in the V2 app region');
  }
  // DFU requires 4-byte alignment for the app blob.
  size = Math.ceil(size / 4) * 4;
  return map.slicePad(V2.start, size);
}

// ---- Init packet (microbit-specific) --------------------------------------

/**
 * Build the V2 bootloader's `microbit_dfu_app_t` init packet. Byte-for-byte
 * identical to the upstream `createInitPacketV2` in `nordic-dfu.js`. The
 * bootloader's `fw_hash_ok` checks `magic[12]`, then `app_size`, then
 * `hash_bytes[32]` (reversed) against SHA-256 of the firmware blob.
 *
 * The bootloader skips the hash check entirely when `hash_size == 0`, which
 * we use as a fallback when `crypto.subtle` is unavailable (e.g. an
 * insecure-context dev server). That fallback shouldn't fire in production —
 * Web Bluetooth itself requires a secure context, so `crypto.subtle` will
 * always be present at the same time.
 */
async function createInitPacketV2(appBin: Uint8Array): Promise<Uint8Array> {
  const magic = 'microbit_app';
  const version = 1;
  const appSize = appBin.length;
  let hash: Uint8Array;
  let hashSize: number;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // Copy to a freshly-allocated ArrayBuffer so SubtleCrypto.digest accepts
    // it. TS 5.x's BufferSource is narrowed to exclude SharedArrayBuffer;
    // our buffer here is always a plain ArrayBuffer, but the type system
    // doesn't know that statically.
    const copy = new Uint8Array(appBin.byteLength);
    copy.set(appBin);
    hash = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
    hash.reverse();
    hashSize = 32;
  } else {
    hash = new Uint8Array(32);
    hashSize = 0;
  }
  const buf = new ArrayBuffer(12 + 4 + 4 + 4 + 32);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const enc = new TextEncoder();
  u8.set(enc.encode(magic), 0);
  view.setUint32(12, version, true);
  view.setUint32(16, appSize, true);
  view.setUint32(20, hashSize, true);
  u8.set(hash, 24);
  return u8;
}

// ---- Misc utilities --------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BluetoothDfuFailedError(`timeout: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function oneShotEvent(
  target: EventTarget,
  type: string,
  timeoutMs: number,
): { promise: Promise<void>; cancel: () => void } {
  let handler: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    handler = () => {
      target.removeEventListener(type, handler);
      if (timer) clearTimeout(timer);
      resolve();
    };
    target.addEventListener(type, handler, { once: true });
    timer = setTimeout(() => {
      target.removeEventListener(type, handler);
      reject(new BluetoothDfuFailedError(`timeout waiting for ${type}`));
    }, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      target.removeEventListener(type, handler);
      if (timer) clearTimeout(timer);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hexFmt(a: Uint8Array): string {
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- CRC32 (zlib/IEEE, init 0xFFFFFFFF, xor-out 0xFFFFFFFF) ---------------

// Precomputed table for the standard IEEE 802.3 / zlib CRC32 polynomial
// (0xEDB88320, reflected). Nordic's bootloader uses the same parameters.
const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * Incremental CRC32 — chain across multiple buffers without re-allocating.
 * Caller starts with `crc = 0xFFFFFFFF` and xor-inverts (`~crc >>> 0`) at the
 * end to get the final value comparable to what the bootloader reports.
 */
function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}
