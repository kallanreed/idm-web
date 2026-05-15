# iDotMatrix Notes & PROTOCOL.md Corrections

Things learned from cross-referencing PROTOCOL.md against the v2.0.6 decompile
(`/Users/kylereed/temp/sec-analysis/pixel-display/work/jadx_out/sources/...`)
and from empirical testing against an IDM-774AEF 32×32 panel from iPhone +
Bluefy. Keep this next to `PROTOCOL.md`; treat it as authoritative when the
two conflict.

---

## 1. GATT characteristics (correction to §1)

The service `000000fa-…` has **two** characteristics, not one:

| Characteristic | UUID | Properties | Purpose |
|---|---|---|---|
| Write | `0000fa02-0000-1000-8000-00805f9b34fb` | `write` + `writeWithoutResponse` | All commands and chunked-upload writes |
| Notify | `0000fa03-0000-1000-8000-00805f9b34fb` | `notify` | Status / ack / response frames |

`PROTOCOL.md` calls out `00002902-…` as the "notify characteristic" — that is
the standard CCCD *descriptor* UUID, not a characteristic. Notifications come
on `fa03`; subscribe via the standard CCCD write (`startNotifications()` in
Web Bluetooth handles this).

`fa02` advertises both write modes; the Android app uses
`WRITE_TYPE_DEFAULT` (write-with-response) at the Java layer, but most
community clients (and us, on iOS) use writeWithoutResponse or writeValue-
WithResponse interchangeably — both work for command bytes.

## 2. Notification frame layout (correction to §4)

The parsers in `GifAgreement.java` (`parseDataNextPackage`/`parseDataFinish`/
`parseDataError`/`parseDataError1`) check exactly these fields:

```
bArr[1] == 0          // length high-byte (always 0 in observed frames)
bArr[2] == <type>     // matches the request's type byte
bArr[3] == <sub>      // matches the request's sub-opcode
bArr[4] == <status>   // 0, 1, 2, or 3 for chunked upload
```

So the per-frame layout is `[len_lo, len_hi=0, type, sub, status, ...payload]`.

## 3. getLedType reply (correction to §5.1)

The reply is **9+ bytes**, not 5 (`MainActivity.java:1034` —
`bArr.length >= 9 && bArr[2] == 1 && bArr[3] == -128`). The byte layout:

| Offset | Field |
|---:|---|
| 0–1 | `len_lo, len_hi` |
| 2 | `0x01` (type) |
| 3 | `0x80` (sub) |
| 4 | mcuVersion1 |
| 5 | mcuVersion2 |
| 6 | (unused or device-specific — Android passes as `Message.obj`) |
| 7 | **screenType (the actual LED-type code — `AppData.LedType`)** |
| 8 | pwdFlag |

The protocol doc says "Response carries the panel-size byte" without
specifying which byte; the answer is **byte 7**, not byte 5.

**Empirical wrinkle:** IDM-774AEF (firmware v2.0.6) does *not* reply to
`getLedType` over BLE in our setup. The Android app stores the panel size
locally (`AppData.setLedType`) and is resilient to missing replies. Treat
the probe as best-effort; fall back to a user-chosen / hard-coded panel size.

## 4. Animation timing (correction to §6.1 and §10.4)

There are **two unrelated "frame delay" systems** in the app — the protocol
doc commingles them in §10.4:

- **Saved-slot animation duration** (header bytes 13–14 for slot ≠ 12).
  Sourced from `DeviceMaterialTimeConvert.ConvertTime(timeSign)`:

  | `timeSign` | Result (ms) |
  |---:|---:|
  | 1 | 10 |
  | 2 | 30 |
  | 3 | 60 |
  | 4 | 300 |
  | other / default | 5 |

  Five discrete speed steps — *not* the doc's `(100 - speedNum) * 10`.

- **DIY editor `speedNum` slider** (the `(100 - speedNum) * 10` formula).
  That's a separate path used by the DIY animation editor, not by the
  GIF upload header.

