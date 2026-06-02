/**
 * Legacy Nordic DFU (SDK 8 / nRF51 S110) over Web Bluetooth — Calliope mini v1/v2.
 *
 * Counterpart to `ble-dfu-web.ts` (which does Nordic *Secure* DFU / SDK 17 over
 * Web Bluetooth for mini v3). The nRF51 mini v1/v2 bootloader speaks the older
 * *legacy* DFU protocol, which the upstream `@microbit/microbit-connection`
 * only implements via the **native** `@microbit/capacitor-community-nordic-dfu`
 * plugin (Android/iOS) — that path does not run in a browser. So for the campus
 * widget we implement the legacy protocol directly over the
 * `BluetoothRemoteGATTCharacteristic` API.
 *
 * IMPORTANT — DFU service UUID. The stock legacy Nordic DFU service
 * `00001530-1212-efde-1523-785feabcd123` is on the **Web Bluetooth GATT
 * blocklist**: Chrome refuses to filter for it, hides it from
 * `getPrimaryServices()`, and SecurityErrors on access. The Calliope
 * `v1.0-calliope-webdfu` bootloader therefore re-bases its DFU service to the
 * (non-blocklisted) micro:bit vendor base:
 *
 *   - service        e95d1530-251d-470a-a062-fa1922dfa9a8
 *   - control point  e95d1531-251d-470a-a062-fa1922dfa9a8  (write + notify)
 *   - packet         e95d1532-251d-470a-a062-fa1922dfa9a8  (write-without-response)
 *
 * Procedure (application update):
 *   1. Enter bootloader — write 0x01 to the running app's micro:bit DFU Control
 *      characteristic (e95d93b1). The device reboots into the bootloader,
 *      keeping the app's BD_ADDR, and disconnects.
 *   2. Reconnect to the same BluetoothDevice (gatt.connect) and open e95d1530.
 *   3. Legacy DFU exchange on the control point + packet characteristics:
 *        START_DFU(app) → image sizes → INIT params → init packet →
 *        RECEIVE_FIRMWARE → stream app bytes (PRN-throttled) →
 *        VALIDATE → ACTIVATE_AND_RESET.
 *
 * The 14-byte legacy init packet is byte-identical to the upstream
 * `createLegacyInitPacketV1` so the bootloader's validation accepts it.
 */

import MemoryMap from 'nrf-intel-hex';
import { appendLog } from './log';
import { BluetoothDfuFailedError, BluetoothDfuServiceMissingError } from './ble-dfu-web';

// ---- UUIDs -----------------------------------------------------------------

/** Running-app micro:bit DFU Control service + characteristic (reboot trigger). */
const APP_DFU_CONTROL_SERVICE = 'e95d93b0-251d-470a-a062-fa1922dfa9a8';
const APP_DFU_CONTROL_CHAR = 'e95d93b1-251d-470a-a062-fa1922dfa9a8';

/** Bootloader legacy DFU service (micro:bit base; NOT the blocklisted 00001530). */
const LEGACY_DFU_SERVICE = 'e95d1530-251d-470a-a062-fa1922dfa9a8';
const LEGACY_DFU_CONTROL = 'e95d1531-251d-470a-a062-fa1922dfa9a8';
const LEGACY_DFU_PACKET = 'e95d1532-251d-470a-a062-fa1922dfa9a8';

// ---- Protocol opcodes (Nordic SDK 8 legacy DFU control point) --------------

const Op = {
  StartDfu: 0x01,
  InitDfuParams: 0x02,
  ReceiveFirmwareImage: 0x03,
  ValidateFirmware: 0x04,
  ActivateImageAndReset: 0x05,
  PacketReceiptNotifReq: 0x08,
  Response: 0x10,
  PacketReceiptNotif: 0x11,
} as const;

/** START_DFU update mode — we only ever flash the application. */
const UPDATE_MODE_APPLICATION = 0x04;

