/**
 * BLE partial flashing over Web Bluetooth, ported from the
 * `calliope-edu/mini-connection` fork.
 *
 * Upstream `@microbit/microbit-connection@1.0.0-beta.*`'s `connection.flash()`
 * works on Capacitor native (iOS/Android) but fails on Web Bluetooth — the
 * partial-flash protocol relies on tight write+notify sequencing that
 * Capacitor's web fallback doesn't deliver reliably (observed: timeouts in
 * `writeForNotification` and `NotSupportedError: GATT operation failed for
 * unknown reason`).
 *
 * This module talks to `navigator.bluetooth` directly. It expects:
 *   - The device has been picked & paired by upstream's `connection.connect()`.
 *   - OS-level pairing exists (the partial-flashing characteristic is
 *     authenticated on CODAL builds).
 *
 * Protocol reference:
 *   codal-microbit-v2/docs/bluetooth/MicroBitPartialFlashing.md
 *   MakeCode's webble.ts (PartialFlashingService)
 */

import MemoryMap from 'nrf-intel-hex';
import { appendLog } from './log';

// ---- Service / characteristic UUIDs ----------------------------------------

const PARTIAL_FLASH_SERVICE_UUID = 'e97dd91d-251d-470a-a062-fa1922dfa9a8';
const PARTIAL_FLASH_CHAR_UUID = 'e97d3b10-251d-470a-a062-fa1922dfa9a8';

// ---- MakeCode magic marker -------------------------------------------------

const MAGIC_MARKER = new Uint8Array([
  0x70, 0x8e, 0x3b, 0x92, 0xc6, 0x15, 0xa8, 0x41, 0xc4, 0x98, 0x66, 0xc9, 0x75,
  0xee, 0x51, 0x97,
]);

// ---- Protocol opcodes ------------------------------------------------------

const Cmd = {
  RegionInfo: 0x00,
  FlashData: 0x01,
  EndOfTransmission: 0x02,
  Status: 0xee,
  Reset: 0xff,
} as const;

const Region = {
  SoftDevice: 0x00,
  Dal: 0x01,
  MakeCode: 0x02,
} as const;

const Mode = {
  Pairing: 0x00,
  Application: 0x01,
} as const;

const FlashAck = {
  OutOfOrder: 0xaa,
  Written: 0xff,
} as const;

// ---- Errors ----------------------------------------------------------------

/**
 * The DAL hash on the connected device doesn't match the hex's expected DAL
 * hash. Partial flashing is impossible — the user must do a full USB flash
 * first to update the runtime.
 */
export class BluetoothPartialFlashDalMismatchError extends Error {
  constructor() {
    super('DAL hash mismatch — full USB flash required before BLE partial flashing can resume');
    this.name = 'BluetoothPartialFlashDalMismatchError';
  }
}

/**
 * The hex file doesn't contain the MakeCode magic marker — i.e. it isn't a
 * MakeCode-compiled binary. Partial flashing only works for MakeCode hexes.
 */
export class BluetoothPartialFlashInvalidHexError extends Error {
  constructor() {
    super('Hex does not contain a MakeCode magic marker');
    this.name = 'BluetoothPartialFlashInvalidHexError';
  }
}

/**
 * The partial-flashing service isn't advertised on the device. Most likely
 * the firmware was built without partial flashing, or the device is running
 * a non-MakeCode hex.
 */
export class BluetoothPartialFlashServiceMissingError extends Error {
  constructor() {
    super('Calliope is not exposing the partial-flashing service');
    this.name = 'BluetoothPartialFlashServiceMissingError';
  }
}

// ---- High-level entry point ------------------------------------------------

export type BluetoothFlashPhase =
  | 'refreshing'
  | 'running'
  | 'pairing-mode-switch'
  | 'reconnecting'
  | 'flashing'
  | 'finalising';

