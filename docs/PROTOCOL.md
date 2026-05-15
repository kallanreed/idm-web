# iDotMatrix BLE Protocol

Reverse-engineered from the official `com.tech.idotmatrix` Android app, version
`2.0.6` (xapk dated 2026-04-09). Source of truth: decompiled Java/Kotlin in
`work/jadx_out/sources/`.

Sister products from the same vendor (sold under names like *iDotMatrix*,
*Pixoo-style LED grid*, *MagicDisplay*) all appear to speak this protocol.
The app's internal BLE TAG is `MagicDisplay`.

---

## 1. BLE / GATT

The service `000000fa-…` has **two** characteristics, plus a separate version
read characteristic:

| Role | UUID | Properties | Notes |
|------|------|------------|-------|
| Primary service | `000000fa-0000-1000-8000-00805f9b34fb` | — | All command + media traffic |
| Write | `0000fa02-0000-1000-8000-00805f9b34fb` | `write` + `writeWithoutResponse` | Every command and chunked-upload sub-write goes here. The Android app declares `UUID_WRITE_CHA`, `UUID_WRITE2_CHA`, `UUID_WRITE3_CHA` as separate constants but all three resolve to this UUID. |
| Notify | `0000fa03-0000-1000-8000-00805f9b34fb` | `notify` | Status / ack / response frames flow back here. Subscribe via the standard CCCD write (`01 00` to the `0x2902` descriptor; `startNotifications()` in Web Bluetooth handles this). |
| Version read | `d44bc439-abfd-45a2-b575-925416129602` | `read` | One-shot read for firmware version ASCII string |

(An earlier version of this doc listed `0x2902` as the "notify
characteristic". That is the standard CCCD *descriptor* UUID, not a separate
characteristic — the actual notify characteristic is `fa03`.)

Separate OTA service (only used for firmware updates):

| Role | UUID |
|------|------|
| OTA service | `0000ae00-0000-1000-8000-00805F9B34FB` |
| OTA write | `0000ae01-0000-1000-8000-00805F9B34FB` |
| OTA notify | `0000ae02-0000-1000-8000-00805f9b34fb` |

**MTU.** The app calls `requestMtu(512)` with a **1-second delay** after GATT
connection (`BleManager.setMtu` → `ThreadUtils.asyncDelay(1000L, ...)`), not
immediately. After negotiation it computes
`isMtuStatus = (negotiatedMtu >= 100)`. The chunked-upload code uses exactly
two chunk sizes in `GifAgreement.getSendData`:

- `isMtuStatus == true` → **509 bytes** per BLE write
- `isMtuStatus == false` → **18 bytes** per BLE write

There is no in-between in the Java. Pick accordingly based on whatever MTU
you negotiated.

**Write type.** The Android app uses `WRITE_TYPE_DEFAULT` (write-with-response,
`ATT_WRITE_REQ`). Each write is acknowledged at the BLE layer before the next
is issued; between writes the app inserts a **~20 ms delay** (`curTime = 20`
in `GifAgreement`/`ImageAgreement`). Both write modes are advertised on
`fa02`, so either is usable in practice (see § Web Bluetooth gotchas).

**Advertising / scan filter.** The app filters scan results by manufacturer
data: the bytes after a `0xFF` length-prefixed manufacturer-data record must
begin with `T R 0x00 p` (`{0x54, 0x52, 0x00, 0x70}`) — or `T R 0x00 X`
(`BROADCAST_AiTURE_PRODUCT_OMNILED`, second byte = `0x86`) for OmniLED
variants. In Web Bluetooth terms: `companyIdentifier: 0x5254` (LE "TR"),
with an optional `dataPrefix` for the product byte. Filtering by service UUID
**only works if the device actually advertises the service**, which is
device/firmware dependent — prefer the manufacturer-data filter, with the
service-UUID filter as an additional alternative.

---

## 2. Connection flow (what the app does)

1. Scan; match either by GATT service UUID or by the manufacturer-data prefix
   described above.
2. Connect.
3. Discover services.
4. Request MTU 512 (BLE-level GATT request).
5. Subscribe to notifications on the write/notify characteristic (CCCD = `01 00`).
6. Optionally read the version characteristic.
7. Send `getLedType` (`04 00 01 80`) — the device replies with its panel size
   and the app sets up the rest of the UI based on that.
8. Start sending commands.

---

