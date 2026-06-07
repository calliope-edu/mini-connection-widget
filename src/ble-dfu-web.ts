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
 * Per-packet payload sizes we'll try, largest first.
 *
 * 244 == NRF_SDH_BLE_GATT_MAX_MTU_SIZE(247) − 3 (ATT header). On the
 * v3-bootloader rebuild deployed 2026-05-21 the bootloader's sdk_config
 * is set to MTU=247 and the on_write handler accepts the full 244-byte
 * payload — verified by the rebuild target (sdk_config.h + nrf_dfu_ble.c
 * exchange handler both present and wired). Each ladder step is a
 * multiple of 4 (Nordic write-alignment requirement on the data path).
 *
 * The older Calliope mini bootloader (prior to 2026-05-21) silently
 * dropped writes >20 bytes — see commit history. The adaptive ladder
 * exists so the widget still works against that bootloader: chunk 1
 * fails with a PRN/CRC mismatch (the >20-byte writes never landed), and
 * sendDataObjectStream steps down to the next entry on the next
 * CreateObject. So devices that haven't been re-flashed with the new
 * bootloader still complete DFU, just slowly.
 *
 * 244 → 64 → 20. The 64 step is a defensive intermediate in case the
 * negotiated MTU lands between 23 and 247 (some Android stacks cap at
 * 67 = 64+3); we'd rather know that than skip to 20 immediately.
 */
const PACKET_PAYLOAD_STEPS: readonly number[] = [244, 64, 20];
const PACKET_PAYLOAD_SAFE = PACKET_PAYLOAD_STEPS[PACKET_PAYLOAD_STEPS.length - 1];
const PACKET_PAYLOAD_MAX = PACKET_PAYLOAD_STEPS[0];

/**
 * Packets per PRN (Packet Receipt Notification). After every N packets we
 * write to the Packet characteristic, the bootloader sends a checksum
 * notification on the Control Point with the running offset+CRC.
 *
 * Has to stay under the bootloader's `NRF_DFU_BLE_BUFFERS` because that's
 * how many unprocessed inbound packets the bootloader can buffer while
 * page-erase runs (~85 ms on nRF52833, kicked off by `CreateObject(Data)`).
 * Send more than that during the erase window and the BLE RX queue
 * overflows, packets are dropped silently — the device's display keeps
 * showing progress (it wrote the bytes it did get), but our local CRC
 * drifts from the device's and the next PRN tells us the offset mismatched.
 *
 * The v3-bootloader build deployed 2026-05-21 derives MAX_DFU_BUFFERS from
 * `((CODE_PAGE_SIZE / MAX_DFU_PKT_LEN) + 1) == (4096 / 244) + 1 == 17` at
 * compile time, so 6 leaves plenty of headroom. Older bootloaders shipped
 * with the SDK default 8 → a value of 6 stays *under* that buffer too, so
 * the RX queue can't overflow on either bootloader. (The previous default
 * of 12 exceeded the old bootloader's 8-deep buffer and relied on the
 * adaptive step-down to recover — but that recovery only fired on chunk 1,
 * so an overflow on chunk 2+ failed the whole DFU. 6 removes the gamble.)
 *
 * This is the *initial* PRN interval; the adaptive step-down in
 * sendDataObjectStream can lower it further (alongside the write payload)
 * if a PRN/offset/CRC mismatch still surfaces.
 */
const PRN_INTERVAL = 6;

/**
 * Floor the adaptive step-down won't drop PRN below — at PRN=1 the
 * bootloader acks every single packet, which is the most conservative
 * flow-control possible (and slowest). No point going lower.
 */
const PRN_INTERVAL_MIN = 1;

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

/**
 * Is this error an offset/CRC divergence between our local state and the
 * bootloader's? Those are the symptoms of an RX-buffer overflow (we sent
 * packets faster than the bootloader could drain them during page-erase),
 * which the data-stream loop recovers from by lowering the PRN interval.
 * Matched on the failure messages thrown by `streamChunkWithPrn` and
 * `sendDataObjectStream` ("PRN offset mismatch", "PRN CRC mismatch",
 * "Data offset mismatch…", "Data CRC mismatch…"). Distinct from a generic
 * GATT/protocol error, which we don't retry.
 */
function isDfuStateMismatch(err: unknown): boolean {
  return err instanceof BluetoothDfuFailedError && /mismatch/i.test(err.message);
}

// ---- Public entry point ----------------------------------------------------

export type BluetoothDfuPhase =
  | 'entering-bootloader'
  | 'awaiting-bootloader'
  | 'reconnecting'
  | 'sending-init'
  | 'flashing'
  | 'finalising';