export interface FlashOverBluetoothOptions {
  device: BluetoothDevice;
  hex: string;
  onProgress?: (progress: number) => void;
  onPhase?: (phase: BluetoothFlashPhase) => void;
  signal?: AbortSignal;
  /**
   * How many times to retry the whole run on "service missing" / stale-GATT
   * errors. Defaults to 1 (= one retry after a coordinated GATT refresh).
   */
  serviceMissingRetries?: number;
}

/**
 * Run a complete partial-flashing operation. Resolves once the device has
 * acknowledged END_OF_TRANSMISSION and is rebooting back into application
 * mode. The caller is expected to set up its own UART subscription afterwards
 * (give the program ~1.5 s to start).
 */
export async function flashOverBluetoothWeb(
  opts: FlashOverBluetoothOptions,
): Promise<void> {
  const trace = (m: string) => appendLog({ direction: 'info', text: `pf-ble: ${m}` });
  const phase = (p: BluetoothFlashPhase) => {
    trace(`phase=${p}`);
    opts.onPhase?.(p);
  };
  const tries = Math.max(1, 1 + (opts.serviceMissingRetries ?? 1));

  if (!opts.device.gatt) {
    throw new Error('BluetoothDevice has no GATT');
  }

  // Don't disconnect proactively — upstream's connection wrapper still owns
  // the existing GATT. Try the cached service tree first; if it's stale we
  // catch the failure and do one coordinated refresh+retry.
  phase('running');
  opts.onProgress?.(0.05);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) {
      trace(`retrying after ${describeRetryReason(lastErr)} (attempt ${attempt + 1}/${tries})`);
      phase('refreshing');
      opts.onProgress?.(0.04);
      await refreshGatt(opts.device);
      opts.onProgress?.(0.06);
    }
    try {
      await runOnce(opts, phase, trace);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableFlashError(err)) throw err;
      trace(`attempt failed: ${(err as Error).message}`);
    }
  }
  throw lastErr ?? new Error('Flash failed');
}

function isRetryableFlashError(err: unknown): boolean {
  if (err instanceof BluetoothPartialFlashServiceMissingError) return true;
  // Timeouts on writeNoNotify / openCharacteristic surface as plain Errors
  // with a "timeout: …" prefix. They almost always mean Chrome's GATT cache
  // is stale, which a coordinated refresh+reconnect cures.
  const msg = (err as Error)?.message ?? '';
  return /^timeout:/.test(msg);
}

function describeRetryReason(err: unknown): string {
  if (err instanceof BluetoothPartialFlashServiceMissingError) return 'service-missing';
  const msg = (err as Error)?.message ?? '';
  if (/^timeout:/.test(msg)) return msg;
  return 'unknown error';
}

async function runOnce(
  opts: FlashOverBluetoothOptions,
  phase: (p: BluetoothFlashPhase) => void,
  trace: (m: string) => void,
): Promise<void> {
  const server = opts.device.gatt!.connected
    ? opts.device.gatt!
    : await opts.device.gatt!.connect();

  const session = new BluetoothPartialFlashSession(server);
  let switchedMode = false;

  try {
    await session.run(opts.hex, {
      signal: opts.signal,
      onProgress: (p: number) => {
        // Map raw protocol progress 0..1 onto 15..99 % of overall work so
        // the bar keeps advancing past whatever the pre-flash phases
        // already filled in.
        if (!switchedMode) phase('flashing');
        opts.onProgress?.(0.15 + p * 0.84);
      },
      reconnect: async () => {
        switchedMode = true;
        phase('pairing-mode-switch');
        opts.onProgress?.(0.08);
        await refreshGatt(opts.device);
        phase('reconnecting');
        for (let i = 0; i < 6; i++) {
          try {
            const s = await opts.device.gatt!.connect();
            opts.onProgress?.(0.12);
            return s;
          } catch (err) {
            trace(`reconnect attempt ${i + 1} failed: ${(err as Error).message}`);
            await delay(500 + i * 250);
          }
        }
        return null;
      },
    });
    phase('finalising');
    opts.onProgress?.(1);
  } finally {
    await session.dispose();
  }
}

