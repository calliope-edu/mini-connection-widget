# @calliope-edu/mini-connection-widget

Calliope mini connection layer on top of
[`@microbit/microbit-connection`](https://github.com/microbit-foundation/microbit-connection).
Adds Calliope hardware support, simultaneous USB+BLE tracking, automatic
flash routing, and a framework-agnostic store.

Status: **early — vanilla store API stable, UI widget not yet shipped.**

## What it does

- **Simultaneous USB and BLE** — both transports tracked independently with
  per-channel status, capability flags, device names, and errors.
- **Automatic flash routing** — `flashCalliope(hex)` picks BLE if it's
  connected and OS-paired (preserves the bond), otherwise USB, otherwise
  prompts for a USB cable.
- **Stale-bond detection** — distinguishes *never-paired* from *stale-bond*
  (typical after a USB full-flash) and surfaces a distinct error.
- **Smart picker recovery** — works around Chrome's "no devices" trap by
  clearing cached device state before showing the picker.
- **Framework-agnostic store** — Svelte-`subscribe`-compatible. Svelte uses
  `$store` directly; React `useSyncExternalStore`; Vue a watcher.

## Multi-platform

The underlying lib delegates BLE to
[`@capacitor-community/bluetooth-le`](https://github.com/capacitor-community/bluetooth-le)
and USB to WebUSB, so the same code runs across:

| Target | How |
|---|---|
| Web (browser) | Capacitor BLE plugin's web fallback → `navigator.bluetooth`; WebUSB direct |
| iOS app | Capacitor host + native CoreBluetooth |
| Android app | Capacitor host + native Android BluetoothManager |
| Tauri / Electron (desktop) | WebView's Web Bluetooth / WebUSB; Capacitor deps lie dormant |

## Install

Not published to npm — consume as a local checkout (link), submodule, or
vendored copy. With pnpm:

```jsonc
// app/package.json
{
  "dependencies": {
    "@calliope-edu/mini-connection-widget": "link:../mini-connection-widget",
    "@capacitor-community/bluetooth-le": "^7.3.0",
    "@capacitor/core": "^7.4.4",
    "@capacitor/filesystem": "^7.1.6",
    "@microbit/capacitor-community-nordic-dfu": "v7.0.0-microbit.4",
    "@microbit/microbit-connection": "1.0.0-beta.1"
  },
  "pnpm": {
    "patchedDependencies": {
      "@microbit/microbit-connection@1.0.0-beta.1":
        "../mini-connection-widget/patches/@microbit__microbit-connection@1.0.0-beta.1.patch"
    }
  }
}
```

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

initializeCalliopeConnection();         // once at app startup

await connectCalliope('usb');           // both transports can be open
await connectCalliope('ble');

await flashCalliope(hexString);         // auto-routed
const unsub = onSerialLine((line) => console.log(line));
```

### Public API

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

## Patches

A single `pnpm patch` on top of `@microbit/microbit-connection` carries four
Calliope-specific fixes. Patch file:
[`patches/@microbit__microbit-connection@1.0.0-beta.1.patch`](./patches).

| Patch | Why |
|---|---|
| Segger J-Link VID/PID in USB picker defaults | Calliope mini 1/2 ship J-Link instead of DAPLink — upstream's hardcoded micro:bit VID/PID would hide them. |
| `Calliope mini` namePrefix in BLE picker | Upstream only lists `BBC micro:bit` and `uBit`. |
| `partialFlashing` UUID in BLE optionalServices | Web Bluetooth requires every service to be declared at `requestDevice` time; upstream omits the partial-flashing UUID. |
| Lenient `getBoardVersion` | Upstream throws on any model number that isn't `BBC micro:bit`/`BBC micro:bit v2`. Calliope reports `Calliope mini V2`/`V3`. Patched to accept `calliope mini` / `v2` substrings and default to `V2` on unknown strings. |

Generic improvements that don't depend on Calliope hardware are PR
candidates for upstream rather than patches; the patch set should shrink
over time.

### Updating the upstream lib

A walkthrough — happy path first, conflicts at the bottom.

1. **Diff first.** Locally clone `microbit-foundation/microbit-connection`
   (or use GitHub's compare view) and check whether the new release touches
   any of the files we patch: `build/*/usb/connection.js`,
   `build/*/bluetooth/connection.js`,
   `build/*/bluetooth/services/device-information-service.js`.

2. **Bump the version string.** A single find-and-replace over both
   `package.json` files swaps the dep version *and* the
   `patchedDependencies` key (the key embeds the version too).

3. **Rename the patch file** so its filename tracks the new version. The
   README references it by name in one place — same find-and-replace
   catches it. Use `git mv` so history is preserved.

4. **`pnpm install`** in both projects. pnpm pulls the new tarball, applies
   the renamed patch, fails loudly if any hunk doesn't apply.

5. **Type-check, commit, push.**

If `pnpm install` reports a hunk failure (upstream changed a file we
patch):

1. `pnpm patch @microbit/microbit-connection@<new-version>` extracts a
   fresh editable copy. pnpm fuzzy-applies hunks where it can and leaves
   `.rej` files for the conflicts.
2. Open the conflicted file(s), merge our edit against the new upstream
   code by hand.
3. `pnpm patch-commit <path>` regenerates the patch file.
4. Resume from step 4 above.

## Roadmap

1. **Web component widget** — Svelte-built `<calliope-mini-connection>`
   element so any framework can mount the status panel without owning
   Svelte.
2. **Capacitor mobile shells** — ship as iOS/Android apps. Native-bonded
   BLE handles the "macOS can't see Calliope in pairing mode" and "stale
   OS bond after USB flash" pain points the web version works around.
3. **Upstream PRs** for the generic bits of our patch (configurable name
   prefixes, configurable USB VID/PID filters, opt-in lenient model-number
   parsing).
4. **Read the on-device data log over BLE** — the MicroBit Utility Service
   (`e95d0001…`) already exposes the flash log; the widget just needs a client.
   Protocol + plan written up in
   [`docs/ble-datalogger-readback.md`](./docs/ble-datalogger-readback.md).

## License

MIT