/** INIT_DFU_PARAMS sub-commands. */
const INIT_RECEIVE = 0x00;
const INIT_COMPLETE = 0x01;

/** Response status code for success. */
const RESP_SUCCESS = 0x01;

// ---- Tuning ----------------------------------------------------------------

/** nRF51 S110 application region: SoftDevice ends 0x18000, bootloader at 0x3C000. */
const V1_APP = { start: 0x18000, end: 0x3c000 };

/** Packet characteristic write size. 20 bytes = the default ATT_MTU-3; the
 * nRF51 bootloader never negotiates a larger MTU, so this is the ceiling. */
const PACKET_SIZE = 20;

/** Packet Receipt Notification interval (packets). The bootloader sends a
 * checksum/bytes-received notification every N packets, which throttles us so
 * Chrome doesn't overrun the bootloader's small RX buffer. 8 mirrors the
 * upstream/Nordic default. */
const PRN_INTERVAL = 8;

// ---- Public entry point ----------------------------------------------------

export type LegacyDfuPhase =
  | 'entering-bootloader'
  | 'awaiting-bootloader'
  | 'reconnecting'
  | 'sending-init'
  | 'flashing'
  | 'finalising';

export interface FlashOverLegacyDfuOptions {
  /** Already-permitted device, currently running the application (exposes e95d93b0). */
  device: BluetoothDevice;
  /** Raw .hex string (already stripped of MakeCode metadata). */
  hex: string;
  /** 0..1 over firmware bytes streamed. Only called during the 'flashing' phase. */
  onProgress?: (progress: number) => void;
  onPhase?: (phase: LegacyDfuPhase) => void;
  signal?: AbortSignal;
}

/**
 * Run a legacy Nordic DFU application flash over Web Bluetooth (mini v1/v2).
 * On success the device reboots into the freshly-flashed application.
 *
 * @throws {BluetoothDfuServiceMissingError} if the bootloader's e95d1530 service
 *         isn't found after the reboot (e.g. the device still has a stock
 *         00001530 bootloader, which Web Bluetooth cannot reach).
 * @throws {BluetoothDfuFailedError} for any protocol-level failure.
 */