/**
 * Force a clean disconnect + fresh GATT connection so Chrome re-discovers
 * services. Cached service trees survive across `gatt.connect()` calls when
 * the underlying connection was kept by the OS, which is exactly what makes
 * partial flashing flaky after a device-side reboot.
 */
async function refreshGatt(device: BluetoothDevice): Promise<void> {
  if (!device.gatt) return;
  if (device.gatt.connected) {
    try { device.gatt.disconnect(); } catch { /* may already be gone */ }
    // Disconnects are async at the OS level. Give Chrome a beat to finish
    // tearing down before we open a new connection — otherwise we sometimes
    // get back the stale GATT view we tried to discard.
    await delay(400);
  }
  await device.gatt.connect();
}

// ---- Hex parsing -----------------------------------------------------------

interface ParsedHex {
  /** Binary contents of the MakeCode region (and onwards). */
  bin: Uint8Array;
  /** Offset of the magic marker within `bin` — always 0 by construction. */
  magicOffset: number;
  /** First absolute address of the MakeCode region. */
  baseAddr: number;
  /** 8-byte DAL hash extracted from the hex (post magic marker). */
  dalHash: Uint8Array;
  /** 8-byte MakeCode hash extracted from the hex. */
  makeCodeHash: Uint8Array;
}

export function parseMakeCodeHex(hex: string): ParsedHex {
  const map = MemoryMap.fromHex(hex);
  for (const [segStart, bytes] of map) {
    const u8: Uint8Array = bytes;
    for (
      let i = 0;
      i + MAGIC_MARKER.length + 16 <= u8.length;
      i += 16 // markers are 16-byte aligned in MakeCode
    ) {
      let match = true;
      for (let j = 0; j < MAGIC_MARKER.length; j++) {
        if (u8[i + j] !== MAGIC_MARKER[j]) { match = false; break; }
      }
      if (match) {
        return {
          bin: u8.slice(i),
          magicOffset: 0,
          baseAddr: segStart + i,
          dalHash: u8.slice(i + MAGIC_MARKER.length, i + MAGIC_MARKER.length + 8),
          makeCodeHash: u8.slice(i + MAGIC_MARKER.length + 8, i + MAGIC_MARKER.length + 16),
        };
      }
    }
  }
  throw new BluetoothPartialFlashInvalidHexError();
}

// ---- MicroPython layout-table parsing -------------------------------------

/**
 * MicroPython hex layout-table magic numbers. Emitted by `addlayouttable.py`
 * in the FIRMWARE/micropython-calliope-mini-v3 build. The codal partial
 * flashing service on the device parses the same magic — see
 * codal-microbit-v2 `MicroBitMemoryMap.cpp:152-165` (`processRecord`).
 *
 * The 16-byte trailer at the end of the layout table is:
 *   [MAGIC1:4 | VERSION:2 | TABLE_LEN:2 | NUM_REG:2 | PSIZE_LOG2:2 | MAGIC2:4]
 * (all little-endian). Region records precede the trailer in the same page:
 *   [ID:1 | HT:1 | REG_PAGE:2 | REG_LEN:4 | HASH_DATA:8]
 *
 * MAGIC1 = 0x597F30FE, MAGIC2 = 0xC1B1D79D (from addlayouttable.py).
 */
const UPY_MAGIC1 = new Uint8Array([0xfe, 0x30, 0x7f, 0x59]); // LE 0x597F30FE
const UPY_MAGIC2 = new Uint8Array([0x9d, 0xd7, 0xb1, 0xc1]); // LE 0xC1B1D79D