## 3. Two framing styles

The protocol uses **two distinct packet shapes** depending on payload size.
Both are sent to the same write characteristic.

### 3.1 Short control commands (single GATT write)

```
+--------+--------+--------+-----------+----------------+
| len_lo | len_hi | opcode | sub_opcode|     payload    |
+--------+--------+--------+-----------+----------------+
```

- `len` is total bytes **including** the header, **little-endian uint16**.
- `opcode` (byte 2) selects the command.
- `sub_opcode` (byte 3) is a category byte:
  - `0x80` → system / config
  - `0x01` → display / mode
  - `0x02` → light / color
- Maximum size is one MTU (no chunking; sent as-is).
- The device may or may not respond, depending on the opcode. Responses are
  always notification frames of the same general shape.

### 3.2 Chunked media upload (GIF / image / text / DIY frames)

```
   ── Outer file split into 4096-byte super-chunks ──
   [super-chunk 0] [super-chunk 1] … [super-chunk N]

   For each super-chunk, prepend a 16-byte header (different header for
   DIY/timer/text/etc.):

   +-----+-----+------+-----+------+-----------+-----------+-----------+------+
   | len_lo,hi | type | 00  | flag | totalLen  |  CRC32    |  anim_ms  | slot |
   |  (LE16)   | (u8) | (u8)| (u8) | (LE32)    |  (LE32)   |  (LE16)   |(u8)  |
   +-----------+------+-----+------+-----------+-----------+-----------+------+

   Then split each (16 + ≤4096)-byte packet into MTU-sized writes
   (509 bytes when MTU 512 is in effect, 18 bytes otherwise).
   Sequence each write with ~20 ms gap.

   After each *super-chunk*, wait for a notification from the device:
     status=1  → "ready for next super-chunk, send it"
     status=3  → "all done"
     status=2  → "out of space"  (error)
     status=0  → "invalid transfer command" (error)
```

**Exact upload state machine (from `GifAgreement.onChanged`).** There is
**no second-ack wait** and **no inter-super-chunk sleep**. After each
super-chunk, await one notification, then:

```
status = 0  → invalid transfer command         (hard error, code 10018)
status = 1  → device wants next super-chunk
                if more queued: send next
                if not: ERROR (code 10011) — even though some firmware
                emits status=1 on the *final* chunk and the upload
                visually applies anyway
status = 2  → out of space                     (hard error, code 10016)
status = 3  → upload complete                  (success — anywhere,
                including mid-stream; the on-device GIF decoder is
                allowed to declare itself done once it has enough data)
```

The 5-second per-super-chunk timeout
(`Observable.interval(5, SECONDS).take(1)`) is canceled by *any*
notification, then the handler dispatches on the status byte. Honor this
state machine literally — adding sleeps or "lenient" interpretation hides
real bugs.

The 16-byte header (image / GIF flavour, `ImageAgreement` /
`GifAgreement.sendImageData`):

| Offset | Bytes | Meaning | Notes |
|---:|---:|---|---|
| 0 | 2 | length of this packet | LE uint16, includes header |
| 2 | 1 | media type | `1`=GIF · `2`=image · `4`=text (chunked) |
| 3 | 1 | `0x00` | reserved / sub-channel |
| 4 | 1 | flag | `0` for first super-chunk, `2` for continuation |
| 5 | 4 | total file length | LE uint32, full original blob size |
| 9 | 4 | CRC32 of full original blob | LE uint32, standard zlib CRC-32 |
| 13 | 2 | per-frame animation duration | LE uint16, ms (see § 6). `0` when slot = 12. |
| 15 | 1 | target slot | `12` = preview / live · `13` = current slot · `0..N` = saved-material position |
| 16 | … | super-chunk bytes | up to 4096 bytes from the file |

Variant headers exist for **DIY images** (9-byte header, no CRC), **timers**
(24-byte header with `num`/duration fields), and **alarm-mode text** — see
`ImageAgreement.sendDIYImageData`, `TimerAgreement`, `Schedule/PhraseAgreement`
respectively if you need them.

---

## 4. Notification / response frames

Notifications from the device share the same 5-byte preamble:

```
[len_lo, len_hi, type, sub, status, ...]
```

The Java parsers (`parseDataNextPackage`/`parseDataFinish`/etc.) only
check four bytes — they don't validate length:

```
bArr[1] == 0          // length high-byte (always 0 in observed frames)
bArr[2] == <type>     // matches the request's type byte
bArr[3] == <sub>      // matches the request's sub-opcode
bArr[4] == <status>
```

- `type` matches the type byte of the request being acknowledged
  (`1` for GIF, `2` for image, `4` for text, etc.).
- `status` values, contextually:

| Status | Meaning (chunked upload) |
|:---:|---|
| `0` | invalid transfer command |
| `1` | ack — send next super-chunk |
| `2` | out of space / error |
| `3` | transfer complete |

For short commands, the same shape carries opcode-specific responses (e.g.
the `getLedType` reply — see § 5.1).

**Note: not every command produces a reply.** Empirically, some firmware
revisions silently drop short-command notifications even though the request
is processed correctly (the upstream Android app handles this by caching
state locally after the first successful read). Treat notification probes
as best-effort; don't gate the rest of the connection flow on them.

---

## 5. Short-command catalog

Source: `BleProtocolN.java` (system + display), `MutilColorAgreement.java`
(multi-color effect). Bytes shown left-to-right, decimal unless `0x..`.

### 5.1 System (`sub_opcode = 0x80`)

| Wire bytes | Meaning |
|---|---|
| `04 00 01 80` | **Get LED type.** Response is 9+ bytes (see below). |
| `0B 00 01 80 yy mm dd dow HH MM SS` | **Sync time.** `yy = year − 2000`; `dow` is day-of-week. |
| `0A 00 02 80 a b c d e f` | **Eco mode** window (six time bytes; meanings: weekday-flags, on-hour, on-min, off-hour, off-min, mode). |
| `04 00 03 80` | **Factory reset.** |
| `05 00 04 80 brightness` | **Brightness** (0–100). |
| `05 00 06 80 flip` | **Rotate 180°** (`0` / `1`). |
| `05 00 07 80 enable` | **Hourly chime** master switch. |
| `07 00 08 80 hh mm ss` | **Countdown timer** start values. |
| `05 00 09 80 mode` | **Stopwatch** mode. |
| `08 00 0A 80 sA hA sB hB` | **Scoreboard.** Two big-endian shorts (each split as `[low, high]`). |
| `05 00 0B 80 type` | **Mic source type.** |
| `05 00 0C 80 idx` | **Set chain (joint) index.** |
| `05 00 0F 80 sec` | **Screen-on time.** `0xFF` reads current value. |

**`getLedType` reply layout** (from `MainActivity.lambda$new$4` — checks
`bArr.length >= 9 && bArr[2] == 1 && bArr[3] == 0x80`):

| Offset | Field |
|---:|---|
| 0–1 | `len_lo, len_hi` |
| 2 | `0x01` (type) |
| 3 | `0x80` (sub) |
| 4 | mcuVersion1 |
| 5 | mcuVersion2 |
| 6 | (device-specific — Android passes this byte as a `Message.obj`) |
| 7 | **screenType — the LED-type code (`AppData.LedType`)** |
| 8 | pwdFlag |

The LED-type code is at **offset 7**, not offset 5. Earlier text in this
doc said "Response carries the panel-size byte" without saying which —
this is which.

### 5.2 Display / mode (`sub_opcode = 0x01`)

| Wire bytes | Meaning |
|---|---|
| `05 00 03 01 speed` | **Text speed.** |
| `05 00 04 01 mode` | **DIY mode.** `mode` is the enum `DiyImageFun` — e.g. `ENTER_CLEAR_CUR_SHOW` enters DIY and clears, used for "live paint" startup. |
| `08 00 06 01 byte4 i3 i4 i5` | **Clock face mode.** `byte4` packs the face index, an enable bit (`0x80`) and a flag (`0x8000` if `i2==1`). `i3..i5` are RGB color of the clock face. |
| `05 00 07 01 enable` | **Switch plate** (toggle clock face). |

### 5.3 Lights / color (`sub_opcode = 0x02`)