export async function flashOverLegacyDfuWeb(opts: FlashOverLegacyDfuOptions): Promise<void> {
  const startedAt = Date.now();
  const trace = (m: string) => {
    const line = `+${((Date.now() - startedAt) / 1000).toFixed(2)}s ${m}`;
    appendLog({ direction: 'info', text: `legacy-dfu: ${line}` });
    // eslint-disable-next-line no-console
    console.info(`%c[legacy-dfu]%c ${line}`, 'color: #d97706; font-weight: bold;', 'color: inherit;');
  };
  const phase = (p: LegacyDfuPhase) => { trace(`phase=${p}`); opts.onPhase?.(p); };
  const abortIfNeeded = () => {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  const appBin = extractAppBinV1(opts.hex);
  trace(`app bin extracted: ${appBin.length} bytes`);

  // If the device is already in the bootloader (a previous DFU was interrupted),
  // it advertises as "DfuTarg" and there's no app to host the reboot trigger.
  const alreadyInBootloader = /DfuTarg/i.test(opts.device.name ?? '');
  let server: BluetoothRemoteGATTServer;
  if (alreadyInBootloader) {
    trace('device is already DfuTarg — reusing the bootloader connection');
    phase('reconnecting');
    server = opts.device.gatt?.connected
      ? opts.device.gatt
      : await reconnectToBootloader(opts.device, trace, opts.signal);
  } else {
    phase('entering-bootloader');
    await enterBootloaderV1(opts.device, trace, opts.signal);
    phase('awaiting-bootloader');
    await delay(2000);
    phase('reconnecting');
    server = await reconnectToBootloader(opts.device, trace, opts.signal);
  }

  const ctx = await openLegacyDfuChannel(server, trace);
  const onDisconnect = () => {
    ctx.disconnected = true;
    trace('!!! GATT disconnected during DFU');
    ctx.rejectAllPending(new BluetoothDfuFailedError('GATT disconnected mid-DFU'));
  };
  opts.device.addEventListener('gattserverdisconnected', onDisconnect);

  try {
    // START_DFU(application) — then write the image-size record to the packet
    // characteristic: [sd_size=0, bl_size=0, app_size] as three uint32 LE.
    phase('sending-init');
    abortIfNeeded();
    const startResp = ctx.awaitResponse(Op.StartDfu);
    await writeControl(ctx, [Op.StartDfu, UPDATE_MODE_APPLICATION], trace);
    const sizes = new Uint8Array(12);
    new DataView(sizes.buffer).setUint32(8, appBin.length, true); // sd=0, bl=0, app=len
    await writePacket(ctx, sizes);
    await startResp;
    trace('START_DFU accepted');

    // INIT params: announce "receive init packet", write the 14-byte legacy
    // init packet to the packet characteristic, then "init complete".
    abortIfNeeded();
    await writeControl(ctx, [Op.InitDfuParams, INIT_RECEIVE], trace);
    await writePacket(ctx, createLegacyInitPacketV1(appBin));
    const initResp = ctx.awaitResponse(Op.InitDfuParams);
    await writeControl(ctx, [Op.InitDfuParams, INIT_COMPLETE], trace);
    await initResp;
    trace('init packet accepted');

    // Request packet-receipt notifications every PRN_INTERVAL packets.
    const prn = new Uint8Array(3);
    prn[0] = Op.PacketReceiptNotifReq;
    new DataView(prn.buffer).setUint16(1, PRN_INTERVAL, true);
    await writeControl(ctx, Array.from(prn), trace);

    // RECEIVE_FIRMWARE_IMAGE, then stream the app bytes.
    phase('flashing');
    abortIfNeeded();
    const firmwareResp = ctx.awaitResponse(Op.ReceiveFirmwareImage);
    await writeControl(ctx, [Op.ReceiveFirmwareImage], trace);
    await streamFirmware(ctx, appBin, (sent, total) => opts.onProgress?.(sent / total), trace, opts.signal);
    await firmwareResp;
    trace('firmware image received by bootloader');

    // VALIDATE then ACTIVATE_AND_RESET (the device reboots into the new app).
    phase('finalising');
    abortIfNeeded();
    const validateResp = ctx.awaitResponse(Op.ValidateFirmware);
    await writeControl(ctx, [Op.ValidateFirmware], trace);
    await validateResp;
    trace('firmware validated');
    // ACTIVATE_AND_RESET reboots the device immediately, so the
    // write-with-response ACK never returns and the GATT op rejects with a
    // disconnect error. That disconnect IS the success signal here, so swallow
    // the rejection rather than failing the whole DFU. (The bootloader has
    // already validated + banked the image at this point.)
    try {
      await writeControl(ctx, [Op.ActivateImageAndReset], trace);
    } catch (e) {
      trace(`activate write dropped (expected — device rebooted): ${(e as Error).message}`);
    }
    trace('activate + reset sent — device will reboot into the new application');
  } finally {
    opts.device.removeEventListener('gattserverdisconnected', onDisconnect);
    try { ctx.dispose(); } catch { /* ignore */ }
  }
}

// ---- Enter bootloader (V1) -------------------------------------------------

async function enterBootloaderV1(
  device: BluetoothDevice,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!device.gatt) throw new BluetoothDfuFailedError('Device has no GATT');
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const service = await withTimeout(
    server.getPrimaryService(APP_DFU_CONTROL_SERVICE), 5000, 'getPrimaryService(app dfu control)',
  );
  const control = await withTimeout(
    service.getCharacteristic(APP_DFU_CONTROL_CHAR), 3000, 'getCharacteristic(app dfu control)',
  );
  const waitForDisconnect = oneShotEvent(device, 'gattserverdisconnected', 12000);
  try {
    trace('writing 0x01 to e95d93b1 (enter bootloader)');
    try {
      await withTimeout(control.writeValue(new Uint8Array([0x01])), 3000, 'enter-bootloader write');
    } catch (e) {
      trace(`enter-bootloader write threw — device may have already disconnected (${(e as Error).message})`);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await waitForDisconnect.promise;
    trace('device disconnected — bootloader expected next');
  } finally {
    waitForDisconnect.cancel();
  }
}

// ---- Reconnect to bootloader -----------------------------------------------

async function reconnectToBootloader(
  device: BluetoothDevice,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<BluetoothRemoteGATTServer> {
  const delays = [800, 1200, 1800, 2500, 3500, 5000, 7000];
  let lastError: unknown = null;
  for (let i = 0; i < delays.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const server = await withTimeout(device.gatt!.connect(), 12000, `bootloader reconnect ${i + 1}`);
      await delay(400);
      if (!device.gatt!.connected) throw new BluetoothDfuFailedError('connection dropped right after connect');
      // Probe the DFU service to confirm the bootloader's GATT is actually up.
      try {
        await withTimeout(device.gatt!.getPrimaryService(LEGACY_DFU_SERVICE), 3000, `post-connect probe ${i + 1}`);
      } catch (probeErr) {
        throw new BluetoothDfuFailedError(`post-connect probe failed: ${(probeErr as Error).message}`);
      }
      trace(`reconnected to bootloader on attempt ${i + 1} (stable)`);
      return server;
    } catch (e) {
      lastError = e;
      trace(`reconnect attempt ${i + 1} failed: ${(e as Error).message}`);
      try { device.gatt!.disconnect(); } catch { /* ignore */ }
      await delay(delays[i]);
    }
  }
  throw new BluetoothDfuFailedError(
    `Could not reconnect to bootloader after ${delays.length} attempts: ${(lastError as Error)?.message ?? lastError}`,
  );
}

// ---- Legacy DFU channel ----------------------------------------------------

interface LegacyDfuContext {
  control: BluetoothRemoteGATTCharacteristic;
  packet: BluetoothRemoteGATTCharacteristic;
  /** Await the next control-point RESPONSE (0x10) for the given request opcode. */
  awaitResponse: (requestOpcode: number, timeoutMs?: number) => Promise<Uint8Array>;
  /** Await the next packet-receipt notification (0x11). */
  awaitPrn: (timeoutMs?: number) => Promise<number>;
  dispose: () => void;
  disconnected: boolean;
  rejectPending: ((e: unknown) => void) | null;
  /** Reject the in-flight response AND every queued PRN waiter (disconnect path). */
  rejectAllPending: (e: unknown) => void;
}

async function openLegacyDfuChannel(
  server: BluetoothRemoteGATTServer,
  trace: (m: string) => void,
): Promise<LegacyDfuContext> {
  let service: BluetoothRemoteGATTService;
  try {
    service = await withTimeout(server.getPrimaryService(LEGACY_DFU_SERVICE), 5000, 'getPrimaryService(legacy-dfu)');
  } catch {
    throw new BluetoothDfuServiceMissingError();
  }
  const control = await withTimeout(service.getCharacteristic(LEGACY_DFU_CONTROL), 3000, 'getCharacteristic(control)');
  const packet = await withTimeout(service.getCharacteristic(LEGACY_DFU_PACKET), 3000, 'getCharacteristic(packet)');

  // Notification dispatch: the control point carries both command responses
  // (0x10) and packet-receipt notifications (0x11). Queue them and let
  // awaitResponse/awaitPrn pick the next matching one.
  const responseWaiters: Array<{ opcode: number; resolve: (v: Uint8Array) => void; reject: (e: unknown) => void }> = [];
  const prnWaiters: Array<{ resolve: (n: number) => void; reject: (e: unknown) => void }> = [];

  const ctx: LegacyDfuContext = {
    control, packet, disconnected: false, rejectPending: null,
    awaitResponse: (requestOpcode, timeoutMs = 20000) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = responseWaiters.findIndex((w) => w.resolve === wrappedResolve);
          if (idx >= 0) responseWaiters.splice(idx, 1);
          reject(new BluetoothDfuFailedError(`Timed out waiting for response to opcode 0x${requestOpcode.toString(16)}`));
        }, timeoutMs);
        const wrappedResolve = (v: Uint8Array) => { clearTimeout(timer); ctx.rejectPending = null; resolve(v); };
        const wrappedReject = (e: unknown) => { clearTimeout(timer); ctx.rejectPending = null; reject(e); };
        ctx.rejectPending = wrappedReject;
        responseWaiters.push({ opcode: requestOpcode, resolve: wrappedResolve, reject: wrappedReject });
      }),
    awaitPrn: (timeoutMs = 20000) =>
      new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = prnWaiters.findIndex((w) => w.resolve === wrappedResolve);
          if (idx >= 0) prnWaiters.splice(idx, 1);
          reject(new BluetoothDfuFailedError('Timed out waiting for packet-receipt notification'));
        }, timeoutMs);
        const wrappedResolve = (n: number) => { clearTimeout(timer); resolve(n); };
        const wrappedReject = (e: unknown) => { clearTimeout(timer); reject(e); };
        prnWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });
      }),
    // Reject the in-flight control-point response (if any) AND every queued PRN
    // waiter. awaitPrn does not register into ctx.rejectPending, so without this
    // a GATT disconnect mid-stream stalls the firmware loop until the 20s PRN
    // timeout. Invoked from onDisconnect.
    rejectAllPending: (e: unknown) => {
      ctx.rejectPending?.(e);
      const waiters = prnWaiters.splice(0, prnWaiters.length);
      for (const w of waiters) w.reject(e);
    },
    dispose: () => {
      control.removeEventListener('characteristicvaluechanged', onNotify);
      try { void control.stopNotifications(); } catch { /* ignore */ }
    },
  };

  function onNotify(ev: Event) {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const u8 = new Uint8Array(v.buffer.slice(0));
    trace(`control notify: ${hexFmt(u8)}`);
    if (u8[0] === Op.Response) {
      // [0x10, requestOpcode, status, ...]
      const reqOpcode = u8[1];
      const status = u8[2];
      const w = responseWaiters.shift();
      if (!w) return;
      if (w.opcode !== reqOpcode) {
        w.reject(new BluetoothDfuFailedError(`Unexpected response opcode 0x${reqOpcode.toString(16)} (wanted 0x${w.opcode.toString(16)})`));
      } else if (status !== RESP_SUCCESS) {
        w.reject(new BluetoothDfuFailedError(`DFU request 0x${reqOpcode.toString(16)} failed with status 0x${status.toString(16)}`));
      } else {
        w.resolve(u8);
      }
    } else if (u8[0] === Op.PacketReceiptNotif) {
      const received = u8.length >= 5 ? new DataView(u8.buffer).getUint32(1, true) : 0;
      const w = prnWaiters.shift();
      if (w) w.resolve(received);
    }
  }

  control.addEventListener('characteristicvaluechanged', onNotify);
  await withTimeout(control.startNotifications(), 3000, 'control startNotifications');
  trace('control-point notifications enabled');
  return ctx;
}

