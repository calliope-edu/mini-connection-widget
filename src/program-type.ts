/**
 * Detect which kind of program is currently running on the connected
 * Calliope mini.
 *
 * Strategy: probe BLE GATT services on the already-connected device. The
 * Calliope blocks runtime (pxt-scratch fork of MbitMore) exposes service
 * UUID `0b50f3e4-607f-4151-9091-7d008d6ffc5c` with a STATE characteristic
 * at `...0101...` that carries protocol + hw version. If the service is
 * present → blocks runtime is flashed.
 *
 * No firmware change required — the detection runs entirely client-side
 * against the existing BLE connection. The serial-marker alternative is
 * not implemented; revisit if USB-only detection is needed.
 */

import { getConnectedBleDevice } from './ble';

/** What kind of program the connected mini appears to be running. */
export type CalliopeProgramType = 'blocks' | 'unknown' | 'disconnected';

export interface CalliopeProgramInfo {
  type: CalliopeProgramType;
  /** MbitMore protocol version reported by the STATE characteristic (blocks runtime only). */
  protocolVersion?: number;
  /** MbitMore hardware version byte (blocks runtime only). */
  hardwareVersion?: number;
  /** Raw service UUID we matched, if any. */
  serviceUuid?: string;
}

// MbitMore (pxt-scratch) service. See pxt-scratch/MbitMoreService.cpp.
const MBIT_MORE_SERVICE_UUID = '0b50f3e4-607f-4151-9091-7d008d6ffc5c';
const MBIT_MORE_STATE_CHAR_UUID = '0b500101-607f-4151-9091-7d008d6ffc5c';

/**
 * Probe the connected Calliope mini to figure out what program it's
 * running. Currently distinguishes the blocks runtime from "anything
 * else" — extend with more service probes (radio UART for MakeCode etc.)
 * if more granularity is needed.
 *
 * Returns `'disconnected'` if BLE is not connected. Returns `'unknown'`
 * if the blocks service is absent OR the GATT probe fails (e.g. stale
 * bond). Never throws.
 */
export async function getRunningProgramType(): Promise<CalliopeProgramInfo> {
  const device = await getConnectedBleDevice();
  if (!device?.gatt) return { type: 'disconnected' };

  let server: BluetoothRemoteGATTServer;
  try {
    server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  } catch {
    return { type: 'disconnected' };
  }

  // Probe MbitMore.
  try {
    const service = await server.getPrimaryService(MBIT_MORE_SERVICE_UUID);
    // Service present — try to read STATE for version info. Failure here
    // still counts as "blocks" since the service exists.
    let protocolVersion: number | undefined;
    let hardwareVersion: number | undefined;
    try {
      const stateChar = await service.getCharacteristic(MBIT_MORE_STATE_CHAR_UUID);
      const view = await stateChar.readValue();
      // MbitMoreDevice::updateVersionData writes hardware (byte 0) +
      // protocol (byte 1) into the STATE characteristic. Other bytes are
      // runtime state we don't care about here.
      if (view.byteLength >= 2) {
        hardwareVersion = view.getUint8(0);
        protocolVersion = view.getUint8(1);
      }
    } catch {
      /* STATE read failed — still report 'blocks' since the service was found. */
    }
    return {
      type: 'blocks',
      protocolVersion,
      hardwareVersion,
      serviceUuid: MBIT_MORE_SERVICE_UUID,
    };
  } catch {
    // Service not advertised → assume non-blocks program (MakeCode, Python,
    // empty mini, or DAPLink-only mode).
    return { type: 'unknown' };
  }
}