/**
 * Region IDs used by `addlayouttable.py`:
 *   1 = SoftDevice
 *   2 = MicroPython runtime (HASH_PTR — codal stores CRC32 of version string)
 *   3 = Filesystem (HASH_NONE — codal stores 8 zero bytes)
 *
 * The codal partial flashing service maps these to `memoryMap[id - 1]` (see
 * `MicroBitMemoryMap.cpp:212`). So the widget's `Region.Dal` query (slot 1
 * = id 2) returns the MicroPython runtime hash, and the widget's
 * `Region.MakeCode` query (slot 2 = id 3) returns the filesystem hash.
 */
const UPY_REGION_RUNTIME = 2;
const UPY_REGION_FS = 3;

interface UpyLayoutRecord {
  id: number;
  startAddr: number;
  endAddr: number;
  hash: Uint8Array; // 8 bytes
}

/**
 * Parse a MicroPython-format hex (one that bundles
 * `addlayouttable.py` output) for partial flashing.
 *
 * Returns the FS region's bytes as `bin` so the widget's existing
 * write loop streams the filesystem (24 KB for our build) to the device.
 * The MicroPython runtime is not flashed by this path — it's covered by
 * the DAL-hash compatibility check (any runtime version change forces a
 * full Nordic DFU fallback via `BluetoothPartialFlashDalMismatchError`).
 *
 * Note: codal's layout-table records for SD and FS use `HASH_NONE` (8
 * zero bytes). To prevent the widget's "identical hash → skip flash"
 * shortcut from no-op'ing every MicroPython flash, we synthesise a
 * deterministic non-zero `makeCodeHash` from the FS bytes' length + first
 * 4 bytes — guaranteed to differ from the device's all-zero FS hash on
 * any actually-flashable run. (Same-content re-flash will re-write the
 * 24 KB FS, which is ~3 s at partial-flashing throughput.)
 */