// ---- Firmware streaming ----------------------------------------------------

async function streamFirmware(
  ctx: LegacyDfuContext,
  appBin: Uint8Array,
  onProgress: (sent: number, total: number) => void,
  trace: (m: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const total = appBin.length;
  let sent = 0;
  let sincePrn = 0;
  while (sent < total) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (ctx.disconnected) throw new BluetoothDfuFailedError('GATT disconnected mid-DFU');
    const end = Math.min(sent + PACKET_SIZE, total);
    await writePacket(ctx, appBin.subarray(sent, end));
    sent = end;
    sincePrn += 1;
    onProgress(sent, total);
    // After PRN_INTERVAL packets (and at the very end) wait for the
    // bootloader's receipt notification before flooding it with more.
    if (sincePrn >= PRN_INTERVAL && sent < total) {
      const received = await ctx.awaitPrn();
      sincePrn = 0;
      if (received !== sent) {
        trace(`PRN mismatch: bootloader has ${received}, we sent ${sent}`);
      }
    }
  }
  trace(`streamed ${sent} bytes`);
}

// ---- Characteristic write helpers ------------------------------------------

async function writeControl(ctx: LegacyDfuContext, bytes: number[], trace: (m: string) => void): Promise<void> {
  if (ctx.disconnected) throw new BluetoothDfuFailedError('GATT disconnected mid-DFU');
  const u8 = new Uint8Array(bytes);
  trace(`-> control ${hexFmt(u8)}`);
  await ctx.control.writeValue(u8);
}