/**
 * Which DFU role the device is currently in.
 *   - `'app'`        — running the application; exposes the buttonless
 *                      characteristic (8EC90004 / 8EC90003). Needs the
 *                      buttonless-enter dance before we can flash.
 *   - `'bootloader'` — already in the Nordic secure-DFU bootloader; exposes
 *                      the control + packet characteristics (8EC90001 /
 *                      8EC90002). Skip the enter dance, resume on the
 *                      existing connection.
 *   - `'auto'`       — probe the characteristics to decide (the default).
 */
export type BluetoothDfuSessionKind = 'app' | 'bootloader' | 'auto';

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
  /**
   * Whether the device is currently running the application or is already
   * sitting in the bootloader (e.g. a previous BLE-DFU was interrupted
   * mid-transfer, or the user entered DFU mode with A+B+Reset). Drives the
   * resume path.
   *
   * Defaults to `'auto'`, which probes the GATT characteristics:
   * `device.name` is NOT used — Web Bluetooth caches the name from the
   * pre-reboot advertisement and does not refresh it to "DfuTarg" after the
   * bootloader takes over, so a name check silently misclassifies a
   * just-rebooted device as still-in-app. Pass an explicit kind from the
   * caller (which knows how the device got here) to skip the probe.
   */
  sessionKind?: BluetoothDfuSessionKind;
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
    // appendLog mirrors info/error to the console in dev (see log.ts), so the
    // dfu-ble timing trace is visible in DevTools without a separate mirror.
    appendLog({ direction: 'info', text: `dfu-ble: ${line}` });
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

  // Detect: is the device already in the bootloader? Happens when a
  // previous BLE-DFU was interrupted mid-transfer (the bootloader stays in
  // its DFU-in-progress state, showing "+" on the LED matrix from the
  // progress histogram and keeping the Nordic DFU service advertised), or
  // when the user forced DFU mode with A+B+Reset.
  //
  // In that case we skip the buttonless-enter dance entirely — there's no
  // app running to host the buttonless characteristic, and trying to write
  // 0x01 to it throws and drops the link. A fresh Select/Create on the
  // existing bootloader connection resets the in-progress object's
  // offset/CRC, so we can resume from a clean state without an Abort (the
  // v2-bootloader disconnects on Abort).
  //
  // We do NOT classify by `device.name === 'DfuTarg'`: Web Bluetooth caches
  // the name from the device's pre-reboot advertisement and does not refresh
  // it after the bootloader takes over, so a name check silently
  // misclassifies a just-rebooted bootloader as still-in-app. Instead we
  // honour an explicit `sessionKind` from the caller (which knows how the
  // device got here) and otherwise probe the GATT characteristics directly:
  // the control char (8EC90001) exists only in the bootloader, the
  // buttonless char (8EC90004/3) only in the app.
  const alreadyInBootloader = await resolveSessionKind(opts.device, opts.sessionKind, trace);
  let dfuServer: BluetoothRemoteGATTServer;
  if (alreadyInBootloader) {
    trace('device is already in the bootloader — skipping buttonless enter, reusing the existing bootloader connection');
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
  // Pick the starting per-packet payload. We query the bootloader's MTU_GET
  // first; but on this Calliope bootloader build the MTU_GET *DFU opcode* is
  // compiled out (it's behind `#if !NRF_DFU_PROTOCOL_REDUCED`), so MTU_GET
  // returns null even though the bootloader's ATT layer DOES support MTU 247.
  // The catch: a 247-byte ATT MTU only takes effect if the *central* (Chrome)
  // initiated the MTU exchange — and on Windows it doesn't reliably do that
  // for the bootloader link. So when MTU_GET is unknown we can't tell whether
  // 244-byte writes will land or silently overflow the default-23 link and
  // make the SoftDevice drop the connection (observed 2026-06-06: chunk 1 at
  // payload=244 → GATT disconnected, unrecoverable because the link is gone).
  //
  // Strategy: still TRY the fast 244 path optimistically, but if a large
  // payload kills the link, RECONNECT to the bootloader and retry the whole
  // init+stream one ladder step smaller (244 → 64 → 20). The bootloader keeps
  // no app state between our attempts (CreateObject resets per-object CRC), so
  // a clean re-init from offset 0 is safe. This recovers the dropped-link case
  // that sendDataObjectStream's in-loop step-down cannot (it needs a live link
  // to step down on). When MTU_GET *is* available we trust it and skip the
  // ladder entirely.
  // The reconnect ladder. We start optimistically at 244 and, only if a large
  // write DROPS THE LINK, reconnect and retry the whole init+stream at a
  // smaller payload. We go 244 → 20 (NOT 244 → 64 → 20): a link drop means the
  // SoftDevice rejected an oversized write, i.e. the negotiated ATT MTU is the
  // tiny default 23 (HW-confirmed 2026-06-07 on Windows: mwwr reports 244 but
  // 24-byte writes already drop the link; MTU is binary 23-or-247 here, never
  // an intermediate). 64 would just drop too and waste a ~6 s reconnect, so we
  // skip straight to the safe 20. (A truncating stack that keeps the link
  // alive — some Android caps ~67 — is handled separately by the in-loop
  // chunk-1 step-down in sendDataObjectStream, which still walks 244→64→20.)
  // MTU is queried on the SAME channel we stream on (a throwaway probe channel
  // destabilised the bootloader GATT and killed the init packet with
  // "GATT Error Unknown"). When MTU_GET answers we trust it (single payload).
  const ladder = [PACKET_PAYLOAD_MAX, PACKET_PAYLOAD_SAFE]; // [244, 20]

  let lastErr: unknown;
  let mtuResolved = false;
  for (let li = 0; li < ladder.length; li++) {
    let payload = ladder[li];
    const isLastStep = li === ladder.length - 1;

    // (Re)connect for retries — the previous attempt dropped the link.
    if (li > 0) {
      phase('reconnecting');
      trace(`payload=${ladder[li - 1]} dropped the link — reconnecting to retry DFU at ${payload}-byte writes`);
      await delay(1500);
      dfuServer = await reconnectToBootloader(opts.device, trace, opts.signal);
    }

    const ctx = await openSecureDfuChannel(dfuServer, trace);

    // Watch for mid-DFU disconnect. Register BEFORE any control writes so a
    // drop during MTU_GET / init unblocks the in-flight awaitResponse.
    const onDisconnect = () => {
      ctx.disconnected = true;
      trace('!!! GATT disconnected during DFU — bootloader may have aborted (inactivity, link loss, or rejection)');
      ctx.rejectPending?.(new BluetoothDfuFailedError('GATT disconnected mid-DFU'));
    };
    opts.device.addEventListener('gattserverdisconnected', onDisconnect);

    try {
      // On the first channel, ask the bootloader for its MTU on this very
      // channel. If it answers, jump the ladder straight to the right payload
      // and disable further step-down (a known MTU never overflows).
      if (!mtuResolved) {
        mtuResolved = true;
        const mtu = await mtuGet(ctx).catch(() => null);
        if (mtu && mtu > 0) {
          payload = PACKET_PAYLOAD_STEPS.find((p) => p <= mtu - 3) ?? PACKET_PAYLOAD_SAFE;
          ladder.length = li + 1; // pin to this payload — no reconnect ladder
          trace(`bootloader reports MTU=${mtu}; using ${payload}-byte writes`);
        } else {
          trace(`bootloader MTU_GET unsupported; trying ${payload}-byte writes${isLastStep ? '' : ' (will reconnect+step down on link drop)'}`);
        }
      }
      ctx.payloadSize = payload;

      // Phase 4 — init packet. Small enough (~56 bytes = 3 packets) that PRN
      // doesn't help; send it without PRN to keep the protocol exchange simple.
      phase('sending-init');
      const initPacket = await createInitPacketV2(appBin);
      trace(`init packet: ${initPacket.length} bytes`);
      await setPRN(ctx, 0, trace);
      await sendCommandObject(ctx, initPacket, trace, opts.signal);

      // Phase 5 — firmware data.
      phase('flashing');
      ctx.prnInterval = PRN_INTERVAL;
      await setPRN(ctx, ctx.prnInterval, trace);
      await sendDataObjectStream(
        ctx,
        appBin,
        (sent, total) => opts.onProgress?.(sent / total),
        trace,
        opts.signal,
      );

      phase('finalising');
      trace('done — device will reboot into application');
      return;
    } catch (err) {
      lastErr = err;
      // A link-drop is recoverable by reconnecting and retrying smaller. Match
      // both our own clean "disconnected mid-DFU" and Chrome's generic GATT
      // errors ("GATT Error Unknown", "GATT operation failed/not permitted",
      // "Device disconnected") that surface when the SoftDevice drops the link
      // out from under an in-flight write.
      const msg = (err as Error)?.message ?? '';
      const linkDropped = ctx.disconnected
        || /GATT disconnected mid-DFU/i.test(msg)
        || /GATT (Error Unknown|operation|Server is disconnected)/i.test(msg)
        || /disconnected|connection/i.test(msg);
      if (linkDropped && !isLastStep) {
        trace(`DFU attempt at payload=${payload} failed (${msg}) — reconnecting to retry smaller`);
        continue;
      }
      throw err;
    } finally {
      opts.device.removeEventListener('gattserverdisconnected', onDisconnect);
      try { ctx.dispose(); } catch { /* ignore */ }
    }
  }
  // Ladder exhausted without success.
  throw lastErr ?? new BluetoothDfuFailedError('BLE-DFU failed at all payload sizes');
}

