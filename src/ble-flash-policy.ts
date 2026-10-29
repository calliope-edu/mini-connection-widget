/**
 * BLE-as-flash-transport policy.
 *
 * Calliope ships BLE for *communication* (the Blocks editor's live read/write/
 * subscribe traffic) but NOT for flashing — flashing should go over USB. This
 * flag gates only the flash path: the `flashDispatch` BLE branches and the
 * Bluetooth option in the connection-choice modal. BLE comms (CalliopeRemoteHost,
 * `connectCalliope('ble')`, the connect UI) is unaffected and always available.
 *
 * Native (iOS/Android) mode is exempt: there BLE is the only transport, and
 * `flashCalliope` returns before `flashDispatch` runs — so this flag never
 * touches the native flash path.
 *
 * Defaults to `true` to preserve existing behavior for any consumer that doesn't
 * opt out. calliope-campus sets it from its dev-mode flag, so BLE flashing is
 * off for normal users and on while developing (where it can be re-enabled and,
 * later, shipped again without code changes).
 */

let bleFlashEnabled = true;

/** Enable/disable BLE as a flash transport. Comms over BLE is always allowed. */
export function setBleFlashEnabled(enabled: boolean): void {
  bleFlashEnabled = enabled;
}

/** Whether BLE may currently be used to flash. */
export function isBleFlashEnabled(): boolean {
  return bleFlashEnabled;
}