| Wire bytes | Meaning |
|---|---|
| `07 00 02 02 r g b` | **LampLight color** (solid RGB). |
| `06 00 00 02 lvl flag` | **Mic rhythm tick.** `flag=0`→stop, `flag=1`→running. The full energy-bar payload is `06 00 00 02 lvl bars…` with the 16 bar values mapped through a `{0,15,1,14,…}` permutation (`BleProtocolN.multiplyByteArray`). |
| `(7 + 3·N) 00 03 02 modelIdx speed N R G B R G B …` | **Multi-color effect** (palette of `N` colors). RGB triples are saturation-adjusted host-side (`ColorConverter.calculationByColour`). Defined in `MutilColorAgreement.sendMutilColor`. |
| `08 00 04 02 i p1 p2 p3` | **Set 6-digit password** (`i`=mode, `p1..p3` = two-digit chunks). |
| `07 00 05 02 p1 p2 p3` | **Verify password.** |

### 5.4 Material catalog management

| Wire bytes | Meaning |
|---|---|
| `11 00 02 01 0C 00 01 02 03 04 05 06 07 08 09 0A 0B` | **Delete device material**, slots 0–11 (`Agreement.deleteDeviceMaterial`). |

### 5.5 Locate (the one AES-encrypted command)

`Agreement.getLocationDevice()` returns:

```
06 4C 4F 43 41 54 45 00 00 00 00 00 00 00 00 00     ; '\x06' + "LOCATE" + nulls
```

This 16-byte block is then passed through `aes.cipher(bArr, bArr)` (in-place
AES) before being written. AES key/mode is buried in the native `csh.tiro.cc`
class — outside Java decompilation scope. Only this single command is
encrypted; everything else goes plaintext.

---

## 6. Chunked upload — payload formats

### 6.1 GIF (`type = 1`)

Payload bytes are the **raw GIF file** verbatim. The display has an on-device
GIF decoder. Animation timing is governed by two unrelated paths:

1. **Slot = 12 (preview / live).** Header `anim_ms` is forced to `0`; the
   device uses the encoded GIF's own GCE per-frame delays. Verified — slow
   playback in early testing was an *encoder bug* (double ms→cs conversion),
   not the firmware.

2. **Saved slots (`0..11`) and slot 13.** Header `anim_ms` is filled from
   `DeviceMaterialTimeConvert.ConvertTime(timeSign)`, a five-step speed
   enum:

   | `timeSign` | `anim_ms` (LE uint16 in header) |
   |---:|---:|
   | 1 | 10 |
   | 2 | 30 |
   | 3 | 60 |
   | 4 | 300 |
   | other / default | 5 |

   That's the entire range; not `(100 - speedNum) * 10` (see § 10.4
   correction).

### 6.2 Static image (`type = 2`)

Payload bytes are 3 bytes per pixel **BGR**, row-major
(left→right, top→bottom). Total length = `width × height × 3`. Conversion in
`BGRUtils.bitmap2BGR`:

```java
// Pixels read as RGBA via Bitmap.copyPixelsToBuffer:
//   [R, G, B, A, R, G, B, A, ...]
// Repacked to BGR:
//   [B, G, R, B, G, R, ...]
```

Apply the brightness pre-scaling that `SendCore.changeLight()` does only if
you want the host-side dim (`b = b * pct / 100` per byte); otherwise rely on
the `setLight` command.

### 6.3 Text (`type = 4`)

Host-side font rendering into a custom per-glyph format. The format is
**panel-size-specific** — separate code paths for 8×32, 16×16, 16×64, 32×32
panels in `TextAgreement.sendTextTo832 / sendTextTo1616 / sendTextTo1664 /
sendTextTo3232`. Each method renders each glyph to a small bitmap, packs
attributes (color, animation, alignment, speed) into a per-character record,
then sends the whole payload through the same chunked-upload framing. See
`TextAgreement.java` (~2900 lines) for the gory details. Skip unless
you specifically need on-device font rendering — for arbitrary text the
easiest path is to render it to a Bitmap on the host and send as a static
image / GIF.

### 6.4 DIY images — single-packet live paint (`type = 5`)

For real-time pixel pushing (small, no CRC, no chunking), the app uses
`SendCore.payload(type=5)` which emits a **5-byte header**:

```
+-----+-----+------+-----+--------+----------+
|len_lo,hi | 0x05 | 0x01| moveTyp| diy bytes|
+----------+------+-----+--------+----------+
```

DIY payload bytes are one of:

- **Single-color shape** (`CPaintRunTimeItem` with no `arrPointXY` or
  `arrDifColorPointXY`):
  `[R, G, B, column, row]` — paint one pixel at (column, row) with the given
  RGB.