For slot `12` (preview / live), the header anim_ms is forced to `0` —
the firmware uses the encoded GIF's own GCE delays. Verified empirically
that fixing our decode-side ms/centisecond bug made playback speed match
the source GIF exactly.

## 5. Upload state machine (clarification to §3.2 and §4)

The state machine in `GifAgreement.onChanged` is strict; there is **no
"second ack" wait** and **no sleep between super-chunks**. Per-chunk:

```
status = 0 → invalid command           (hard error, code 10018)
status = 1 → device wants next chunk
              if more queued: send next
              if not: ERROR (code 10011) — even though firmware sometimes
              emits this on the final chunk and the upload visually applies
status = 2 → out of space              (hard error, code 10016)
status = 3 → upload complete           (success, even mid-stream)
```

The 5-second per-super-chunk timeout (`Observable.interval(5, SECONDS)`) is
canceled by *any* notification, then the handler dispatches on the status
byte.

The "early status=3 mid-stream is success" behavior is real — the
on-device GIF decoder declares itself done once it has enough data to
render. Our implementation honors this.

## 6. MTU (clarification to §1)

The Android app requests MTU 512 with a **1-second delay** after GATT
connection (`BleManager.setMtu` → `ThreadUtils.asyncDelay(1000L, ...)`).

After negotiation it sets `isMtuStatus = (negotiatedMtu >= 100)`. The
chunk size in `GifAgreement.getSendData`:

- `isMtuStatus == true` → **509 bytes per write**
- `isMtuStatus == false` → **18 bytes per write**

There is no in-between in the Java; only those two values.

Web Bluetooth doesn't expose MTU to JS. Chromium's
`writeValueWithResponse` automatically uses the ATT *Long Write
Procedure* for values > MTU - 3 (Prepare + Execute Write). On iOS /
Bluefy this works reliably with `writeValueWithResponse` at chunks up
to ~220 bytes. With `writeValueWithoutResponse`, CoreBluetooth's
internal write buffer overflows mid-upload (verified — uploads die at
4–6 KB).

## 7. Working tuning for IDM-774AEF (32×32) from iPhone + Bluefy

| Setting | Value |
|---|---|
| Write mode | `writeValueWithResponse` |
| Chunk size | 220 bytes |
| Inter-write gap | 50 ms |
| Target slot | 12 (preview) |
| Header anim_ms | 0 (preview slot) |

Per-frame GIF delays survive through the gifuct-js → gif.js pipeline
unchanged — the device's on-device GIF decoder respects them.

## 8. Web Bluetooth quirks worth remembering

- `BluetoothRemoteGATTCharacteristic.properties` exposes flags via
  *prototype getters*. `Object.entries(c.properties)` returns `[]`. Read
  named flags explicitly: `c.properties.write`, `c.properties.notify`,
  etc.
- `requestDevice` filtering: iDotMatrix devices may not list service
  `000000fa-…` in their advertisement. Use the manufacturer-data filter
  (`companyIdentifier: 0x5254` — "TR" in LE) instead, OR provide both as
  alternative filters and let either match.
- iOS Safari does *not* support Web Bluetooth; users need Bluefy
  (Chromium-based) or another WebBLE browser.

## 9. CRC sanity check

zlib CRC-32 (poly `0xEDB88320`, reflected). Known-good vector:

```
CRC32("The quick brown fox jumps over the lazy dog") == 0x414fa339
```

Used by both the chunked-upload header (bytes 9–12, LE32) and not much
else in the app.

## 10. Byte-order summary (gotcha)

In `ByteUtils.java`:

- `short2Bytes(s)` returns **big-endian**: `[hi, lo]`. The call sites in
  `GifAgreement` and `BleProtocolN` reverse it to put **LE on the wire**.
- `int2byte(i)` returns **little-endian**: `[b0, b1, b2, b3]`. The call
  sites copy it directly — **LE on the wire**.

So everything multi-byte in the protocol is LE on the wire, despite
the awkward intermediate representation.
