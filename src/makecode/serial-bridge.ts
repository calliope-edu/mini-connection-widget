/**
 * Serial bridge between the connected Calliope mini and an embedded MakeCode
 * editor.
 *
 * In controller=2 the widget owns the device exclusively, so pxt can never open
 * its own serial port — its in-editor serial monitor would stay empty forever.
 * We forward the device's serial lines into the iframe as the SAME
 * `{type:"serial"}` window message pxt's own USB/DAPLink reader posts internally
 * (app.tsx `initPacketIO`): pxt's serial monitor and its "Show data" indicator
 * listen on a raw, origin-unchecked window 'message' handler and route on
 * `msg.type` alone. With `sim` omitted the line is treated as coming from the
 * DEVICE monitor — the "Show data — Device" badge appears on the first line, and
 * the panel replays up to 1000 buffered lines when opened.
 *
 * The same message shape is how a host feeds serial *into* the simulator (see
 * {@link sendSerialLineToEditor}). Note that requires a pxt carrying the
 * simdriver fix that forwards non-`sim` serial messages to the simulator frames;
 * against an unpatched editor those messages reach the monitor only.
 */
import { onSerialLine } from '../serial';
import { setSerialConsumer } from '../mini2-serial';
import { calliopeState } from '../state';
import { get } from '../store';

/** pxt's `SimulatorSerialMessage`, in the shape a host is allowed to post. */
interface HostSerialMessage {
  type: 'serial';
  id: string;
  data: string;
}

function postSerial(
  iframe: HTMLIFrameElement | null,
  origin: string,
  id: string,
  data: string,
): boolean {
  const target = iframe?.contentWindow;
  if (!target) return false;
  if (!origin || origin === '*') {
    // A wildcard would leak device I/O to any cross-origin frame.
    console.warn('[makecode] serial bridge has no concrete origin; dropping line');
    return false;
  }
  target.postMessage({ type: 'serial', id, data } satisfies HostSerialMessage, origin);
  return true;
}

/**
 * Push one line at the editor — the serial monitor always, the running
 * simulator too on a patched pxt. `line` is sent verbatim except for a trailing
 * newline, which pxt's line buffering needs.
 */
export function sendSerialLineToEditor(
  iframe: HTMLIFrameElement | null,
  origin: string,
  line: string,
  deviceId = 'calliope',
): boolean {
  const data = line.endsWith('\n') ? line : `${line}\n`;
  return postSerial(iframe, origin, deviceId, data);
}

export interface SerialMonitorBridgeOptions {
  /** Read at post time, so the bridge survives the iframe element changing. */
  iframe: () => HTMLIFrameElement | null;
  /**
   * Concrete editor origin (`makeCodeEditorOrigin(baseUrl)`). Never '*'.
   */
  origin: string;
  /**
   * Owner key for `setSerialConsumer`. Declaring interest is what makes the
   * widget offer "Serial verbinden?" for a Calliope mini 2 that is connected
   * flash-only (J-Link without the CDC port) — the editor's serial monitor is
   * exactly such a consumer. Omit to not declare interest.
   */
  consumerId?: string;
  /** The `id` pxt tags the lines with. Defaults to 'calliope'. */
  deviceId?: string;
  /**
   * Skip forwarding while the Blocks LIVE runtime is on the device. That mode
   * multiplexes binary Blocks-protocol frames over the same serial link, which
   * would render as garbage in the monitor. Normal flashed programs probe as
   * 'unknown' and emit plain serial.writeLine/writeValue text. Defaults to true.
   */
  skipWhileBlocksRuntime?: boolean;
}

export interface SerialMonitorBridge {
  dispose: () => void;
}

/**
 * Start forwarding device serial into the editor. Safe to call before a device
 * is connected — `onSerialLine` simply never fires until one is.
 */
export function createSerialMonitorBridge(
  opts: SerialMonitorBridgeOptions,
): SerialMonitorBridge {
  const deviceId = opts.deviceId ?? 'calliope';
  const skipBlocks = opts.skipWhileBlocksRuntime ?? true;

  if (opts.consumerId) setSerialConsumer(opts.consumerId, true);

  const unsubscribe = onSerialLine((line) => {
    if (skipBlocks && get(calliopeState).programType === 'blocks') return;
    sendSerialLineToEditor(opts.iframe(), opts.origin, line, deviceId);
  });

  return {
    dispose: () => {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      if (opts.consumerId) setSerialConsumer(opts.consumerId, false);
    },
  };
}
