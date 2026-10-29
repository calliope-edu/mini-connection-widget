/**
 * MakeCode host integration — everything a Svelte app needs to embed
 * makecode.calliope.cc as a controller=2 iframe and wire it to the connected
 * Calliope mini.
 *
 * Imported as `@calliope-edu/mini-connection-widget/makecode` so the main entry
 * stays free of the `@microbit/makecode-embed` peer dependency: apps that don't
 * embed MakeCode never pull it in.
 *
 * The host still owns its own program storage, workspace-sync policy and
 * program-switch strategy — those differ per app and deliberately stay there.
 */

export {
  createMakeCodeDriver,
  type CreateDriverOptions,
  type DriverHandle,
  type MakeCodeDownload,
  type MakeCodeMode,
  type MakeCodeProject,
  type ShareResult,
} from './driver';

export {
  makeCodeIframeUrl,
  makeCodeEditorOrigin,
  type MakeCodeIframeUrlOptions,
} from './iframe-url';

export {
  CALLIOPE_TARGET,
  CALLIOPE_TARGET_VERSION,
  createCalliopeHeader,
  randomHeaderId,
  parseExtensions,
  removeExtension,
  getHardwareVersion,
  setHardwareVersion,
  isStructurallyValidProject,
  type CalliopeHardwareVersion,
  type CreateHeaderOptions,
  type MakeCodeExtension,
  type MakeCodeProjectLike,
} from './project';

export {
  createSerialMonitorBridge,
  sendSerialLineToEditor,
  type SerialMonitorBridge,
  type SerialMonitorBridgeOptions,
} from './serial-bridge';

export {
  JacdacHost,
  type JacdacHostOptions,
  type JacdacLogDirection,
  type JacdacLogLevel,
} from './jacdac-host';

export { default as MakeCodeToolbar } from './ui/MakeCodeToolbar.svelte';
export { default as MakeCodeShareModal } from './ui/MakeCodeShareModal.svelte';
export { default as Popover, closeAllPopovers } from './ui/Popover.svelte';

export {
  DEFAULT_MAKECODE_LABELS,
  mergeMakeCodeLabels,
  type MakeCodeLabels,
} from './ui/labels';
