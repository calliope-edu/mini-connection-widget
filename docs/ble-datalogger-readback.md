# Reading the on-device data log over BLE (MicroBit Utility Service)

**Status: not yet implemented in the widget.** The device side already exists
and is enabled in Calliope mini 3 firmware that uses the datalogger. What's
missing is a **client** in this widget. This doc captures everything needed to
pick it up later.

## Background

`datalogger.log(...)` writes to **flash**, not to serial or BLE. By default it
is invisible to the widget (unlike `serial.writeValue` / `bluetooth.uartWriteValue`,
which stream over UART). Two ways exist to surface logged data:

1. **USB serial mirror** — `datalogger.mirrorToSerial(true)` streams every
   logged row to the USB serial port as CSV (header + rows). The widget's
   `LogParser` already recognizes that (CSV header + numeric rows), so it shows
   up in Zeilen/Graph and can be exported. **Works today, no widget change.**
2. **BLE readback** — CODAL exposes the stored log over a dedicated BLE service,
   the **MicroBit Utility Service**. This is the path documented below.

## The service

Source (CODAL v2, vendored here):
- [`firmware/codal/codal-microbit-v2/source/bluetooth/MicroBitUtilityService.cpp`](../../../firmware/codal/codal-microbit-v2/source/bluetooth/MicroBitUtilityService.cpp)
- [`firmware/codal/codal-microbit-v2/inc/bluetooth/MicroBitUtilityTypes.h`](../../../firmware/codal/codal-microbit-v2/inc/bluetooth/MicroBitUtilityTypes.h)

UUIDs (micro:bit base `e95d0000-251d-470a-a062-fa1922dfa9a8`):

| What | UUID |
|---|---|
| Service | `e95d0001-251d-470a-a062-fa1922dfa9a8` |
| Control characteristic | `e95d0002-251d-470a-a062-fa1922dfa9a8` |

The control characteristic has `WRITE`, `WRITE_WITHOUT_RESPONSE`, and `NOTIFY`.
The client **writes a request** packet and receives **one or more NOTIFY reply**
packets.

### Enablement — already on when datalogger is used

Upstream CODAL defaults both flags to `0` (BETA), but the MakeCode datalogger
extension turns them on via `yotta.config`:

```jsonc
// editors/makecode/pxt-calliope/libs/datalogger/pxt.json
"yotta": { "config": {
  "MICROBIT_BLE_UTILITY_SERVICE": 1,
  "MICROBIT_BLE_UTILITY_SERVICE_PAIRING": 1
}}
```

The service is instantiated in both application mode and pairing mode
(`model/MicroBit.cpp`). So **any program that uses `datalogger.*` ships a
firmware that advertises this service.** Calliope mini 3 / CODAL only — the
DAL minis (`minidal`, `minidalusb`) are excluded by the extension.

## Protocol

All packets are ≤20 bytes (one ATT MTU's worth on the conservative path).

```
request_t  { u8 job; u8 type; u8 data[18]; }
reply_t    { u8 job; u8 data[19]; }
```

- **job** — synchronizes requests/replies. The client cycles the high nibble
  (`0x00, 0x10, 0x20, …, 0xF0, 0x00, …`); the service echoes it and cycles the
  low nibble (`+0x00, +0x01, …, +0x0E, 0x00, …`, wrapping at `jobLowMAX = 0x0E`).
  A reply with low nibble `0x0F` (`jobLowERR`) means **error** and `data` is a
  4-byte signed integer error code.
- **format** (used by both request types): `0 = HTML header`, `1 = HTML`,
  **`2 = CSV`**. Use CSV — it feeds straight into `LogParser`.

### Type 1 — log length (`requestTypeLogLength`)

```
request  { u8 job; u8 type=1; u8 format; }
reply    { u8 job; u32 length; }          // unsigned, little-endian
```

### Type 2 — log data (`requestTypeLogRead`)

```
request  { u8 job; u8 type=2; u8 format; u8 reserved=0;
           u32 index; u32 batchlen; u32 length; }   // length = value from type 1
reply    { u8 job; u8 data[≤19]; }                   // repeated until batchlen bytes delivered
```

The device streams `batchlen` bytes back as a sequence of NOTIFY packets, each
carrying up to 19 payload bytes. Concatenate the `data` fields (in `job`-order)
to reassemble the slice `[index, index + batchlen)` of the file.

## Implementation sketch (when we build the widget client)

A self-contained GATT helper, alongside the existing BLE code in `src/ble*.ts`:

1. Discover `e95d0001…` / `e95d0002…`; subscribe to NOTIFY.
2. Send a **type 1 / CSV** request → read the 4-byte `length`.
3. Loop **type 2 / CSV** requests, advancing `index` by each `batchlen`
   (e.g. 240 bytes/batch), reassembling NOTIFY packets per `job` until
   `index >= length`. Bail on a `jobLowERR` reply.
4. Decode the reassembled bytes as UTF-8 CSV, feed line-by-line through the
   shared `LogParser`, and surface the rows in the comms panel
   (e.g. a "Log vom Gerät laden" button next to "CSV laden").
5. Unit-test the packet framing (job cycling, batch reassembly, error path)
   the way `blocks-protocol.test.ts` tests the blocks codec.

### Caveats

- **Bonding/security.** Like the other micro:bit services, this is gated by BLE
  security. The widget needs a paired/bonded connection (the service is also
  created on the pairing-mode path). Expect to require an OS-level bond.
- **Throughput.** ≤19 payload bytes per NOTIFY means a large log is many
  round-trips; size `batchlen` against the negotiated MTU and show progress.
- **Format choice.** Request CSV (`2`). HTML (`0`/`1`) returns the
  `MY_DATA.HTM` wrapper, which is for the USB drive view, not for parsing.

## See also

- `lib/mini-connection-widget/src/log-parser.ts` — the CSV/labelled-value parser
  the readback would feed.
- `editors/makecode/pxt-calliope/libs/datalogger/datalogger.ts` — the device API
  (`mirrorToSerial`, `getRows`, `getNumberOfRows`).