- **Single-color list of points** (`arrPointXY` non-empty):
  `[R, G, B, x0, y0, x1, y1, x2, y2, ...]`.
- **Differential color list** (`arrDifColorPointXY` non-empty):
  same shape with `difColor`.
- **Overall movement** (`moveType == OVERALL_MOVEMENT.mode`):
  payload is `item.getArrMoveDirectionNum()` — a direction-vector array, no
  pixel list.

Use `setDiyFunMode(mode)` (`05 00 04 01 mode`) first to enter DIY mode before
streaming pixels.

### 6.5 One-shot image/video without chunking (`SendCore.payload`)

`SendCore.payload(type, data, totalData, option, totalLength, bright)` is the
"send a single packet" path used elsewhere in the app. Its header is **9
bytes** (or 10 for text):

```
[0..1] len (LE16, including header + 5-byte CRC block + data length)
[2..3] dataType  (image=02 00, video=01 00, GIF=03 00, camera/diy-unredo=00 00,
                  text=00 01, DIY=05 01)
[4]    option  (mode flag, often 0)
[5..8] totalLength (LE32)  ─ for non-DIY types
[9..12] CRC32 (LE32)       ─ only for types 1,2,3,4 (i.e. video/image/GIF/text)
[13]   0x00, except for GIF where this byte is set to 0x02
[14..] data
```

This path is used for things that fit in one MTU. Anything bigger goes through
the chunked-upload path of § 3.2.

---

## 7. Panel sizes

`AppData.LedType`:

| ledType code | Pixels (w × h) | App tag |
|:---:|---|---|
| 1 | 16 × 16 | `16X16` |
| 2 | 8 × 32 | `8X32` |
| 3 | 32 × 32 | `32X32` |
| 4 | 64 × 64 | `64X64` |
| 6 | 24 × 48 | `24X48` |
| 7 | 16 × 32 | `16X32` |
| 11 | 16 × 64 | `16X64` |

Returned by the device in the `getLedType` (`04 00 01 80`) reply.

The image payload length for any device is always `w × h × 3` bytes (BGR).

---

## 8. OTA firmware update (brief)

Different service (`0000ae00-…`) and characteristic (`0000ae01-…`).

Initialisation: `BaseSend.updateOtaMcuOrWifiStep1`:

```
[0D 00 otaType 0x80 pkgCount CRC32(4) binSize(4)]
```

After step 1 the firmware bytes are sent through a chunked transport similar
to media upload, with progress notifications on `0000ae02-…`. See
`OTAAgreement.java` for the full state machine. **Don't experiment with this
unless you have a way to recover a bricked device.**

---

## 9. Driver-author cheat sheet

To upload an arbitrary GIF and have it display now (no save to slot):

1. Scan, connect, MTU 512, subscribe to notifications.
2. Read GIF file bytes → `data`.
3. Split `data` into 4096-byte super-chunks.
4. For each super-chunk *k*, build header:
   - `length = 16 + len(super_chunk[k])` as LE uint16 at bytes 0..1.
   - `bytes[2] = 1` (GIF), `bytes[3] = 0`.
   - `bytes[4] = 0` if *k* = 0 else `2`.
   - `bytes[5..9] = len(data)` LE uint32.
   - `bytes[9..13] = crc32(data)` LE uint32.
   - `bytes[13..15] = 0` (preview slot uses 0).
   - `bytes[15] = 12` (preview / live display now).
   - Append super-chunk bytes.
5. Split each (header + super-chunk) into 509-byte writes; send sequentially
   with ~20 ms gaps.
6. After every super-chunk, **wait for a notification** with `status = 1`
   before sending the next; on `status = 3` you're done; on `status = 0/2`
   bail.

To save to slot 0–11 instead, change `bytes[15]` to the slot index and set
`bytes[13..15]` to the animation-time short (LE uint16, ms).

Static image: identical, but `bytes[2] = 2` and the payload is `w*h*3` bytes
of BGR instead of GIF.

---

## 10. Device limits & host-side pre-processing

What the app and protocol actually constrain. Everything below is from the
v2.0.6 client; the on-device firmware almost certainly has additional limits
that aren't visible in the app.

### 10.1 Slot count = 12

The on-device "material library" (saved patterns) holds **12 slots,
indexed 0–11**. Three confirming pieces of evidence:

