/**
 * Inspect a hex file's contents to classify it as MakeCode, MicroPython, or
 * unknown — before we send a single byte over BLE or USB.
 *
 * Why: the connection dispatcher needs to know whether a payload is suitable
 * for partial flashing (MakeCode only) or has to go full DFU / USB drag-drop
 * (MicroPython, custom firmware). Today we only learn this from device-side
 * failures, which leaves the user staring at error toasts before the
 * fallback kicks in. The iOS / Android Calliope apps parse the hex up-front
 * for exactly this reason — see `PartialFlashingService.kt`:
 *
 *   PXT_MAGIC = "708E3B92C615A841C49866C975EE5197"   (MakeCode marker)
 *   UPY_MAGIC1 = "FE307F59"                          (MicroPython marker 1)
 *   UPY_MAGIC2 = "9DD7B1C1"                          (MicroPython marker 2)
 *
 * The MakeCode magic is the same one [ble-flash-web.ts](src/ble-flash-web.ts)
 * uses for partial-flash region lookup. MicroPython firmware images embed
 * MAGIC1 followed (16 bytes later) by MAGIC2; either marker alone is enough
 * to fingerprint MicroPython, but the strict variant matches Android.
 */

import MemoryMap from 'nrf-intel-hex';

export type HexFlavor = 'makecode' | 'micropython' | 'unknown';

export interface HexInspection {
  flavor: HexFlavor;
  /** Approximate firmware payload size in bytes (for logging only). */
  byteCount: number;
}

// MakeCode magic — 16 bytes, aligned to 16-byte boundaries. Same value
// as in `ble-flash-web.ts` (duplicated to keep this module standalone).
const MAKECODE_MAGIC = new Uint8Array([
  0x70, 0x8e, 0x3b, 0x92, 0xc6, 0x15, 0xa8, 0x41,
  0xc4, 0x98, 0x66, 0xc9, 0x75, 0xee, 0x51, 0x97,
]);

// MicroPython markers — 4 bytes each. MAGIC1 then MAGIC2 sit 16 bytes apart
// in the embedded firmware blob, matching `UPY_MAGIC_REGEX` from the
// Android app.
const UPY_MAGIC1 = new Uint8Array([0xfe, 0x30, 0x7f, 0x59]);
const UPY_MAGIC2 = new Uint8Array([0x9d, 0xd7, 0xb1, 0xc1]);

function indexOf(haystack: Uint8Array, needle: Uint8Array, start = 0, align = 1): number {
  const last = haystack.length - needle.length;
  for (let i = start; i <= last; i += align) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Classify a hex string by looking for runtime-specific magic byte patterns.
 *
 * Cheap (skims segments looking for two short markers), always safe to call
 * — bad inputs return `{ flavor: 'unknown', byteCount: 0 }` rather than
 * throwing. Use this before routing a flash, then let the actual flash code
 * do its own deeper validation.
 */
export function inspectHex(hex: string): HexInspection {
  let map: ReturnType<typeof MemoryMap.fromHex>;
  try {
    map = MemoryMap.fromHex(hex);
  } catch {
    return { flavor: 'unknown', byteCount: 0 };
  }
  let byteCount = 0;
  let foundMakecode = false;
  let foundUpy1 = -1;
  let foundUpy2 = -1;
  for (const [, bytes] of map) {
    const u8: Uint8Array = bytes;
    byteCount += u8.length;
    if (!foundMakecode && indexOf(u8, MAKECODE_MAGIC, 0, 16) >= 0) {
      foundMakecode = true;
    }
    if (foundUpy1 < 0) {
      const idx = indexOf(u8, UPY_MAGIC1);
      if (idx >= 0) foundUpy1 = idx;
    }
    if (foundUpy2 < 0) {
      const idx = indexOf(u8, UPY_MAGIC2);
      if (idx >= 0) foundUpy2 = idx;
    }
  }
  // MakeCode wins if present — MicroPython images sometimes embed unrelated
  // byte sequences that happen to collide with MAGIC1, but the MakeCode
  // marker is a CODAL-specific 16-byte fingerprint that's extremely unlikely
  // to collide.
  if (foundMakecode) return { flavor: 'makecode', byteCount };
  if (foundUpy1 >= 0 && foundUpy2 >= 0) return { flavor: 'micropython', byteCount };
  return { flavor: 'unknown', byteCount };
}

// ---- nRF51 RAM class (Calliope mini 1 = 16 KB vs mini 2 = 32 KB) -----------

export type HexRamClass = '16kb' | '32kb';

/**
 * Detect which nRF51 RAM size a DAL-era hex was linked for.
 *
 * The first word of a Cortex-M vector table is the initial main stack
 * pointer, and DAL/mbed linker scripts put the stack top at the END of RAM —
 * so it directly encodes the RAM size the image needs:
 *
 *   0x20004000 → 16 KB build (runs on mini 1 AND mini 2)
 *   0x20008000 → 32 KB build (mini 2 ONLY — hangs/faults on a mini 1)
 *
 * DAL images ship the S110 softdevice at 0x0 with the application vector
 * table at 0x18000; softdevice-less images keep theirs at 0x0. Anything else
 * (mini 3 CODAL images point into 128 KB nRF52 RAM, universal-hex containers
 * whose custom records the parser skips) returns `undefined` — callers must
 * treat that as "unknown", never as "fits".
 */
export function detectHexRamClass(hex: string): HexRamClass | undefined {
  let map: ReturnType<typeof MemoryMap.fromHex>;
  try {
    map = MemoryMap.fromHex(hex);
  } catch {
    return undefined;
  }
  const readU32 = (addr: number): number | undefined => {
    for (const [start, bytes] of map) {
      const off = addr - start;
      if (off >= 0 && off + 4 <= bytes.length) {
        return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
      }
    }
    return undefined;
  };
  for (const vectorTable of [0x18000, 0x0]) {
    const msp = readU32(vectorTable);
    if (msp === undefined) continue;
    // Sanity: an initial MSP points into nRF51 RAM (0x2000_0000 + size).
    if ((msp & 0xffff0000) >>> 0 !== 0x20000000) continue;
    const ramTop = msp - 0x20000000;
    if (ramTop > 0x4000 && ramTop <= 0x8000) return '32kb';
    if (ramTop > 0 && ramTop <= 0x4000) return '16kb';
  }
  return undefined;
}