async function writePacket(ctx: LegacyDfuContext, data: Uint8Array): Promise<void> {
  if (ctx.disconnected) throw new BluetoothDfuFailedError('GATT disconnected mid-DFU');
  // Packet characteristic is write-without-response. Prefer the explicit API
  // where available; fall back to writeValue on older browsers. Cast to
  // BufferSource (matches ble-dfu-web.ts) to satisfy the strict DOM typings.
  const buf = data as unknown as BufferSource;
  if (typeof ctx.packet.writeValueWithoutResponse === 'function') {
    await ctx.packet.writeValueWithoutResponse(buf);
  } else {
    // eslint-disable-next-line deprecation/deprecation
    await ctx.packet.writeValue(buf);
  }
}

// ---- Init packet (byte-identical to upstream createLegacyInitPacketV1) -----

function createLegacyInitPacketV1(appData: Uint8Array): Uint8Array {
  const buffer = new ArrayBuffer(14);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let offset = 0;
  view.setUint16(offset, 0xffff, true); offset += 2; // device type (wildcard)
  view.setUint16(offset, 0xffff, true); offset += 2; // device revision (wildcard)
  view.setUint32(offset, 0xffffffff, true); offset += 4; // app version (wildcard)
  view.setUint16(offset, 1, true); offset += 2; // SoftDevice count
  view.setUint16(offset, 0x0064, true); offset += 2; // SoftDevice requirement (S110 v10.0)
  view.setUint16(offset, calculateCRC16(appData), true); // CRC-16 of the application
  return u8;
}