- `Agreement.deleteDeviceMaterial()` (the wipe-all command) is
  `[17 00 02 01 0C 00 01 02 03 04 05 06 07 08 09 0A 0B]` — the `0x0C` length
  prefix followed by the slot list `0..11`.
- `NewDeviceMaterialChildFragment.java` pages the UI by 12
  (`pageIndex * 12`, `i % 12`).
- Slot indices `12` and `13` have special meaning in the chunked-upload
  header — `12` = "preview / live display now, don't save", `13` = "current
  slot" / immediate display. So `0..11` are real storage, `12`/`13` are
  control values.

There is **no app-side check** for "slot full" — the app sends the upload
and only learns there's no room when the device returns notification
`status = 2` ("space is not enough"). The user-visible toast `R.string.space_is_not_enough` is wired
to that error code in `TimerActivity.java:186` and `AddTimerDialog.java:641`.

### 10.2 No per-file size cap (client side)

The app does not enforce a maximum GIF or image file size. It chunks
whatever it's given into 4096-byte super-chunks and trusts the device to
push back via `status=2` when full. In practice, modest 32×32 GIFs of
~10-200 KB seem fine; larger ones likely fail with "space is not enough".

### 10.3 Client re-encodes everything to native resolution

Critically, **the app never sends your original file**. For both static
images and GIFs:

- **Static images** are decoded → `BitmapUtils.getRotateBitmap(path,
  ledSize[1], ledSize[0])` (scale + rotate to fit native pixel
  dimensions) → `BGRUtils.bitmap2RGB(...)` → 3-bytes-per-pixel raw payload
  (e.g. `MaterialDetailsListActivity.java:707` and `:1328`).
- **GIFs** are decoded into a frame list (`CoreDecoder.GifCore.decodeGif`),
  scaled to native resolution, and re-encoded via
  `com.squareup.gifencoder.GifEncoder` at exactly `ledSize[1] × ledSize[0]`
  (`GIFUtils.makeGif2`, `DiyAnimAddActivity.java:844`).

Implication for a custom driver: if you skip the host-side scaling step and
send a 256×256 GIF straight to a 32×32 device, behaviour is undefined — the
firmware's GIF decoder may render only the top-left corner, scale it
on-device, or refuse it. The safest bet is to mimic the app: pre-scale to
exact native pixel dimensions, re-encode to GIF, then upload.

### 10.4 Frame delay (GIFs)

**Two separate timing systems** — earlier text in this section commingled
them:

1. **DIY animation editor `speedNum` slider** (0–100, default 50). Used
   only when the app re-encodes a user-drawn animation in the DIY editor.
   Maps to per-frame delay baked into the *output GIF's GCE delays*:

   ```
   delay_ms = (100 - speedNum) * 10        // 0..1000 ms
   if frameRate <= 10: delay_ms = 20       // 50 fps floor
   ```

2. **`anim_ms` field in the chunked-upload header** (bytes 13–14). Sourced
   from `DeviceMaterialTimeConvert.ConvertTime(timeSign)` — a five-step
   speed enum (`{5, 10, 30, 60, 300}` ms). See § 6.1.

For preview-slot uploads (slot 12), `anim_ms` is `0` and the device
respects the encoded GIF's own GCE delays — **verified on hardware**
(IDM-774AEF v2.0.6). Make sure your GIF re-encoder writes the source
delays through correctly; a 10× ms↔centisecond mistake will make
playback look glacial.

There's no observed cap on frame count beyond what fits in the device's
storage budget.

### 10.5 Time/throughput limits

- **MTU negotiation target: 512 bytes** → 509-byte effective writes. Falls
  back to 18 bytes if MTU negotiation fails (older Android, picky stack).
- **Inter-write delay: ~20 ms** (`curTime = 20` in
  `GifAgreement`/`ImageAgreement`). Many smaller writes per second won't be
  honoured; the device wants the gap.
- **Per-super-chunk response timeout: 5000 ms**
  (`BleManager.SEND_DATA_MAX_TIMEOUT`, used by `Observable.interval(5L,
  TimeUnit.SECONDS).take(1L)` in both `GifAgreement.startSend()` and
  `ImageAgreement.startSend()`). If the device doesn't notify with
  `status=1` (ready for next 4 KB) or `status=3` (done) within 5 s, the
  app aborts the upload with error code 10011.
- **Scan period: 12 s** (`setScanPeriod(12000L)`).
- **Connect timeout: ~5 s** (`DeviceOrientationRequest.OUTPUT_PERIOD_MEDIUM`).

