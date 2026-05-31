/**
 * Post-connect classifier for a Calliope BLE session.
 *
 * With rc07-open firmware (`MICROBIT_BLE_OPEN=1`) the device has no SMP
 * gate — every characteristic is SEC_OPEN — so the only useful distinction
 * the classifier needs to make is "regular app mode" vs "device is sitting
 * in the Nordic DFU bootloader as `DfuTarg`". The bootloader case lets the
 * dispatcher skip the partial-flash attempt (there's no app running to host
 * the partial-flashing service) and go straight to BLE-DFU.
 *
 * `getPrimaryServices()` is read-only and doesn't trigger any encryption,
 * so this probe is safe to run on every connect.
 */

export type BleSessionKind =
  /** Regular CODAL application mode — partial-flash / UART are reachable. */
  | 'app-mode'
  /** Device is advertising as `DfuTarg`; only the Nordic DFU service is up. */
  | 'dfu-bootloader'
  /** GATT not connected, services unreadable, or empty service set. */
  | 'unknown';

export interface BleSessionClassification {
  kind: BleSessionKind;
  /** Service UUIDs as lowercase 128-bit strings, in the order returned by Chrome. */
  services: string[];
  deviceName?: string;
  /** Human-readable rationale for the decision — gets logged so we can debug
   *  unexpected classifications without instrumenting more code. */
  reason: string;
}

// Service UUIDs we look for, all 128-bit lowercase for direct comparison.
// 16-bit assigned numbers are expanded into their full Base UUID form.
export const SERVICE_UUIDS = {
  partialFlash: 'e97dd91d-251d-470a-a062-fa1922dfa9a8',
  nordicDfu: '0000fe59-0000-1000-8000-00805f9b34fb',
  uart: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  deviceInfo: '0000180a-0000-1000-8000-00805f9b34fb',
  blocks: '0b50f3e4-607f-4151-9091-7d008d6ffc5c',
  // Legacy micro:bit DFU-Control service — present on V1-class silicon
  // (Mini 1 and Mini 2, nRF51/DAL), absent on V2-class (Mini 3, nRF52/CODAL).
  // The shipping Android/iOS apps fingerprint the chip class on this exact
  // presence test. See `boardVersionFromServices`.
  legacyDfuControl: 'e95d93b0-251d-470a-a062-fa1922dfa9a8',
} as const;

/** Pure classification — feed in what we observe, get back a verdict. */
export function classifyBleSession(args: {
  services: string[];
  deviceName?: string;
  connected?: boolean;
}): BleSessionClassification {
  if (args.connected === false) {
    return { kind: 'unknown', services: [], deviceName: args.deviceName, reason: 'GATT not connected' };
  }
  const uuids = args.services.map((s) => s.toLowerCase());
  const has = (u: string): boolean => uuids.includes(u.toLowerCase());

  const hasPartialFlash = has(SERVICE_UUIDS.partialFlash);
  const hasDfu = has(SERVICE_UUIDS.nordicDfu);
  const hasUart = has(SERVICE_UUIDS.uart);
  const isDfuTarg = /DfuTarg/i.test(args.deviceName ?? '');

  // Bootloader: advertised name flipped to "DfuTarg" AND the application's
  // CODAL services (partial-flash, UART) are absent. Device-info is optional
  // in the bootloader.
  if (isDfuTarg && !hasPartialFlash && !hasUart) {
    return {
      kind: 'dfu-bootloader',
      services: uuids,
      deviceName: args.deviceName,
      reason: 'name=DfuTarg, partial-flash/UART absent',
    };
  }
  // Stricter bootloader fingerprint when name isn't visible (some Chrome
  // versions hide the name post-rename): only Nordic DFU service is up.
  if (hasDfu && !hasPartialFlash && !hasUart && uuids.length <= 2) {
    return {
      kind: 'dfu-bootloader',
      services: uuids,
      deviceName: args.deviceName,
      reason: 'only Nordic DFU service visible',
    };
  }

  // Anything else with services visible is application mode. Open-mode
  // firmware never hides services behind a bond, so seeing UART or
  // partial-flash is the canonical "we're talking to a running app" signal.
  if (uuids.length > 0) {
    return {
      kind: 'app-mode',
      services: uuids,
      deviceName: args.deviceName,
      reason: hasPartialFlash && hasUart
        ? 'partial-flash + UART visible'
        : hasPartialFlash
        ? 'partial-flash visible'
        : hasUart
        ? 'UART visible'
        : 'services enumerated, app-mode assumed',
    };
  }

  return {
    kind: 'unknown',
    services: uuids,
    deviceName: args.deviceName,
    reason: 'no services enumerated',
  };
}

/** Async wrapper: pull the service list off the device and classify it.
 *  Tolerates GATT throwing — returns `unknown` rather than propagating.
 *
 *  Why this isn't a single `getPrimaryServices()` call:
 *  Web Bluetooth's `getPrimaryServices()` (no args) returns only the
 *  services that were in `optionalServices` AT THE TIME `requestDevice`
 *  WAS ORIGINALLY CALLED. If the user's per-origin permission was granted
 *  before we added a UUID to `EXTRA_OPTIONAL_SERVICES`, the bulk list
 *  silently omits it. Per-UUID probes catch those — Chrome still filters
 *  them through `optionalServices`, but at least each one is attempted
 *  individually so a positive result is meaningful.
 */
export async function classifyBleSessionFromDevice(
  device: BluetoothDevice,
): Promise<BleSessionClassification> {
  if (!device.gatt?.connected) {
    return {
      kind: 'unknown',
      services: [],
      deviceName: device.name,
      reason: 'GATT not connected',
    };
  }
  // Bulk enumeration — fast path, returns everything Chrome will expose
  // under the current per-origin permission.
  const seen = new Map<string, boolean>();
  try {
    const services = await device.gatt.getPrimaryServices();
    for (const s of services) seen.set(s.uuid.toLowerCase(), true);
  } catch {
    // Fall through to per-UUID probes — sometimes bulk fails on Windows
    // even when individual lookups succeed.
  }
  // Per-UUID confirmation for the services the classifier actually checks.
  const probeUuids = [
    SERVICE_UUIDS.partialFlash,
    SERVICE_UUIDS.uart,
    SERVICE_UUIDS.nordicDfu,
    SERVICE_UUIDS.deviceInfo,
  ];
  await Promise.all(probeUuids.map(async (uuid) => {
    if (seen.has(uuid)) return;
    try {
      await device.gatt!.getPrimaryService(uuid);
      seen.set(uuid, true);
    } catch {
      // NotFoundError / NetworkError — service genuinely not advertised, or
      // permission filter is hiding it. Either way we treat as 'not seen'.
    }
  }));
  return classifyBleSession({
    services: [...seen.keys()],
    deviceName: device.name,
    connected: true,
  });
}
