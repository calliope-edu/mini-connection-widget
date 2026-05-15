/**
 * Calliope / micro:bit "friendly name" utilities.
 *
 * The firmware derives a deterministic 5-letter name from the device's
 * 32-bit hardware serial (see codal-microbit-v2/source/MicroBitDevice.cpp
 * `microbit_friendly_name`). The same 5 base-5 digits drive the column
 * heights of the 5×5 "name histogram" shown in pairing mode (see
 * `MicroBitBLEManager::showNameHistogram`). Given the 5 letters we can
 * recover the digits and reproduce the histogram pixel-for-pixel — useful
 * for UIs that want to display the same identifier image the device shows
 * on its LED matrix.
 *
 * The advertised BLE name typically wraps the friendly name in vendor
 * boilerplate (e.g. "BBC micro:bit [tipov]" or "Calliope mini tipov").
 * `extractFriendlyName` finds the 5-letter CVCVC pattern within any
 * such wrapper.
 */

const CONSONANTS = ['z', 'v', 'g', 'p', 't'] as const;
const VOWELS = ['u', 'o', 'i', 'e', 'a'] as const;

// Codebook indexed by letter position 0..4 — same one the firmware uses
// in MicroBitDevice.cpp::microbit_friendly_name (CVCVC pattern).
const CODEBOOK: ReadonlyArray<ReadonlyArray<string>> = [
  CONSONANTS,
  VOWELS,
  CONSONANTS,
  VOWELS,
  CONSONANTS,
];

/**
 * Derive the firmware-style 5-letter friendly name from the 32-bit hardware
 * device ID. Mirrors `microbit_friendly_name` in codal-microbit-v2.
 *
 * Source: `MICROBIT_FICR->DEVICEID[1]`, available over USB through the
 * DAPLink CMSIS-DAP vendor commands — upstream surfaces it as
 * `MicrobitUSBConnection.getDeviceId()`.
 */
export function friendlyNameFromDeviceId(deviceId: number): string {
  const out = new Array<string>(5);
  // JS bitwise math is 32-bit and signed; coerce to unsigned for the
  // modulo cascade so a high bit doesn't flip the result negative.
  let n = deviceId >>> 0;
  let ld = 1;
  let d = 5;
  for (let i = 0; i < 5; i++) {
    const h = Math.floor((n % d) / ld);
    n -= h;
    d *= 5;
    ld *= 5;
    out[5 - 1 - i] = CODEBOOK[i][h];
  }
  return out.join('');
}

/**
 * Pull a Calliope/micro:bit friendly name (5 letters in CVCVC pattern) out
 * of a possibly-wrapped device name string. Returns the lowercase 5-letter
 * name, or `undefined` if none is found.
 */
export function extractFriendlyName(deviceName: string | undefined): string | undefined {
  if (!deviceName) return undefined;
  const match = /[zvgpt][uoiea][zvgpt][uoiea][zvgpt]/i.exec(deviceName);
  return match?.[0]?.toLowerCase();
}

/**
 * Convert a friendly name into the 5×5 boolean grid shown on the device's
 * LED matrix in pairing mode. `grid[row][col]` — `row=0` is the top, `row=4`
 * the bottom; `true` means the pixel is lit. Returns `null` if the name
 * isn't a valid CVCVC pattern.
 */
export function friendlyNameToPattern(name: string | undefined): boolean[][] | null {
  if (!name || name.length !== 5) return null;
  const heights: number[] = [];
  for (let col = 0; col < 5; col++) {
    const letter = name[col].toLowerCase();
    const codebook = CODEBOOK[col];
    const h = codebook.indexOf(letter);
    if (h < 0) return null;
    heights.push(h);
  }
  const grid: boolean[][] = Array.from({ length: 5 }, () => Array<boolean>(5).fill(false));
  for (let col = 0; col < 5; col++) {
    for (let j = 0; j <= heights[col]; j++) {
      grid[4 - j][col] = true;
    }
  }
  return grid;
}