### 10.6 What's NOT bounded in the app

The app has no client-side limit on:

- File size (GIF or image)
- Number of colors / palette size (handled by `NeuQuant` quantizer if the
  app re-encodes, but no hard cap)
- Animation duration / total runtime

All of those are effectively governed by **the device firmware's own
storage and decoder limits**, which the app discovers empirically via the
`status=2` notification. You'll have to do the same.

### 10.7 32×32 quick-reference (your panel)

For a 32×32 device specifically:

- `ledType` code: `3`. Returned in the `getLedType` reply.
- Static-image payload size: `32 × 32 × 3 = 3072 bytes` of BGR. Fits in a
  single 4 KB super-chunk, but still goes through the chunked-upload
  framing (one super-chunk, header `flag=0`, no follow-on).
- A typical 5-frame, 32×32 quantized GIF re-encoded by the app lands at
  roughly 1–5 KB; well within one super-chunk.

### 10.8 Streaming / remote display feasibility

The protocol reserves dedicated **camera** (`type = 0`, dataType `{0, 0}`)
and **video** (`type = 1`, dataType `{1, 0}`) frame types in
`SendCore.java:30,36`. `SendCore.payload()` handles them as
CRC-protected one-shot frames with the same 14-byte header used for static
images. **No code path in v2.0.6 actually invokes them** — no camera
capture, no video-streaming UI exists in this build. They appear to be
firmware-side reserved opcodes that the current client doesn't drive. On-wire
behaviour for those types can't be confirmed from the decompile.

