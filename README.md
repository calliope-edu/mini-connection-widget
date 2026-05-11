# @calliope-edu/mini-connection-widget

High-level Calliope mini connection orchestration on top of
[`@microbit/microbit-connection`](https://github.com/microbit-foundation/microbit-connection),
with a small set of Calliope-specific patches applied to the upstream lib.

Status: **early — vanilla store API stable, UI widget not yet shipped.**

## What this is

`@microbit/microbit-connection@1.0.0-beta.0` provides the GATT layer (WebUSB,
Web Bluetooth, native iOS/Android BLE via Capacitor, partial flashing,
status events). This package sits one level up and orchestrates everything
an app actually needs to talk to a Calliope mini:

- **Simultaneous USB and BLE** — both transports tracked independently, with
  per-channel status, capability flags (`bleCanFlash`, `bleCanCommunicate`),
  device names, and error messages. A UI can show "Flashen & Kommunikation"
  on USB and "Nur Kommunikation" on BLE at the same time.
- **Stale-bond detection** — when the OS still holds a BLE bond but the
  Calliope has forgotten its whitelist (typical after a USB full-flash),
  authenticated services are unreachable. The package distinguishes
  *never-paired* from *stale-bond* (using `DeviceError.code ===
  'pairing-information-lost'` plus a `uartWrite` probe) and surfaces a
  distinct error so the app can prompt OS-side re-pairing.
- **Automatic flash routing** — `flashCalliope(hex)` picks the right
  transport: BLE if it's connected and OS-paired (preserves the bond);
  otherwise USB; otherwise prompts the user to plug in. No mode toggle for
  the user to manage. USB-flash-then-warn-about-BLE-pairing-loss is built in.
- **Smart picker recovery** — Chrome's Web Bluetooth picker stops scanning
  after a few back-to-back failed attempts. The connect-then-`clearDevice`
  sequence side-steps the bug.
- **Framework-agnostic store** — `calliopeState`, `calliopeLog` etc. expose
  a Svelte-`subscribe`-compatible contract. Svelte uses `$store` directly;
  React uses `useSyncExternalStore`; Vue uses a watcher; vanilla JS calls
  `.subscribe(fn)`.

## Multi-platform reach

Because the underlying lib delegates BLE to
[`@capacitor-community/bluetooth-le`](https://github.com/capacitor-community/bluetooth-le)
and USB to WebUSB, the same code path runs across:

| Target | How |
|---|---|
| Web (browser tab) | Capacitor BLE plugin's web fallback → `navigator.bluetooth`; WebUSB direct |
| iOS app | Capacitor host + native CoreBluetooth (real OS pairing UI, robust against macOS visibility quirks) |
| Android app | Capacitor host + native Android BluetoothManager |
| Tauri / Electron / NW.js (desktop) | WebView's Web Bluetooth / WebUSB; Capacitor deps lie dormant in fallback mode |

For native targets you also get `BondMode` semantics (`pairing` /
`application` / `none`) — useful because flashing requires pairing-mode
bonding while live-data streaming wants the app-mode firmware path.

## Install

This package isn't published to npm. Consume it as a local checkout (link),
git submodule, or vendored copy. With pnpm:

```jsonc
// app/package.json
{
  "dependencies": {
    "@calliope-edu/mini-connection-widget": "link:../mini-connection-widget",
    "@capacitor-community/bluetooth-le": "^7.3.0",
    "@capacitor/core": "^7.4.4",
    "@capacitor/filesystem": "^7.1.6",
    "@microbit/capacitor-community-nordic-dfu": "v7.0.0-microbit.4",
    "@microbit/microbit-connection": "1.0.0-beta.0"
  },
  "pnpm": {
    "patchedDependencies": {
      "@microbit/microbit-connection@1.0.0-beta.0":
        "../mini-connection-widget/patches/@microbit__microbit-connection@1.0.0-beta.0.patch"
    }
  }
}
```

The Capacitor packages are peer dependencies of `@microbit/microbit-connection`.
On the web they include browser fallbacks; on Capacitor-hosted iOS/Android
apps they bind to native code.

## Patches

We ship a `pnpm patch` on top of `@microbit/microbit-connection@1.0.0-beta.0`
with four small, Calliope-specific fixes. The patch lives in
[`patches/@microbit__microbit-connection@1.0.0-beta.0.patch`](./patches) and
is referenced by both this package and the consuming app's
`pnpm.patchedDependencies`.

| Patch | File | Reason |
|---|---|---|
| Segger J-Link VID/PID in USB picker defaults | `build/*/usb/connection.js` | Calliope mini 1/2 ship Segger J-Link instead of DAPLink. Upstream's hardcoded `0x0d28/0x0204` filter would hide them from the WebUSB picker. |
| Calliope `namePrefix` in BLE picker defaults | `build/*/bluetooth/connection.js` | Upstream only lists `BBC micro:bit` and `uBit` namePrefixes. Calliope mini advertises as `Calliope mini [name]`. |
| `partialFlashing` UUID in BLE optionalServices | `build/*/bluetooth/connection.js` | Web Bluetooth requires every service we'll access later to be declared at `requestDevice` time. Upstream omits the partial-flashing UUID, which prevents web BLE flashing from reaching the service. |
| Lenient `getBoardVersion` | `build/*/bluetooth/services/device-information-service.js` | Upstream throws on any model number that isn't exactly `BBC micro:bit` or contains `BBC micro:bit v2`. Calliope mini reports `Calliope mini V2`/`V3`, which would abort every BLE connect. Patched to accept `calliope mini` / `v2` substrings and default to `V2` on unknown strings rather than throwing. |

If/when upstream lands equivalent support (e.g. via configurable filters or
a peer-device extension hook), the patch shrinks accordingly. Generic
improvements that don't depend on Calliope hardware are PR candidates for
upstream rather than patches.

## Usage

```ts
import {
  calliopeState,
  connectCalliope,
  disconnectAndForget,
  flashCalliope,
  initializeCalliopeConnection,
  sendSerialLine,
  onSerialLine,
} from '@calliope-edu/mini-connection-widget';

// Once at app startup. Silent USB reconnect + paired-device probe.
initializeCalliopeConnection();

// User clicks Connect (USB or BLE). Both can be open simultaneously.
await connectCalliope('usb');
await connectCalliope('ble');

// In a Svelte component:
//   $: ({ usbStatus, bleStatus, bleCanFlash, bleStaleBond } = $calliopeState);

// Flash a hex — auto-routed to BLE-if-paired, else USB, else USB-plug prompt.
await flashCalliope(hexString, 'My Project');

// Stream serial lines from the board.
const unsub = onSerialLine((line) => console.log(line));
```

## Public API

```ts
// Stores (Svelte-`subscribe` compatible)
calliopeState: Readable<CalliopeState>
calliopeLog: Readable<CalliopeLogEntry[]>
calliopeBlePairingInfo: Readable<boolean>
calliopeUsbPlugRequest: Readable<UsbPlugRequest | null>

// Actions
initializeCalliopeConnection(): void
connectCalliope(transport: 'usb' | 'ble', forceChooser?: boolean): Promise<void>
disconnectAndForget(transport: 'usb' | 'ble'): Promise<void>
flashCalliope(hex: string, name?: string): Promise<void>
sendSerialLine(line: string): Promise<void>
onSerialLine(cb: (line: string) => void): () => void
clearCalliopeLog(): void
showBlePairingInfo(): void
dismissBlePairingInfo(): void
```

## Roadmap

1. **Web component widget** — Svelte-built `<calliope-mini-connection>`
   element so any framework (React, Vue, vanilla, Tauri…) can mount the
   status panel without owning Svelte. Same store, same actions, just UI.
2. **Capacitor mobile shells** — drop the existing source into an Ionic/
   Capacitor project, ship as iOS/Android apps. Native-bonded BLE handles
   the "macOS can't see Calliope in pairing mode" + "stale OS bond after
   USB flash" pain points the web version has to work around.
3. **Upstream PRs** for generic improvements (configurable name-prefix
   filters, configurable USB VID/PID filters, opt-in lenient model-number
   parsing) so the patch set shrinks over time.

## License

MIT