export function parseMicroPythonHex(hex: string): ParsedHex {
  const map = MemoryMap.fromHex(hex);

  // Find the layout-table trailer: 16-byte window with MAGIC1 at offset 0
  // and MAGIC2 at offset 12, validated against three additional invariants
  // that the addlayouttable.py output guarantees but a coincidental bytes
  // match inside the runtime binary will fail:
  //
  //   1. The trailer's last byte ends exactly on a 4-KB page boundary.
  //      (addlayouttable.py aligns the table to end-of-page so codal can
  //      "quickly and easily" search for it — codal scans page-aligned.)
  //   2. TABLE_LEN ≤ 256 — that's ≤ 16 region records, more than enough for
  //      any realistic firmware layout (we ship 3).
  //   3. NUM_REG ≤ 16 — matches (2).
  //
  // Without these, the runtime binary's 305 KB of code regularly contains
  // 4-byte byte sequences that happen to match MAGIC1 + MAGIC2 at the
  // right separation, producing nonsense "trailers" with garbage
  // TABLE_LEN / NUM_REG values.
  for (const [segStart, bytes] of map) {
    const u8: Uint8Array = bytes;
    for (let i = 0; i + 16 <= u8.length; i += 16) {
      if (
        u8[i] === UPY_MAGIC1[0] && u8[i + 1] === UPY_MAGIC1[1] &&
        u8[i + 2] === UPY_MAGIC1[2] && u8[i + 3] === UPY_MAGIC1[3] &&
        u8[i + 12] === UPY_MAGIC2[0] && u8[i + 13] === UPY_MAGIC2[1] &&
        u8[i + 14] === UPY_MAGIC2[2] && u8[i + 15] === UPY_MAGIC2[3]
      ) {
        // Invariant 1: trailer ends on a 4-KB page boundary.
        if (((segStart + i + 16) & 0xfff) !== 0) continue;
        const tableLen = u8[i + 6] | (u8[i + 7] << 8);
        const numReg = u8[i + 8] | (u8[i + 9] << 8);
        // Invariants 2 + 3: reasonable size.
        if (tableLen === 0 || tableLen > 256 || numReg === 0 || numReg > 16) continue;
        if (tableLen !== numReg * 16) continue;
        // Region records precede the trailer.
        const recordsStart = i - tableLen;
        if (recordsStart < 0) continue; // trailer too close to start; not real

        const records: UpyLayoutRecord[] = [];
        for (let r = recordsStart; r < i; r += 16) {
          const id = u8[r];
          const regPage = u8[r + 2] | (u8[r + 3] << 8);
          const regLen =
            u8[r + 4] | (u8[r + 5] << 8) | (u8[r + 6] << 16) | (u8[r + 7] << 24);
          const startAddr = regPage * 4096; // PSIZE_LOG2 = 12
          records.push({
            id,
            startAddr,
            endAddr: startAddr + regLen,
            hash: u8.slice(r + 8, r + 16),
          });
        }

        const runtime = records.find((r) => r.id === UPY_REGION_RUNTIME);
        const fs = records.find((r) => r.id === UPY_REGION_FS);
        if (!runtime || !fs) continue;

        // Extract FS bytes from the hex's memory map.
        // slicePad fills any unprogrammed gaps with 0xFF (flash-erased state)
        // so the device's per-page erase-only-if-needed logic stays cheap.
        const fsBytes = map.slicePad(fs.startAddr, fs.endAddr - fs.startAddr, 0xff);

        // Synthesise a non-zero makeCodeHash so the widget's hash-compare
        // shortcut never short-circuits. (FS HASH_NONE on device is 8
        // zero bytes — see codal MicroBitMemoryMap processRecord.)
        const synthetic = new Uint8Array(8);
        const dv = new DataView(synthetic.buffer);
        dv.setUint32(0, fsBytes.length >>> 0, true);
        // first 4 bytes of FS as a content fingerprint
        for (let k = 0; k < 4 && k < fsBytes.length; k++) {
          synthetic[4 + k] = fsBytes[k];
        }
        // guarantee non-zero even if FS is empty/all-FF
        if (synthetic.every((b) => b === 0)) synthetic[0] = 0x01;

        return {
          bin: fsBytes,
          magicOffset: 0,
          baseAddr: fs.startAddr,
          // Device's Region.Dal (slot 1, codal index 1) returns the
          // MicroPython runtime hash. The runtime layout record (id=2)
          // stores CRC32 of the microbit version string in the first 4 bytes
          // (`hash[0]`), with `hash[4..8]` set to zero — see codal
          // `MicroBitMemoryMap.cpp` processRecord HASH_PTR path. The
          // layout-table embeds it the same way, so byte-for-byte the same
          // 8 bytes appear on both sides → match → flash proceeds.
          dalHash: runtime.hash,
          makeCodeHash: synthetic,
        };
      }
    }
  }
  throw new BluetoothPartialFlashInvalidHexError();
}

/**
 * Try the MakeCode parser first; on `BluetoothPartialFlashInvalidHexError`,
 * fall back to MicroPython. If both throw, surface a single
 * `BluetoothPartialFlashInvalidHexError` mentioning both formats.
 */
function parseHexForPartialFlash(hex: string): ParsedHex {
  try {
    return parseMakeCodeHex(hex);
  } catch (e) {
    if (!(e instanceof BluetoothPartialFlashInvalidHexError)) throw e;
  }
  try {
    return parseMicroPythonHex(hex);
  } catch (e) {
    if (e instanceof BluetoothPartialFlashInvalidHexError) {
      throw new BluetoothPartialFlashInvalidHexError();
    }
    throw e;
  }
}

// ---- Session ---------------------------------------------------------------

interface PfStatus { version: number; mode: number; }
interface PfRegion { id: number; start: number; end: number; hash: Uint8Array; }

interface PartialFlashOptions {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  progressUpdateMs?: number;
  /**
   * After issuing a reset-into-pairing command, the device disconnects and
   * needs to be reconnected. The caller must reconnect the GATT server and
   * re-discover services; we'll receive a fresh server via this callback.
   */
  reconnect?: () => Promise<BluetoothRemoteGATTServer | null>;
}