// ---- Session classification (app vs bootloader) ----------------------------

/**
 * Decide whether the device is already in the bootloader (`true`) or still
 * running the application (`false`).
 *
 * An explicit `sessionKind` from the caller wins — `ble.ts` knows whether it
 * just triggered a reboot or found the device already advertising the DFU
 * service. When it's `'auto'` (or absent) we probe the GATT characteristics
 * rather than trusting `device.name`, which Web Bluetooth never refreshes to
 * "DfuTarg" after the bootloader takes over:
 *
 *   - The secure-DFU control characteristic (8EC90001) exists ONLY in the
 *     bootloader — its presence is a definitive "in bootloader" signal.
 *   - The buttonless characteristic (8EC90004 / 8EC90003) exists ONLY in the
 *     application.
 *
 * If neither is reachable (no GATT, service missing, probe error) we fall
 * back to the application path: `enterBootloader` then surfaces a precise
 * `BluetoothDfuServiceMissingError` if the buttonless characteristic really
 * is absent, which is a cleaner failure than guessing "bootloader" and
 * blowing up later on a missing control point.
 */
async function resolveSessionKind(
  device: BluetoothDevice,
  sessionKind: BluetoothDfuSessionKind | undefined,
  trace: (m: string) => void,
): Promise<boolean> {
  if (sessionKind === 'bootloader') {
    trace('sessionKind=bootloader (from caller) — treating device as already in bootloader');
    return true;
  }
  if (sessionKind === 'app') {
    trace('sessionKind=app (from caller) — treating device as running the application');
    return false;
  }

  // sessionKind is 'auto' or undefined — probe the characteristics.
  if (!device.gatt) {
    trace('sessionKind=auto: device has no GATT to probe — assuming application');
    return false;
  }
  try {
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const service = await withTimeout(
      server.getPrimaryService(NORDIC_DFU_SERVICE),
      5000,
      'getPrimaryService(session-probe)',
    );
    // Control point present → bootloader. Probe it first: it's the
    // definitive bootloader-only characteristic.
    try {
      await withTimeout(
        service.getCharacteristic(SECURE_DFU_CONTROL_POINT),
        3000,
        'getCharacteristic(control-point session-probe)',
      );
      trace('sessionKind=auto: control point (8EC90001) present — device is in the bootloader');
      return true;
    } catch { /* not the bootloader — fall through to the app probe */ }

    // Buttonless present → application.
    for (const uuid of [BUTTONLESS_DFU_WITH_BONDS, BUTTONLESS_DFU_WITHOUT_BONDS]) {
      try {
        await withTimeout(
          service.getCharacteristic(uuid),
          3000,
          `getCharacteristic(${uuid} session-probe)`,
        );
        trace(`sessionKind=auto: buttonless characteristic (${uuid}) present — device is running the application`);
        return false;
      } catch { /* try next */ }
    }

    trace('sessionKind=auto: neither control point nor buttonless characteristic found — defaulting to application path');
    return false;
  } catch (e) {
    trace(`sessionKind=auto: probe failed (${(e as Error).message}) — defaulting to application path`);
    return false;
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
   * Packets per PRN currently in force for the data-streaming phase. Starts
   * at `PRN_INTERVAL` and can be lowered by the adaptive step-down in
   * `sendDataObjectStream` when a PRN/offset/CRC mismatch points at an RX
   * buffer overflow. `streamChunkWithPrn` reads this each packet so a
   * mid-stream change takes effect on the next PRN cycle.
   */
  prnInterval: number;
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
    prnInterval: PRN_INTERVAL,
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
  // Track which step in `PACKET_PAYLOAD_STEPS` we're on. The payload
  // step-down (MTU mismatch) is only meaningful on chunk 1 — if the
  // negotiated ATT MTU were too small we'd have failed the very first
  // chunk. The *PRN* step-down, by contrast, can fire on any chunk: an
  // RX-buffer overflow only shows up once page-erase timing lines up
  // unfavourably, which can be a later chunk. See the catch block.
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
      // Any step-down only helps if the GATT link survived the failed
      // attempt. Some oversized writes (PACKET_PAYLOAD_STEPS[0] above the
      // negotiated ATT MTU) cause the bootloader to drop the link as a
      // side effect — every subsequent step then fails with "GATT
      // disconnected mid-DFU" and we'd bury the real cause under noise.
      // Bail early in that case and let the dispatcher surface a clean
      // failure to the user.
      if (ctx.disconnected) {
        trace(`chunk ${chunkIndex} disconnected the GATT (payload=${ctx.payloadSize}); skipping step-down — link is gone`);
        throw err;
      }

      // First-chunk-only retry: step down through `PACKET_PAYLOAD_STEPS`.
      // Most likely cause when we started at a large payload is that
      // Chrome's negotiated ATT MTU is smaller than our optimistic
      // value — either Chrome threw `InvalidLengthError`, or it
      // fragmented silently and our PRN offset diverged. Drop one step
      // and retry chunk 1 from scratch (CreateObject resets the
      // bootloader's per-chunk state, and `sent`/`cumulativeCrc` only
      // advance on success). The MTU can only mismatch on the first
      // chunk, so this path stays chunk-1-only.
      if (chunkIndex === 1 && payloadStepIdx + 1 < PACKET_PAYLOAD_STEPS.length) {
        const oldPayload = ctx.payloadSize;
        payloadStepIdx++;
        ctx.payloadSize = PACKET_PAYLOAD_STEPS[payloadStepIdx];
        trace(`chunk 1 failed with payload=${oldPayload} (${(err as Error).message}) — falling back to ${ctx.payloadSize}-byte writes`);
        chunkIndex--;
        continue;
      }

      // Any-chunk PRN step-down: a PRN/offset/CRC mismatch points at an
      // RX-buffer overflow (we outran the bootloader's NRF_DFU_BLE_BUFFERS
      // during the page-erase window), which — unlike an MTU mismatch —
      // can surface on a later chunk when erase timing lines up badly.
      // Halve the PRN interval (more frequent acks → fewer in-flight
      // packets during erase) and retry the same chunk. CreateObject
      // resets the bootloader's per-chunk state, and `sent`/`cumulativeCrc`
      // only advance on success, so retrying is safe. Bounded by
      // PRN_INTERVAL_MIN: once PRN bottoms out (every packet acked) the
      // guard below is false and a persisting mismatch is thrown as a real
      // protocol error.
      if (isDfuStateMismatch(err) && ctx.prnInterval > PRN_INTERVAL_MIN) {
        const oldPrn = ctx.prnInterval;
        ctx.prnInterval = Math.max(PRN_INTERVAL_MIN, Math.floor(ctx.prnInterval / 2));
        trace(`chunk ${chunkIndex} mismatch with PRN=${oldPrn} (${(err as Error).message}) — lowering PRN to ${ctx.prnInterval} and retrying`);
        try {
          await setPRN(ctx, ctx.prnInterval, trace);
        } catch (prnErr) {
          trace(`could not re-set PRN after mismatch: ${(prnErr as Error).message}`);
          throw err;
        }
        chunkIndex--;
        continue;
      }

      throw err;
    }
  }
}

