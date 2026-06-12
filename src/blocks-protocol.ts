/**
 * Blocks wire-protocol helpers for the pxt-blocks runtime.
 *
 * Two transports speak the same protocol over the wire:
 *   - BLE GATT — service `0b50f3e4-…-5c`, characteristic UUIDs `0b50_XXXX_…`,
 *     where the 16-bit `XXXX` is the channel ID (0x0100, 0x0101, …).
 *   - USB serial — framed packets with start byte `0xFF` (SFD) then
 *     `[req_type, ch_hi, ch_lo, len, ...data, chksum]`. Both ends of the
 *     link broadcast the same channel content on this frame format.
 *
 * The frame logic mirrors what the firmware (pxt-blocks BlocksSerial.cpp)
 * speaks, so the device doesn't care which transport we use. The embedded
 * blocks editor iframe always sends BLE-style UUIDs to the host; the host
 * translates them into either GATT calls or USB serial frames here.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn, registerSerialDataListener } from './usb';
import { appendLog } from './log';
import { pushProxy, setBlocksFramingUsbActive } from './comms';
import {
  BLOCKS_REQ,
  BLOCKS_RES,
  BlocksFrameParser,
  type BlocksFrame,
} from './blocks-frame';

// The pure wire codec lives in `blocks-frame.ts` (no transport imports, so it
// loads under the Node test runner). Re-export it so consumers keep importing
// the Blocks protocol surface from this one module.
export {
  BLOCKS_SFD,
  BLOCKS_REQ,
  BLOCKS_RES,
  buildBlocksFrame,
  BlocksFrameParser,
  characteristicToChannel,
} from './blocks-frame';
export type { BlocksFrame } from './blocks-frame';

/** Service UUID — same as the BLE service. */
export const BLOCKS_SERVICE_UUID = '0b50f3e4-607f-4151-9091-7d008d6ffc5c';

/** Friendly names for the channels we know about. Used in comms-panel
 *  proxy entries; unknown channels show as `0x????`. */
const CHANNEL_NAME: Record<number, string> = {
  0x0100: 'COMMAND',
  0x0101: 'STATE',
  0x0102: 'MOTION',
  0x0110: 'PIN_EVENT',
  0x0111: 'ACTION_EVENT',
  0x0120: 'ANALOG_IN_P0',
  0x0121: 'ANALOG_IN_P1',
  0x0122: 'ANALOG_IN_P2',
  0x0123: 'ANALOG_IN_P3',
  0x0130: 'DATA',
};

export function channelName(channel: number): string {
  return CHANNEL_NAME[channel] ?? `0x${channel.toString(16).padStart(4, '0')}`;
}

const REQ_NAME: Record<number, string> = {
  [BLOCKS_REQ.READ]: 'READ',
  [BLOCKS_REQ.WRITE]: 'WRITE',
  [BLOCKS_REQ.WRITE_RESPONSE]: 'WRITE_RESPONSE',
  [BLOCKS_REQ.NOTIFY_STOP]: 'NOTIFY_STOP',
  [BLOCKS_REQ.NOTIFY_START]: 'NOTIFY_START',
};

const RES_NAME: Record<number, string> = {
  [BLOCKS_RES.READ]: 'READ',
  [BLOCKS_RES.WRITE_RESPONSE]: 'WRITE_RESPONSE',
  [BLOCKS_RES.NOTIFY]: 'NOTIFY',
};

/** Format bytes as space-separated 2-digit hex, capped to keep entries short. */
function formatBytes(data: Uint8Array, maxBytes = 32): string {
  if (data.length === 0) return '';
  const slice = data.slice(0, maxBytes);
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    if (i > 0) out += ' ';
    out += slice[i].toString(16).padStart(2, '0').toUpperCase();
  }
  if (data.length > maxBytes) out += ` …(+${data.length - maxBytes})`;
  return out;
}

// ---- USB transport --------------------------------------------------------