class BluetoothPartialFlashSession {
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private pendingResponse: ((data: Uint8Array) => void) | null = null;
  private aborted = false;

  constructor(private server: BluetoothRemoteGATTServer) {}

  async run(hex: string, opts: PartialFlashOptions = {}): Promise<void> {
    const onProgress = opts.onProgress ?? (() => {});
    const log = (m: string) => appendLog({ direction: 'info', text: `pf-ble: ${m}` });

    if (opts.signal) {
      if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      opts.signal.addEventListener('abort', () => { this.aborted = true; });
    }

    const parsed = parseHexForPartialFlash(hex);
    log(`parsed hex: bin=${parsed.bin.length} bytes, base=0x${parsed.baseAddr.toString(16)}`);

    await this.openCharacteristic();

    let status = await this.requestStatus();
    log(`status: version=${status.version} mode=${status.mode}`);

    // DAL region — must match the hex's expected DAL hash.
    const dal = await this.requestRegion(Region.Dal);
    log(`DAL hash on device: ${hexFmt(dal.hash)} / file: ${hexFmt(parsed.dalHash)}`);
    if (!arraysEqual(dal.hash, parsed.dalHash)) {
      throw new BluetoothPartialFlashDalMismatchError();
    }

    const mc = await this.requestRegion(Region.MakeCode);
    log(`MakeCode hash on device: ${hexFmt(mc.hash)} / file: ${hexFmt(parsed.makeCodeHash)}`);

    if (arraysEqual(mc.hash, parsed.makeCodeHash)) {
      // Identical code — just reset into application mode to mirror USB
      // drag-and-drop behaviour.
      log('identical hash — resetting into application mode');
      await this.writeNoNotify(new Uint8Array([Cmd.Reset, Mode.Application]));
      onProgress(1);
      return;
    }

    // The partial-flashing service can only write flash while the device is
    // in pairing mode. Reboot+reconnect if currently in application mode.
    if (status.mode !== Mode.Pairing) {
      log('device in application mode — switching to pairing mode');
      await this.switchToPairingMode(opts.reconnect);
      status = await this.requestStatus();
      log(`post-reconnect status: version=${status.version} mode=${status.mode}`);
      if (status.mode !== Mode.Pairing) {
        throw new Error('Calliope did not enter pairing mode');
      }
    }

    // Write data: 4 BLE packets per 64-byte block, ack after each block.
    const startAddr = mc.start;
    const totalBytes = parsed.bin.length;
    let offset = 0;
    let packetNumber = 0;
    let chunkDelayMs = 0;
    let lastReport = 0;
    const updateMs = opts.progressUpdateMs ?? 100;

    while (offset < totalBytes) {
      if (this.aborted) throw new DOMException('Aborted', 'AbortError');
      const blockAddr = startAddr + offset;
      const block = new Uint8Array(64);
      block.set(parsed.bin.subarray(offset, Math.min(offset + 64, totalBytes)), 0);

      const packets = buildFlashPackets(blockAddr, packetNumber, block);
      for (let i = 0; i < 4; i++) {
        if (chunkDelayMs > 0) await delay(chunkDelayMs);
        await this.writeNoNotify(packets[i]);
      }

      const ack = await this.waitForResponse(5000, 'flash-block-ack');
      if (ack[0] !== Cmd.FlashData) {
        throw new Error(`expected FLASH_DATA ack, got 0x${ack[0].toString(16)}`);
      }
      if (ack[1] === FlashAck.OutOfOrder) {
        chunkDelayMs = Math.min(chunkDelayMs + 10, 75);
        packetNumber += 4;
        continue;
      }
      if (ack[1] !== FlashAck.Written) {
        throw new Error(`unexpected flash ack 0x${ack[1].toString(16)}`);
      }

      chunkDelayMs = Math.max(chunkDelayMs - 1, 0);
      offset += 64;
      packetNumber = (packetNumber + 4) & 0xff;

      const now = Date.now();
      if (now - lastReport >= updateMs) {
        onProgress(Math.min(offset / totalBytes, 1));
        lastReport = now;
      }
    }

    log('end of transmission');
    await this.writeNoNotify(new Uint8Array([Cmd.EndOfTransmission]));
    onProgress(1);
  }