function calculateCRC16(data: Uint8Array): number {
  // CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — matches the bootloader.
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

// ---- Hex → application binary (nRF51 S110 app region) ----------------------

function extractAppBinV1(hex: string): Uint8Array {
  const map = MemoryMap.fromHex(hex);
  let maxAddress = V1_APP.start;
  for (const [blockAddr, block] of map) {
    const blockEnd = blockAddr + block.length;
    if (blockEnd > V1_APP.start && blockAddr < V1_APP.end) {
      maxAddress = Math.max(maxAddress, Math.min(blockEnd, V1_APP.end));
    }
  }
  let size = maxAddress - V1_APP.start;
  if (size <= 0) throw new BluetoothDfuFailedError('Hex contains no data in the V1 app region (0x18000–0x3C000)');
  size = Math.ceil(size / 4) * 4; // DFU requires 4-byte alignment
  return map.slicePad(V1_APP.start, size);
}

// ---- Small async helpers ---------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BluetoothDfuFailedError(`${what} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function oneShotEvent(target: EventTarget, type: string, timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => { /* set below */ };
  const promise = new Promise<void>((resolve) => {
    const handler = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(type, handler); };
    target.addEventListener(type, handler);
    cancel = cleanup;
  });
  return { promise, cancel: () => cancel() };
}

function hexFmt(u8: Uint8Array): string {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
