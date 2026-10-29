import type { BoardVersion } from '@microbit/microbit-connection';

/**
 * Calliope hardware family. Independent of the micro:bit library's BoardVersion
 * (which only knows V1/V2). Calliope mini 1 and 2 both ship the DAL firmware
 * and map to micro:bit V1-class silicon; mini 3 ships CODAL and maps to
 * V2-class silicon. Derived from the WebUSB device's productName string when
 * possible (DAPLink reports "Arm Calliope mini V3 CMSIS-DAP" for mini 3).
 */
export type CalliopeVersion = 'V1' | 'V2' | 'V3';

export function detectCalliopeVersion(
  productName: string | undefined,
  boardVersion: BoardVersion | undefined,
): CalliopeVersion | undefined {
  if (productName) {
    const m = /Calliope[^V]*V(\d)/i.exec(productName);
    if (m) {
      const n = m[1];
      if (n === '1' || n === '2' || n === '3') return `V${n}` as CalliopeVersion;
    }
  }
  // Fall back to the micro:bit library's board version: mini 3 is CODAL/V2-class,
  // mini 1/2 are DAL/V1-class. Without the productName hint we can't disambiguate
  // mini 2 from mini 3, but we at least avoid labelling mini 3 as V1.
  if (boardVersion === 'V2') return 'V3';
  if (boardVersion === 'V1') return 'V1';
  return undefined;
}

/**
 * Save the hex string to the user's downloads folder. Used by the "Download
 * .hex file" choice in the connection-choice modal and the mini 2 flash
 * fallback — the user then drags the file onto the Calliope's USB
 * mass-storage drive to flash it manually.
 *
 * Also exported for hosts that need the same download from their own code
 * path: MakeCode's "Als Datei herunterladen" menu action, which under
 * `controller=2` pxt does not write itself — it posts `{ save, name }` and
 * leaves the file to the host.
 *
 * Only characters that are actually illegal in a filename are stripped, so
 * German project names survive intact (a blanket `[^a-zA-Z0-9._-]` filter
 * would turn "Mein Prögrämmchen" into "Mein-Pr-gr-mmchen").
 */
export function downloadHexFile(hex: string, name: string): void {
  if (typeof document === 'undefined' || !hex) return;
  const base =
    (name || '')
      // Illegal on Windows (and `/` on POSIX).
      .replace(/[\\/:*?"<>|]/g, '-')
      // Windows also rejects a trailing dot or space.
      .replace(/[. ]+$/, '')
      .trim() || 'calliope-program';
  // pxt can emit either format; don't append .hex to a name that already
  // carries an extension.
  const fileName = /\.(hex|uf2)$/i.test(base) ? base : `${base}.hex`;
  const blob = new Blob([hex], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the download has time to start. Revoking synchronously
  // after click() races the browser and can cancel the download outright.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/**
 * MakeCode appends its own metadata records (compressed project source, header)
 * after the Intel-HEX EOF record so the `.hex` file can be re-imported as a
 * project. dapjs's parser rejects any records after EOF ("there is data after
 * an eof record"). Strip everything from the first EOF record onward, keeping
 * the EOF line itself.
 */
export function stripMakeCodeMetadata(hex: string): string {
  const EOF = ':00000001FF';
  const idx = hex.indexOf(EOF);
  if (idx < 0) return hex;
  let end = idx + EOF.length;
  if (hex[end] === '\r') end++;
  if (hex[end] === '\n') end++;
  return hex.slice(0, end);
}