  /** Release listeners. Safe to call even if the GATT server is gone. */
  async dispose(): Promise<void> {
    if (this.characteristic) {
      try {
        this.characteristic.removeEventListener('characteristicvaluechanged', this.onNotify);
        await this.characteristic.stopNotifications().catch(() => undefined);
      } catch { /* connection may already be torn down */ }
      this.characteristic = null;
    }
  }

  private async openCharacteristic(): Promise<void> {
    let service: BluetoothRemoteGATTService;
    try {
      service = await withTimeout(
        this.server.getPrimaryService(PARTIAL_FLASH_SERVICE_UUID),
        4000,
        'getPrimaryService(partial-flashing)',
      );
    } catch {
      // Service hidden, or Chrome's GATT call hung on a stale cache. Either
      // way, surface as ServiceMissing so the outer orchestrator can retry
      // with a coordinated refresh+reconnect.
      throw new BluetoothPartialFlashServiceMissingError();
    }
    const ch = await withTimeout(
      service.getCharacteristic(PARTIAL_FLASH_CHAR_UUID),
      3000,
      'getCharacteristic(partial-flashing)',
    );
    await withTimeout(ch.startNotifications(), 3000, 'startNotifications');
    ch.addEventListener('characteristicvaluechanged', this.onNotify);
    this.characteristic = ch;
  }

