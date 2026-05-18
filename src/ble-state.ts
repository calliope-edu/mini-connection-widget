/**
 * Post-connect classifier for a Calliope BLE session.
 *
 * Web Bluetooth's `gatt.connect()` returns `connected = true` as soon as the
 * LL link is up — *before* any encryption upgrade or SMP exchange. So that
 * flag alone isn't enough to know whether we can actually flash. We have to
 * look at the GATT database to infer the device's mode (application / pair /
 * bootloader) and whether the link is encrypted.
 *
 * `getPrimaryServices()` is read-only — it queries Chrome's cached service
 * discovery and does **not** trigger encryption. It's the safest probe we
 * have. The classifier is split from the GATT call so the decision logic is
 * unit-testable without a real device.
 *
 * Caveat: on some CODAL builds, auth-required services are hidden from the
 * unencrypted GATT view. If true, `pair-mode` (in-pairing, unencrypted) and
 * `unencrypted-app-mode` (no/stale bond) produce the same fingerprint —
 * `partial`. In that case we can't tell them apart from service enumeration
 * alone; the next user action (flash → encrypted op) is the signal that
 * separates them, and our existing error classifier routes accordingly.
 */

export type BleSessionKind =
  /** Full CODAL service set visible — bond is good, link is encrypted, flash will work. */
  | 'bond-ok'
  /** Device is in Nordic DFU bootloader. Name is `DfuTarg`, only `0xFE59` is exposed. */
  | 'dfu-bootloader'
  /** Partial service set: either pair-mode-pre-bond or app-mode-without-bond.
   *  The user's next encrypted op tells us which. */
  | 'partial'
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

  // Bootloader fingerprint: name flips to "DfuTarg" AND the application's
  // CODAL services (partial-flash, UART) are gone. The device-info service
  // is optional in the bootloader so we don't require it.
  if (isDfuTarg && !hasPartialFlash && !hasUart) {
    return {
      kind: 'dfu-bootloader',
      services: uuids,
      deviceName: args.deviceName,
      reason: 'name=DfuTarg, partial-flash/UART absent',
    };
  }
  // Stricter bootloader fingerprint when name isn't visible (some Chrome
  // versions hide the name post-rename): DFU service present, application
  // services absent.
  if (hasDfu && !hasPartialFlash && !hasUart && uuids.length <= 2) {
    return {
      kind: 'dfu-bootloader',
      services: uuids,
      deviceName: args.deviceName,
      reason: 'only Nordic DFU service visible',
    };
  }

  // Healthy app-mode bond: the canonical CODAL services come through. UART
  // alone isn't enough (some firmware exposes UART pre-bond); partial-flash
  // is the strongest "bond is encrypted" signal because it's authenticated
  // on all CODAL builds.
  if (hasPartialFlash && hasUart) {
    return {
      kind: 'bond-ok',
      services: uuids,
      deviceName: args.deviceName,
      reason: 'partial-flash + UART visible',
    };
  }

  if (uuids.length > 0) {
    return {
      kind: 'partial',
      services: uuids,
      deviceName: args.deviceName,
      reason: hasPartialFlash
        ? 'partial-flash visible but UART missing — likely pre-encryption'
        : 'auth-required CODAL services hidden — likely pre-bond or pair-mode',
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
 *  silently omits it — making the classifier wrongly conclude "auth
 *  services hidden" on perfectly-bonded devices.
 *
 *  Workaround: pair the bulk call with per-UUID `getPrimaryService(uuid)`
 *  probes for the services we care about. Per-UUID calls suffer the same
 *  optionalServices filter, but the negative result is much more
 *  meaningful — an `NotFoundError` from `getPrimaryService(partialFlash)`
 *  on a device that exposes it means the permission filter is the
 *  problem, not the bond. We can then up-vote to `bond-ok` based on the
 *  union of bulk + individual probes.
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
  // Chrome's optionalServices filter applies here too, but at least we
  // attempt each one — if any one of them slips through we add it to the
  // seen set, and a single positive can up-vote 'partial' → 'bond-ok'.
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
