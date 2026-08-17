# @calliope-edu/mini-connection-widget

Calliope mini connection layer on top of
[`@microbit/microbit-connection`](https://github.com/microbit-foundation/microbit-connection).
Adds Calliope hardware support, simultaneous USB+BLE tracking, automatic
flash routing, and a framework-agnostic store.

Status: **vanilla store API stable; the Svelte 5 UI ships — see
[Host contract](#host-contract) for what a consumer must mount.**

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

Not published to npm — consume as a git pin (what both shipping apps do), a
local checkout (`link:`), or a vendored copy. With pnpm:

```jsonc
// app/package.json
{
  "dependencies": {
    // Pin an exact commit. calliope-campus and Teachable both do this; a
    // superrepo overlay can rewrite it to workspace:* for local widget work.
    "@calliope-edu/mini-connection-widget":
      "github:calliope-edu/mini-connection-widget#<full-sha>",
    "@capacitor-community/bluetooth-le": "^7.3.0",
    "@capacitor/core": "^7.4.4",
    "@capacitor/filesystem": "^7.1.6",
    "@microbit/capacitor-community-nordic-dfu": "v7.0.0-microbit.4",
    "@microbit/microbit-connection": "1.0.0-beta.1"
  },
  "pnpm": {
    "patchedDependencies": {
      // Copy the patch out of this repo's patches/ into your own patches/.
      // A path into the widget checkout only resolves when it is a sibling.
      "@microbit/microbit-connection@1.0.0-beta.1":
        "patches/@microbit__microbit-connection@1.0.0-beta.1.patch"
    }
  }
}
```

### Vite setup

This package ships **unbuilt source** — its entry is `src/index.ts` and it
imports `.svelte` files, which esbuild has no loader for. Two settings are
required, and the second is easy to miss:

```js
// vite.config.js
optimizeDeps: {
  // Without this the dep optimizer tries to prebundle the widget and fails.
  exclude: ['@calliope-edu/mini-connection-widget'],
  // Excluded means Vite never crawls the widget's imports, so its transitive
  // deps go un-prebundled too. nrf-intel-hex (MemoryMap, used by four widget
  // modules) ships a UMD `browser` build with no ESM exports, which Vite
  // prefers over its `module` entry — the import then dies with "does not
  // provide an export named 'default'". Force-include it.
  include: ['nrf-intel-hex'],
},
// Only when consuming the widget from a checkout outside node_modules:
server: { fs: { allow: ['..'] } },
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

### Core API

`src/index.ts` is the full surface; these are the pieces every host touches.

```ts
// Stores (Svelte-`subscribe` compatible)
calliopeState: Readable<CalliopeState>
calliopeLog: Readable<CalliopeLogEntry[]>
calliopeUsbPlugRequest: Readable<UsbPlugRequest | null>

// Actions
initializeCalliopeConnection(): void
connectCalliope(transport?: 'usb' | 'ble', forceChooser?: boolean, nameFilter?: string): Promise<void>
disconnectAndForget(transport: 'usb' | 'ble'): Promise<void>
flashCalliope(hex: string, name?: string, preferredTransport?: 'usb' | 'ble', opts?: FlashOptions): Promise<void>
sendSerialLine(line: string): Promise<void>
onSerialLine(cb: (line: string) => void): () => void
clearCalliopeLog(): void
// Save a hex to the downloads folder — also what a host should use for
// MakeCode's "Als Datei herunterladen" (see Host contract). Don't hand-roll
// it: revoking the object URL right after click() can cancel the download.
downloadHexFile(hex: string, name: string): void
```

## Host contract

The Svelte UI is **not** self-mounting. Each modal below is a singleton driven
by a store that carries a pending promise or callback, so a modal the host
doesn't render is a flow that dead-ends. Mount all of them once, app-wide:

```svelte
<ConnectionBanner container={someElement} />
<UsbPlugRequestModal />
<ConnectionChoiceModal />
<BleOfflineModal />
<Mini2FlashFallbackModal />
<Mini2SerialOfferModal />
<Mini12VersionModal />
```

| Component | Omitting it means |
|---|---|
| `ConnectionChoiceModal` | `flashCalliope()` awaits `awaitConnectionChoice()` when nothing is connected. **No modal → the flash hangs forever.** |
| `ConnectionBanner` | The only component that reaches `confirmReplug()`. A dropped USB link sits on "reconnecting" with no way out. Also owns the connect prompt and the post-reload recovery resume. |
| `Mini2FlashFallbackModal` | A failed mini 2 USB transfer has no retry / download-instead exit. |
| `Mini2SerialOfferModal` | A mini 2 linked flash-only never gets its CDC port offered. |
| `Mini12VersionModal` | The BLE RAM-fit gate can't ask mini 1 vs mini 2 and cancels the flash. |
| `UsbPlugRequestModal` | The "plug in the cable" prompt never appears. |
| `BleOfflineModal` | No A+B+Reset guidance when BLE can't be reached. |

A host is free to render its own component off the same store instead — campus
substitutes its own `ConnectionChoiceModal` so the card matches its other
modals. What isn't optional is that *something* resolves each request.

**Banner placement.** By default the banner is a fixed top-centre toast at
`z-index: 8000`. If your app has a header above that, pass `container` — an
element with `position: relative` — and the banner positions itself inside it
instead.

**App mode.** Inside the iOS / Android shells (`calliopeState.nativeMode`, set
once at load from the injected native bridge) the host app owns the connection,
so the widget drops every affordance that would let the user steer it:
`ConnectButton` renders nothing at all — no trigger, hence no panel and no
floating window — and the banner's "Verbinde…" state offers only the X, no
"Abbrechen". The banner is the whole UI surface in app mode. Hosts don't need
to branch on this; keep mounting the same components.

### Host-declared context

Owner-gated setters: pass a stable owner id, clear with the same id on unmount.
A clear from a stale owner is a no-op, so editor switches are race-free.

```ts
setConnectionUiActive(true)                    // a device is relevant here → banner may prompt
setTransferProgram(owner, { run })             // renders the panel's "Programm übertragen"
setSerialConsumer(owner, true)                 // this view reads serial → enables the mini 2 offer
setBannerExtra({ id, tone, title, action })    // host-specific banner content
setBannerContainer(el)                         // alternative to the `container` prop
setDapOwner('blocks' | 'makecode' | null)      // arbitrates the shared CMSIS-DAP bus
setBleFlashEnabled(false)                      // BLE stays comms-only; USB + download for flashing
setUsbPickerAllDevices(true)                   // dev escape hatch: drop USB picker filters
```

### Gotchas

- **`status === 'connected'` is not "serial works".** The rollup also reports
  connected for a mini 2 linked flash-only (`jlinkUsbStatus` up, no CDC port).
  Gate serial writes on `usbStatus` / `jlinkSerialStatus` / `bleStatus` — the
  three transports `sendSerialLine` actually routes over.
- **The UI is German-only below the label layer.** `ConnectLabels` /
  `mergeLabels` cover `ConnectButton` and `ConnectionPanel`, via props. The
  banner and all six modals hardcode German with no label hook, so a host with
  its own i18n currently has to fork a component to translate it.

## MakeCode host (`/makecode` subpath)

Everything needed to embed `makecode.calliope.cc` as a `controller=2` iframe and
wire it to the connected mini. It lives behind a subpath so the main entry stays
free of the `@microbit/makecode-embed` peer dependency — apps that don't embed
MakeCode never pull it in.

```ts
import {
  createMakeCodeDriver,
  makeCodeIframeUrl,
  makeCodeEditorOrigin,
  createSerialMonitorBridge,
  JacdacHost,
  MakeCodeToolbar,
  MakeCodeShareModal,
} from '@calliope-edu/mini-connection-widget/makecode';
```

| Module | What it covers |
|---|---|
| `driver` | `MakeCodeFrameDriver` lifecycle. Compiled hexes route to `flashCalliope` (Download) and `downloadHexFile` ("Download as file") unless the host overrides them. |
| `iframe-url` | The editor URL, including the `parentOrigin` param that puts the host in pxt's `_allowedOrigins` — without it the editor silently drops every `messagepacket` the host posts. |
| `project` | Pure pxt.json helpers: Calliope headers, extension list/remove, `v1`/`v2`/`v3` board revision, structural validation. |
| `serial-bridge` | Device serial → the editor's serial monitor, as the same `{type:'serial'}` message pxt's own reader posts. Declares `setSerialConsumer` so a flash-only mini 2 gets the widget's serial offer, and pauses while the Blocks LIVE runtime owns the link. |
| `jacdac-host` | Jacdac frames between the device and pxt's Jacdac message simulator. |
| `ui/` | `MakeCodeToolbar` + `MakeCodeShareModal`, themed through `--mkc-*` custom properties and translated through `MakeCodeLabels`. |

The host still owns program storage, workspace-sync policy and program
switching — those differ per app and deliberately stay in the app.

**Feeding the simulator.** `sendSerialLineToEditor` posts a line the editor's
serial monitor always shows, but the running simulator only receives it on a pxt
carrying the `simdriver` fix that forwards non-`sim` serial messages to the
simulator frames (upstream drops them: `case 'serial': break`). The Calliope
target additionally needs `SerialState.receiveData` to actually buffer the
payload and raise `MICROBIT_SERIAL_EVT_DELIM_MATCH`.

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
5. **Labels for the banner + modals.** `ConnectLabels` only reaches
   `ConnectButton` / `ConnectionPanel`, and only through props — the
   host-rendered singletons have no hook at all, which is why campus forked
   `ConnectionChoiceModal` to translate it. A module-level `setConnectLabels()`
   registry would cover every component including the singletons. ~60–80 new
   keys across the banner and six modals; the consumer that needs it most is
   Teachable (de/en/fr/es/it/el with a language picker, German connection UI).

## License

MIT
