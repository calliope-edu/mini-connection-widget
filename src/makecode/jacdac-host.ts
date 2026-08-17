/**
 * Parent-side Jacdac bridge for an embedded MakeCode (pxt) editor.
 *
 * When a project uses the pxt-jacdac extension, pxt spawns its Jacdac "message
 * simulator" iframe and relays Jacdac frames to/from the host over the pxt
 * simulator `messagepacket` channel (verified against jacdac-ts
 * `iframebridgeclient.ts` and pxt `pxtsim/simdriver.ts` + `embed.ts`):
 *
 *   editor → host:  { type:'messagepacket', channel:'jacdac', broadcast:true,
 *                     data:Uint8Array, sender:'bridge…' }  // frame to TX to the device
 *   host → editor:  { type:'messagepacket', channel:'jacdac', broadcast:true,
 *                     data:Uint8Array }                     // frame received FROM the device
 *
 * Because the widget owns the physical device exclusively (controller=2), the
 * HOST — not the iframe — moves the frames: outbound via `sendJacdacFrame`,
 * inbound via `onJacdacFrame`. The wire protocol differs from the Blocks
 * editor's remote host on two counts:
 *   - `data` is a RAW `Uint8Array` — NOT base64 (the opposite of the Blocks
 *     host, which base64-encodes). A structured-clone hop can occasionally hand
 *     back a plain object / ArrayBuffer, so {@link JacdacHost.coerceFrame}
 *     accepts all forms.
 *   - We never set/restamp `sender` on frames we post to the editor: jacdac-ts's
 *     IFrameBridgeClient ignores any inbound messagepacket whose `sender` equals
 *     its own bridgeId (its loop-prevention). Leaving `sender` unset marks the
 *     frame as device-originated so the bridge accepts it.
 *
 * Inert until a Jacdac program is on the device — frames simply never flow.
 */
import { onJacdacFrame, sendJacdacFrame } from '../jacdac';

const MESSAGE_TYPE = 'messagepacket';
const JACDAC_CHANNEL = 'jacdac';

interface JacdacMessage {
  type?: unknown;
  channel?: unknown;
  data?: unknown;
}

export type JacdacLogDirection = 'in' | 'out' | 'error' | 'info';
export type JacdacLogLevel = 'trace' | 'info' | 'warn';

export interface JacdacHostOptions {
  /** The pxt editor iframe to post device frames back to. */
  iframe: () => HTMLIFrameElement | null;
  /**
   * Concrete target origin for postMessage — the pxt editor origin
   * (`makeCodeEditorOrigin(baseUrl)`). Never '*': a wildcard would leak device
   * I/O to any cross-origin frame.
   */
  origin: string;
  /** Optional diagnostics sink. No-op when unset. */
  log?: (direction: JacdacLogDirection, message: string, level: JacdacLogLevel) => void;
}

export class JacdacHost {
  private iframeAccess: () => HTMLIFrameElement | null;
  private origin: string;
  private log: (d: JacdacLogDirection, m: string, l: JacdacLogLevel) => void;
  private frameUnsub: (() => void) | null = null;
  private disposed = false;
  /** Count of device→editor frames relayed, for the first-frames diagnostic. */
  private rxCount = 0;

  /**
   * Single Promise chain so device writes never overlap and stay ordered — the
   * widget's exchange buffer holds one outbound frame at a time, and Jacdac
   * frame ordering is significant.
   */
  private opQueue: Promise<void> = Promise.resolve();

  constructor(opts: JacdacHostOptions) {
    this.iframeAccess = opts.iframe;
    this.origin = opts.origin;
    this.log = opts.log ?? (() => {});
    // Stream device → editor. onJacdacFrame is inert (no-op unsubscribe) until
    // a Jacdac transport is up, so this is safe to wire eagerly.
    this.frameUnsub = onJacdacFrame((frame) => this.onDeviceFrame(frame));
  }

  /**
   * Dispatch a window message from the editor iframe. Returns true if it was a
   * Jacdac `messagepacket` we own (handled or deliberately dropped), false
   * otherwise so the caller can keep matching other message types.
   */
  handleMessage(data: unknown): boolean {
    const msg = data as JacdacMessage;
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type !== MESSAGE_TYPE || msg.channel !== JACDAC_CHANNEL) return false;
    const frame = this.coerceFrame(msg.data);
    if (frame) {
      this.log('in', `jacdac TX ${frame.length}B`, 'trace');
      this.enqueue(async () => {
        try {
          await sendJacdacFrame(frame);
        } catch (err) {
          this.log('error', `jacdac TX failed (silenced): ${(err as Error)?.message ?? err}`, 'warn');
        }
      });
    }
    return true;
  }

  /** Detach the device-frame listener. Called when the iframe unmounts. */
  dispose(): void {
    this.disposed = true;
    if (this.frameUnsub) {
      try {
        this.frameUnsub();
      } catch {
        /* ignore */
      }
      this.frameUnsub = null;
    }
  }

  // ---- internal -----------------------------------------------------------

  private enqueue(fn: () => Promise<void>): void {
    this.opQueue = this.opQueue.then(fn).catch(() => {
      /* errors already logged */
    });
  }

  private onDeviceFrame(frame: Uint8Array): void {
    if (this.disposed || !frame || frame.length === 0) return;
    const iframe = this.iframeAccess();
    if (!iframe?.contentWindow) return;
    if (!this.origin || this.origin === '*') {
      this.log('out', 'JacdacHost: no concrete origin configured; dropping device frame', 'warn');
      return;
    }
    // The first few device→editor frames log at info so the device→host
    // direction can be confirmed without enabling verbose logging. If these
    // appear but the Jacdac dashboard stays empty, the gap is in pxt's
    // editor→sim-frame delivery (upstream), not in our read.
    this.rxCount++;
    if (this.rxCount <= 5) {
      this.log('out', `jacdac RX #${this.rxCount} (${frame.length}B) → posted to editor`, 'info');
    } else {
      this.log('out', `jacdac RX ${frame.length}B`, 'trace');
    }
    // No `sender`: see the class doc — jacdac-ts drops messagepackets whose
    // sender is its own bridgeId, so device frames must arrive without one.
    iframe.contentWindow.postMessage(
      { type: MESSAGE_TYPE, channel: JACDAC_CHANNEL, broadcast: true, data: frame },
      this.origin,
    );
  }

  /**
   * pxt types `data` as a Uint8Array and structuredClone preserves that across
   * postMessage — but defend against a plain `{0:…,1:…}` object or an
   * ArrayBuffer/typed-array view in case a hop strips the wrapper.
   */
  private coerceFrame(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) return data.length ? data : null;
    if (data instanceof ArrayBuffer) return data.byteLength ? new Uint8Array(data) : null;
    if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      return v.byteLength ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
    }
    if (data && typeof data === 'object') {
      const nums = Object.values(data as Record<string, unknown>).filter(
        (n): n is number => typeof n === 'number',
      );
      return nums.length ? Uint8Array.from(nums) : null;
    }
    return null;
  }
}
