/**
 * A complete English label set — the fixture for `ui-labels.test.ts`. Typed as
 * the full `ConnectLabels`, so a key added without a translation here fails
 * the type check, and it doubles as a starting point for a host's own
 * English strings.
 */
import type { ConnectLabels } from '../src/ui/labels.ts';

export const EN_LABELS: ConnectLabels = {
  close: 'Close',
  dismiss: 'Hide',
  reconnect: 'Reconnect',
  serialConnect: 'Connect serial',
  pleaseWait: 'Please wait…',
  downloadFile: 'Download as a file',

  triggerTitle: 'Calliope mini connection',
  triggerPinned: 'window open',
  resize: 'Resize',
  notConnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  flashing: 'Transferring',
  error: 'Error',
  unsupported: 'Not supported',
  phaseCheck: 'Checking…',
  phaseReboot: 'Restarting…',
  phasePrepare: 'Preparing…',
  phaseFinalising: 'Finishing…',

  panelTitle: 'Calliope mini connection',
  pin: 'Pin as a window',
  unpin: 'Attach again',

  usb: 'USB',
  ble: 'Bluetooth',
  usbConnected: 'Transfer and communication',
  bleConnectedFull: 'Transfer and communication',
  bleConnectedCommOnly: 'Communication only',
  notSupportedUsb: 'USB not available',
  notSupportedBle: 'Bluetooth not available',
  unsupportedHint:
    'This browser has neither USB nor Bluetooth. Please use a Chromium browser (Chrome, Edge, Opera, Brave).',

  connect: 'Connect',
  disconnect: 'Disconnect',
  forget: 'Disconnect and forget',
  cancel: 'Cancel',

  serialPickHint:
    'USB 1/2 connected — now pick “CDC – COM x” to set up the data link (serial). ' +
    'Cancelling is fine: transferring programs works without it.',
  serialMissing: 'Ready to transfer — the serial data link is still missing.',

  bootloader: 'Bootloader',
  bootloaderTitle: 'Nordic DFU bootloader detected',
  patternHint: 'Draw the pattern your Calliope mini shows.',

  transferProgram: 'Transfer program',
  transferring: 'Transferring…',
  rearmInputs: 'Reconnect inputs',
  rearmingInputs: 'Reconnecting inputs…',

  flashVia: (t) => `Transfer via ${t === 'ble' ? 'Bluetooth' : 'USB'}`,
  partialFlash: 'Quick transfer',
  fullFlash: 'Full transfer',
  lastFlash: 'Last transferred',

  version: 'Version',
  connectedSince: 'Connected for',
  program: 'Program',
  programBlocks: 'Blocks runtime',
  runtimeVersion: 'Blocks version',
  outdated: 'outdated',

  appModeChip: 'via app',
  appModeWaiting: 'via app – waiting for Calliope',
  appModeConnecting: 'via app – connecting…',
  appModeConnected: 'via app – connected',

  errorBleUnsupported: 'Web Bluetooth is not supported in this browser.',
  errorBleFailed: 'Bluetooth connection failed — we keep trying.',
  errorBleDfuBootloader: 'The Calliope is in the DFU bootloader. Press reset to get back to the program.',
  errorBleRuntimeMismatch: "The runtime on the Calliope doesn't match the program — please do one full transfer over USB.",
  errorBleNoPartialFlashing: 'The Calliope is running without the partial-flashing service — transfer a MakeCode program over USB once.',
  errorBleHexNotFlashable: "This program can't be transferred over Bluetooth (no MakeCode marker).",
  errorBleFlashAborted: 'Transfer cancelled.',
  errorBleFlashFailedNoUsb:
    'Transfer over Bluetooth failed and USB is not available — please transfer a Bluetooth-capable ' +
    'program (hold A+B and press reset, then try again).',
  errorBleNeedsMini2:
    'This program needs 32 KB of RAM and only runs on the Calliope mini 2 — it cannot start ' +
    'on a Calliope mini 1.',
  errorBleNotBackAfterFlash:
    'The Bluetooth connection did not come back after the transfer. If your program does not turn ' +
    'on Bluetooth (e.g. MakeCode on mini 1, a radio program, or MicroPython on mini 1/2), hold ' +
    'A+B and press reset to start Bluetooth again.',
  errorBleUnknown: 'Unknown Bluetooth error.',
  errorUsbUnsupported: 'WebUSB is not supported in this browser.',
  errorUsbDeviceInUse: 'The Calliope is being used by another tab or program.',
  errorUsbInterrupted: 'The USB connection was briefly interrupted — please connect again.',
  errorUsbSessionLost: 'USB session lost — please connect again.',
  errorUsbTransferFailed: 'The USB transfer failed repeatedly — please unplug the USB cable briefly and plug it back in.',
  errorUsbNotReady: 'The USB connection is not ready yet — please wait a moment and try again.',
  errorUsbMini2Jlink:
    "The Calliope mini 2 (J-Link) can't be programmed over the standard USB route. " +
    'Please download the .hex file and drag it onto the Calliope drive.',
  errorUsbSerialUnsupported: 'Web Serial is not supported in this browser (needed for the Calliope mini 2).',
  errorUsbUnknown: 'Unknown USB error.',

  namePattern: ({ name }) => `Calliope pattern ${name}`,
  patternCell: ({ column, height }) => `Column ${column}, height ${height}`,

  bannerConnectingBle: 'Connecting via Bluetooth…',
  bannerConnectingApp: 'Connecting via the app…',
  bannerConnectedBoth: 'USB + Bluetooth connected',
  bannerConnectedUsb: 'USB connected',
  bannerConnectedBle: 'Bluetooth connected',
  bannerConnectedAny: 'Calliope mini connected',
  bannerFlashing: 'Transferring program…',
  bannerPhaseCheck: 'Checking…',
  bannerPhaseReboot: 'Restarting…',
  bannerPhasePrepare: 'Preparing…',
  bannerPhaseFinalising: 'Finishing…',
  bannerReconnecting: 'Connecting to the Calliope mini…',
  bannerReplugTitle: 'Reconnect the Calliope mini.',
  bannerReplugText:
    'Unplug the Calliope mini from the USB cable once and plug it back in — close other tabs ' +
    'using it if needed. Then click “Reconnect”.',
  bannerReloadTitle: 'That did not help.',
  bannerReloadText: 'Reload the page to reset the USB connection. Your Calliope mini stays connected.',
  bannerReloadButton: 'Reload page',
  bannerSerialPickTitle: 'USB connected (1/2)',
  bannerSerialPickText:
    'Now pick “CDC – COM x” to set up the data link (serial). Cancelling is fine: ' +
    'transferring programs works without it.',
  bannerNoConnectionTitle: 'No Calliope mini connected.',
  bannerNoConnectionText: 'Connect your Calliope mini by USB cable or Bluetooth to get started.',
  bannerUnsupportedTitle: 'Cannot connect.',
  bannerConnectUsb: 'Connect USB',
  bannerConnectBle: 'Connect Bluetooth',

  choiceTitle: 'Transfer program',
  choiceText: ({ fileName }) =>
    `The Calliope is not connected right now. Choose how ${fileName} gets onto the device.`,
  choiceBle: 'Via Bluetooth',
  choiceBleDetail: 'Wireless — the Calliope has to be switched on and in range.',
  choiceUsb: 'Via USB cable',
  choiceUsbDetail: 'Reliable, always works. Connect the cable to the Calliope and the computer.',
  choiceDownloadDetail: 'Save the .hex file and copy it onto the Calliope yourself.',

  usbPlugTitle: 'Connect the Calliope by USB',
  usbPlugStep1: 'Connect the USB cable to the Calliope.',
  usbPlugStep2: 'Click “Transfer” — the very first time, pick the Calliope in the browser dialog.',
  usbPlugConfirm: 'Transfer',

  bleOfflineTitle: 'Bluetooth is off on your Calliope right now',
  bleOfflineLead: 'A program without Bluetooth is probably running.',
  bleOfflineStepsNative: 'Here is how to continue:',
  bleOfflineStepsWeb: 'Two ways back:',
  bleOfflineResetTitle: 'Hold A + B and press Reset',
  bleOfflineResetHint:
    'The Calliope starts in DFU mode (the display shows a plus “+”, for example). Then click ' +
    '“Reconnect” below — we transfer a program with Bluetooth.',
  bleOfflineResetHintNative:
    'The Calliope starts in Bluetooth mode. We then reconnect automatically and transfer your program.',
  bleOfflineOr: 'or',
  bleOfflineUsbTitle: 'Plug in the USB cable',
  bleOfflineUsbHint: 'Always works, even without Bluetooth on the Calliope — and is much faster than BLE.',
  bleOfflineMacTitle: 'Still not working on a Mac?',
  bleOfflineMacHint:
    'macOS sometimes keeps an outdated Bluetooth pairing. Open System Settings → Bluetooth, ' +
    'click the “×” next to “Calliope mini” and connect again.',
  bleOfflineUseUsb: 'Use USB',
  bleOfflineAbort: 'Cancel connection',

  mini2FallbackTitle: 'USB transfer failed',
  mini2FallbackText: ({ fileName, attempts, drive }) =>
    `${fileName} could not be transferred to the Calliope mini 2 (${attempts} attempts). ` +
    `You can try again — or download the .hex file and drag it onto the ${drive} drive ` +
    `yourself, which always works.`,
  mini2FallbackRetry: 'Try again',
  mini2FallbackRetryDetail: 'Start the USB transfer again.',
  mini2FallbackDownloadDetail: 'Save the .hex file and drag it onto the “MINI” drive in your file manager.',
  details: 'Details',

  mini2SerialTitle: 'Connect serial?',
  mini2SerialText:
    'This editor can talk to the Calliope mini (serial). Your Calliope mini 2 is only connected ' +
    'for transferring so far — pick “CDC – COM x” in the next dialog to set up the data link.',
  later: 'Later',

  mini12Title: 'Which Calliope mini is this?',
  mini12Text: ({ fileName }) =>
    `${fileName} needs 32 KB of RAM and only runs on the Calliope mini 2. Over ` +
    `Bluetooth we cannot tell a mini 1 from a mini 2 — the version is printed on the ` +
    `back of the board.`,
  mini12Mini2Detail: '32 KB RAM — the transfer starts.',
  mini12Mini1Detail: '16 KB RAM — this program cannot run on it.',

  commsStream: 'Stream',
  commsRows: 'Rows',
  commsGraph: 'Graph',
  commsLive: 'Live',
  commsLiveTitle: 'Live sensor data (COMMAND/STATE/MOTION/ANALOG) — the latest value per type',
  commsPause: 'Pause',
  commsResume: 'Resume',
  commsClear: 'Clear',
  commsStreamLiveOnly: 'Only live polling so far — relevant events (commands, button presses) show up here.',
  commsStreamEmpty: 'Nothing sent or received yet.',
  commsLiveEmpty:
    'No live data yet. Sensor polling (STATE/MOTION/ANALOG) and the handshake (COMMAND) show up ' +
    'here — only the latest value per type.',
  commsRowsEmpty: ({ writeValue, print, mirror }) =>
    `No log lines detected yet. Send e.g. ${writeValue}, ${print} or use ${mirror}.`,
  commsTable: ({ index }) => `Table ${index}`,
  commsTableSize: ({ rows, columns }) => `${rows} rows, ${columns} columns`,
  commsCsv: 'Download CSV',
  commsTime: 'Time',
  commsNoValue: 'no value',
  commsTruncated: ({ shown, total }) => `Showing the last ${shown} of ${total} rows.`,
  commsGraphEmpty: ({ writeValue, print, mirror }) =>
    `Nothing to plot yet. Log numbers with ${writeValue}, ${print} or ${mirror}.`,
  commsGraphWaiting: 'Waiting for data points…',
  commsGraphNow: 'now',
};