**What works today using only proven paths:** repeated upload of `type = 2`
static-image BGR frames to **slot 12** (preview / live, don't save) via the
chunked-upload protocol of § 3.2. Each upload replaces the displayed frame,
giving you a frame buffer.

Throughput math, 32×32 panel, MTU 512:

```
frame bytes        = 32 * 32 * 3   = 3072
+ chunked header                   =   16
                                     ----
                                     3088 bytes per frame on wire

writes per frame   = ⌈3088 / 509⌉  = 7
inter-write gap                    = 20 ms × 6 gaps = 120 ms
device ack handshake               = ~10–50 ms (status=1, then status=3)

realistic per-frame budget         ≈ 150–250 ms
sustained framerate                ≈ 4–7 fps
```

Scaling: 16×16 ≈ 15 fps, 32×32 ≈ 5–7 fps, 64×64 ≈ 2–3 fps,
24×48 ≈ 4–5 fps. Cap your driver's frame interval at 150 ms to avoid
backpressure.

Suitable for ambient-display use cases: status tickers, slow webcams,
build/CI indicators, weather, a "now playing" tile. Not suitable for video
playback or anything interactive.

Watch out for:

- Whether the device overwrites slot 12 in place or queues uploads. Likely
  overwrite, but unverified.
- The 5-second per-super-chunk timeout (`SEND_DATA_MAX_TIMEOUT`) applies
  per-upload. Each frame is its own upload with its own ack.
- Sending faster than ~5 fps risks torn frames or dropped writes — the
  20 ms inter-write gap exists because the device wants it.
- The `TYPE_VIDEO` opcode may unlock a better-than-BGR frame encoding
  (delta or quantized), but the format is undocumented and probing it
  risks firmware misbehaviour. Get the slot-12 image-streaming path
  working first.

---

## 11. Byte order on the wire

Everything multi-byte in the protocol is **little-endian on the wire**,
despite an awkward intermediate representation in the Java. From
`com.tiro.jlotalibrary.util.ByteUtils`:

- `short2Bytes(s)` returns **big-endian** `[hi, lo]`. Call sites in
  `GifAgreement` and `BleProtocolN` reverse it byte-by-byte to put LE on
  the wire.
- `int2byte(i)` returns **little-endian** `[b0, b1, b2, b3]`. Call sites
  copy it through directly — already LE on the wire.

Net effect: don't try to deduce byte order from one half of the call —
look at the wire bytes.

**CRC-32 sanity vector** (standard zlib polynomial `0xEDB88320`,
reflected):

```
CRC32("The quick brown fox jumps over the lazy dog") == 0x414fa339
```

---

## 12. Web Bluetooth gotchas

Worth remembering for any client running in a browser (Chrome / Edge /
Bluefy):

- **`BluetoothRemoteGATTCharacteristic.properties`** exposes its flags
  via *prototype getters*. `Object.entries(c.properties)` returns `[]`.
  Read named flags explicitly: `c.properties.write`,
  `c.properties.writeWithoutResponse`, `c.properties.notify`, etc.

- **`navigator.bluetooth.requestDevice` filtering:** the device may not
  list service `000000fa-…` in its advertisement (it usually doesn't).
  Provide a manufacturer-data filter as an alternative filter entry:

  ```js
  filters: [
    { services: [SERVICE_UUID] },
    { manufacturerData: [{ companyIdentifier: 0x5254 }] }, // "TR" LE
  ]
  ```

- **iOS Safari does not support Web Bluetooth.** iPhone users need
  Bluefy or a similar Chromium-based WebBLE browser.

- **MTU is opaque in Web Bluetooth.** You can't query the negotiated MTU
  from JS. Pick a chunk size and live with whichever ATT procedure
  Chromium picks: `writeValueWithResponse` of values >`MTU - 3` triggers
  the *Long Write Procedure* (Prepare + Execute Write).

- **iOS / Bluefy + `writeValueWithoutResponse`:** the CoreBluetooth
  internal write queue overflows mid-upload (observed: uploads die at
  4–6 KB). Use `writeValueWithResponse` instead — slower but has
  BLE-layer flow control. Verified working chunk size on iOS: **220
  bytes** with a **50 ms** inter-write gap.

- **Notification subscription:** subscribe on `0000fa03` (the notify
  characteristic), *not* on the write characteristic. Earlier text in
  this doc misidentified the notify char.

### 12.1 Working configuration (iPhone + Bluefy + IDM-774AEF 32×32)

| Setting | Value |
|---|---|
| Write characteristic | `0000fa02` |
| Notify characteristic | `0000fa03` |
| Web Bluetooth call | `writeValueWithResponse` |
| Chunk size | 220 bytes |
| Inter-write gap | 50 ms |
| Per-super-chunk timeout | 5000 ms |
| Target slot for live display | 12 (preview) |
| Header anim_ms (slot 12) | 0 |

`getLedType` does **not** reply on this firmware revision — the upstream
Android app shrugs and stores the panel size locally (`AppData.setLedType`).
Cache it client-side or let the user pick.

---

## 13. Source pointers

- `com.heaton.baselib.ble.BleManager` — UUIDs, MTU, write helpers
  (lines 70-100 for UUID block).
- `com.heaton.baselib.ble.BleConfig` — manufacturer-data filter
  (`matchProduct`, `BROADCAST_AiTURE_PRODUCT`).
- `com.tech.idotmatrix.ble.BleProtocol` / `BleProtocolN` — short command
  catalog.
- `com.tech.idotmatrix.ble.send.SendCore` / `BaseSend` — one-shot packet
  encoder (`payload(...)`), DIY paint encoder, OTA step-1.
- `com.tech.idotmatrix.core.data.Agreement` — `deleteDeviceMaterial`,
  AES-encrypted `getLocationDevice`.
- `com.tech.idotmatrix.core.data.GifAgreement` /
  `ImageAgreement` — chunked-upload framing for GIF/image (§ 3.2).
- `com.tech.idotmatrix.core.data.TextAgreement` — per-panel-size text
  renderer + chunked upload.
- `com.tech.idotmatrix.core.data.MutilColorAgreement` — multi-color
  effect command.
- `com.tech.idotmatrix.core.data.OTAAgreement` — OTA upload state machine.
- `com.tech.idotmatrix.util.BGRUtils` — bitmap ↔ BGR ↔ RGB conversion.
- `com.tech.idotmatrix.AppData` — `ledType` code ↔ pixel-dimensions map.
- `com.tech.idotmatrix.core.data.DeviceMaterialTimeConvert` — speed-enum
  → `anim_ms` mapping for saved slots.
- `com.tiro.jlotalibrary.util.ByteUtils` — `short2Bytes` (BE),
  `int2byte` (LE). Wire format is always LE; mind the difference.
- `com.tech.idotmatrix.ui.pattern.main.MainActivity.lambda$new$4` —
  `getLedType` reply parser (length ≥ 9, LED type at byte 7).

Local jadx decompile (v2.0.6, 2026-04-09):
`~/temp/sec-analysis/pixel-display/work/jadx_out/sources/`