/**
 * Write a Blocks frame to the connected USB Calliope.
 *
 * Hands the raw Uint8Array straight to `serialWrite`. The widget's patched
 * `@microbit/microbit-connection` accepts Uint8Array on the DAPLink serial
 * path; the stock library only takes strings and UTF-8-encodes them, which
 * mangles every byte ≥ 0x80 (the 0xFF SFD becomes `0xC3 0xBF`). Without
 * the patch the firmware never sees a valid frame on USB.
 */
export async function sendBlocksFrameOverUsb(frame: Uint8Array): Promise<void> {
  const usb = getUsbConn();
  if (!usb || usb.status !== ConnectionStatus.Connected) {
    throw new Error('USB not connected');
  }
  // Log the structured request before we hand it to the wire. Comms panel
  // entries arrive in time order; raw `tx 0xFF 0x10 ...` bytes from the
  // existing USB tap appear right after this one, so the user can correlate
  // the decoded request with the byte stream.
  if (frame.length >= 6) {
    const type = frame[1];
    const channel = (frame[2] << 8) | frame[3];
    const len = frame[4];
    const data = frame.slice(5, 5 + len);
    const opName = REQ_NAME[type] ?? `op=0x${type.toString(16)}`;
    const chName = channelName(channel);
    // READs of COMMAND/STATE/MOTION/ANALOG are the editor's poll + handshake —
    // route them to the Live tab (latest-per-channel) instead of the Stream.
    const isLive = type === BLOCKS_REQ.READ &&
      (channel === 0x0100 || channel === 0x0101 || channel === 0x0102 || channel === 0x0120);
    pushProxy({
      direction: 'tx',
      transport: 'usb',
      kind: 'blocks',
      live: isLive,
      liveKey: isLive ? chName : undefined,
      text: `${opName} ch=0x${channel.toString(16).padStart(4, '0')} (${chName})${
        data.length > 0 ? ` bytes=${formatBytes(data)}` : ''
      }`,
    });
  }
  await usb.serialWrite(frame);
}

/**
 * Subscribe to Blocks frames arriving over USB. Returns an unsubscribe
 * function. Multiple subscribers may coexist; each gets a copy of every
 * parsed frame.
 */
export function onBlocksFrameFromUsb(
  cb: (frame: BlocksFrame) => void,
): () => void {
  const parser = new BlocksFrameParser();
  // Mark USB as carrying the Blocks binary protocol so the raw text tap is
  // suppressed (see setBlocksFramingUsbActive) while we're decoding frames.
  setBlocksFramingUsbActive(true);
  const unsub = registerSerialDataListener((ev) => {
    if (!ev?.data) return;
    const bytes: number[] = new Array(ev.data.length);
    for (let i = 0; i < ev.data.length; i++) bytes[i] = ev.data.charCodeAt(i) & 0xff;
    const frames = parser.push(bytes);
    for (const f of frames) {
      logIncomingFrame('usb', f);
      try { cb(f); } catch (err) { appendLog({ direction: 'info', text: `blocks handler error: ${(err as Error)?.message ?? err}` }); }
    }
  });
  return () => {
    setBlocksFramingUsbActive(false);
    unsub();
  };
}

/**
 * Push a decoded inbound Blocks frame into the comms timeline so the user
 * sees what the device sent (notification, read-result, write-ack) without
 * having to mentally parse the raw byte tap.
 */
export function logIncomingFrame(transport: 'usb' | 'ble', frame: BlocksFrame): void {
  const opName = RES_NAME[frame.type] ?? `op=0x${frame.type.toString(16)}`;
  const chName = channelName(frame.channel);
  // READ results for COMMAND/STATE/MOTION/ANALOG are the poll/handshake
  // responses (incl. the serial broadcaster's pushes) — route to the Live tab.
  const isLive = frame.type === BLOCKS_RES.READ &&
    (frame.channel === 0x0100 || frame.channel === 0x0101 || frame.channel === 0x0102 || frame.channel === 0x0120);
  pushProxy({
    direction: 'rx',
    transport,
    kind: 'blocks',
    live: isLive,
    liveKey: isLive ? chName : undefined,
    text: `${opName} ch=0x${frame.channel.toString(16).padStart(4, '0')} (${chName})${
      frame.data.length > 0 ? ` bytes=${formatBytes(frame.data)}` : ''
    }`,
  });
}