  private onNotify = (ev: Event): void => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const value = ch.value;
    if (!value) return;
    const u8 = new Uint8Array(value.buffer.slice(0));
    const cb = this.pendingResponse;
    if (cb) {
      this.pendingResponse = null;
      cb(u8);
    }
  };

  private async writeNoNotify(payload: Uint8Array): Promise<void> {
    if (!this.characteristic) throw new Error('not connected');
    // 3 s ceiling. writeValueWithoutResponse can hang silently when the
    // GATT view is stale (Chrome caches across reconnects); without a
    // timeout the whole flash sits at the same progress percentage forever.
    const ch = this.characteristic as BluetoothRemoteGATTCharacteristic & {
      writeValueWithoutResponse?: (b: BufferSource) => Promise<void>;
    };
    // TS 5.x narrows Uint8Array's ArrayBufferLike to potentially include
    // SharedArrayBuffer, which BufferSource doesn't accept. Cast at the
    // boundary — the underlying buffer here is always a regular ArrayBuffer.
    const buf = payload as unknown as BufferSource;
    if (ch.writeValueWithoutResponse) {
      await withTimeout(ch.writeValueWithoutResponse(buf), 3000, 'writeValueWithoutResponse');
    } else {
      await withTimeout(this.characteristic.writeValue(buf), 3000, 'writeValue');
    }
  }

  private waitForResponse(timeoutMs: number, label: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pendingResponse) {
          this.pendingResponse = null;
          reject(new Error(`timeout waiting for ${label}`));
        }
      }, timeoutMs);
      this.pendingResponse = (data) => { clearTimeout(t); resolve(data); };
    });
  }

  private async requestStatus(): Promise<PfStatus> {
    await this.writeNoNotify(new Uint8Array([Cmd.Status]));
    const data = await this.waitForResponse(3000, 'status');
    if (data[0] !== Cmd.Status) {
      throw new Error(`expected STATUS, got 0x${data[0].toString(16)}`);
    }
    return { version: data[1], mode: data[2] };
  }

  private async requestRegion(regionId: number): Promise<PfRegion> {
    await this.writeNoNotify(new Uint8Array([Cmd.RegionInfo, regionId]));
    const data = await this.waitForResponse(3000, `region-${regionId}`);
    if (data[0] !== Cmd.RegionInfo) {
      throw new Error(`expected REGION_INFO, got 0x${data[0].toString(16)}`);
    }
    return {
      id: data[1],
      start: ((data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5]) >>> 0,
      end: ((data[6] << 24) | (data[7] << 16) | (data[8] << 8) | data[9]) >>> 0,
      hash: data.slice(10, 18),
    };
  }

  private async switchToPairingMode(
    reconnect: PartialFlashOptions['reconnect'],
  ): Promise<void> {
    if (!reconnect) {
      throw new Error('device in application mode — caller must supply reconnect()');
    }
    const device = this.server.device;
    const log = (m: string) => appendLog({ direction: 'info', text: `pf-ble: ${m}` });

    // Up to three attempts: write the RESET-into-pairing command and wait
    // for the device to drop the GATT link. Chrome's
    // writeValueWithoutResponse occasionally returns success for writes the
    // device never actually processes (stale GATT cache after a previous
    // mode change), so we retry if the disconnect doesn't follow.
    let disconnected = false;
    for (let attempt = 0; attempt < 3 && !disconnected; attempt++) {
      const waitForDisconnect = oneShotEvent(device, 'gattserverdisconnected', 3500);
      try {
        await this.writeNoNotify(new Uint8Array([Cmd.Reset, Mode.Pairing]));
        log(`reset-into-pairing written (attempt ${attempt + 1})`);
      } catch (err) {
        log(`reset-into-pairing write failed: ${(err as Error).message}`);
      }
      try {
        await waitForDisconnect.promise;
        disconnected = !device.gatt?.connected;
        if (disconnected) {
          log('device acknowledged reset by disconnecting');
          break;
        }
        log('disconnect event fired but gatt still reports connected');
      } catch {
        log('no disconnect within 3.5 s — retrying reset command');
      } finally {
        waitForDisconnect.cancel();
      }
    }
    if (!disconnected) {
      throw new Error('Calliope did not switch to pairing mode (no disconnect after 3 attempts)');
    }

    await this.dispose();
    await delay(1200);

    const newServer = await reconnect();
    if (!newServer) {
      throw new Error('reconnect callback did not produce a new GATT server');
    }
    this.server = newServer;
    await this.openCharacteristic();
  }
}

// ---- Utilities -------------------------------------------------------------

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
      reject(new Error(`timeout waiting for ${type}`));
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function buildFlashPackets(
  blockAddr: number,
  startPacketNum: number,
  block64: Uint8Array,
): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  // MakeCode's wire layout:
  //   pkt0: [FLASH, addr_hi8, addr_lo8, seq+0]   + bytes[ 0..15]
  //   pkt1: [FLASH, addr_HI8, addr_HM8, seq+1]   + bytes[16..31]
  //   pkt2: [FLASH, 0,        0,        seq+2]   + bytes[32..47]
  //   pkt3: [FLASH, 0,        0,        seq+3]   + bytes[48..63]
  // The full address arrives split across pkt0 (low half) and pkt1 (high half).
  const mk = (b1: number, b2: number, seq: number, payload: Uint8Array) => {
    const out = new Uint8Array(20);
    out[0] = Cmd.FlashData;
    out[1] = b1 & 0xff;
    out[2] = b2 & 0xff;
    out[3] = seq & 0xff;
    out.set(payload, 4);
    return out;
  };
  return [
    mk((blockAddr >> 8) & 0xff, blockAddr & 0xff, startPacketNum, block64.subarray(0, 16)),
    mk((blockAddr >> 24) & 0xff, (blockAddr >> 16) & 0xff, startPacketNum + 1, block64.subarray(16, 32)),
    mk(0, 0, startPacketNum + 2, block64.subarray(32, 48)),
    mk(0, 0, startPacketNum + 3, block64.subarray(48, 64)),
  ];
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexFmt(a: Uint8Array): string {
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