/**
 * Stream one chunk's bytes with Packet Receipt Notification throttling.
 * Every `ctx.prnInterval` packets, we expect a notification on the Control
 * Point with the running offset+CRC; we set up the awaitResponse *before*
 * writing the Nth packet so the notification finds a resolver waiting.
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
  let packetsSincePrn = 0;
  let crc = cumulativeCrcInBefore;
  while (writtenInChunk < chunk.length) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sliceEnd = Math.min(writtenInChunk + ctx.payloadSize, chunk.length);
    const slice = chunk.subarray(writtenInChunk, sliceEnd);

    // Decide BEFORE writing whether this packet will be the Nth (PRN
    // trigger). The bootloader emits a PRN notification automatically when
    // it has received N packets since the last PRN, regardless of where
    // we sit in the current chunk. We have to set up the awaitResponse
    // *before* the write so the PRN notification's onNotify handler finds
    // a resolver in place (notifications without a pending resolver get
    // dropped). A PRN at end-of-chunk is fine — we just consume it; the
    // outer loop's explicit CalcChecksum gets its own response.
    const prnInterval = ctx.prnInterval;
    const nextCount = packetsSincePrn + 1;
    const isPrnPacket = prnInterval > 0 && nextCount >= prnInterval;
    let prnPending: Promise<Uint8Array> | null = null;
    if (isPrnPacket) {
      prnPending = ctx.awaitResponse(Op.CalcChecksum, CHECKSUM_TIMEOUT_MS);
    }

    await writeOnePacket(ctx, slice);
    crc = crc32Update(crc, slice);
    writtenInChunk += slice.length;
    packetsSincePrn++;

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
      packetsSincePrn = 0;
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
