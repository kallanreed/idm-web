// Web Bluetooth client for iDotMatrix devices. See docs/PROTOCOL.md.

import {
  MEDIA_TYPE,
  SLOT,
  GET_LED_TYPE,
  buildBrightness,
  buildSuperChunkPackets,
  splitForWrite,
  parseNotification,
} from "./protocol.js";

const SERVICE_UUID = "000000fa-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID = "0000fa02-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fa03-0000-1000-8000-00805f9b34fb";

const PROP_KEYS = [
  "broadcast", "read", "writeWithoutResponse", "write",
  "notify", "indicate", "authenticatedSignedWrites", "reliableWrite", "writableAuxiliaries",
];
function enabledProps(c) {
  const out = [];
  for (const k of PROP_KEYS) if (c.properties[k]) out.push(k);
  return out;
}

// PROTOCOL.md §1.5 — devices advertise manufacturer data with company ID "TR" (LE 0x5254)
// and a product byte: 0x70 = standard iDotMatrix, 0x86 = OmniLED.
const COMPANY_ID = 0x5254;

const INTER_WRITE_MS = 20;            // PROTOCOL.md §3.2 — ~20 ms gap
const SUPER_CHUNK_TIMEOUT_MS = 5000;  // §10.5
const PROBE_TIMEOUT_MS = 1500;

// Web Bluetooth doesn't expose negotiated MTU. The doc gives us two reliable
// values: 509 bytes (MTU 512) or 18 bytes (MTU fallback). Writes larger than
// the actual MTU-3 trigger an ATT Long Write Procedure, which many cheap BLE
// firmwares (including the iDotMatrix family) handle poorly — usually they
// either ignore the upload or drop the link. Defaulting to the small safe
// value; tunable via constructor option.
const DEFAULT_WRITE_SIZE = 18;

// PROTOCOL.md panel-size code → "WxH" string.
const LED_TYPE_NAMES = {
  1: "16x16", 2: "8x32", 3: "32x32", 4: "64x64", 6: "24x48", 7: "16x32", 11: "16x64",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IdmDevice {
  /**
   * @param {object} [opts]
   * @param {number} [opts.writeSize=18]
   * @param {"auto"|"with-response"|"without-response"} [opts.writeMode="auto"]
   *   - "auto": pick whichever the characteristic advertises (preferring without-response).
   *   - "with-response": use ATT Write Request — slower but has BLE-layer flow control;
   *     better on iOS / Bluefy where the without-response buffer is easy to overflow.
   *   - "without-response": fastest path but caller must rate-limit.
   * @param {number} [opts.interWriteMs=20]
   * @param {boolean} [opts.debug=true]
   */
  constructor({
    writeSize = DEFAULT_WRITE_SIZE,
    writeMode = "auto",
    interWriteMs = INTER_WRITE_MS,
    debug = true,
  } = {}) {
    this.writeSize = writeSize;
    this.writeMode = writeMode;
    this.interWriteMs = interWriteMs;
    this.debug = debug;
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._writeFn = null;
    this._pendingAck = null;
    this._anyNotificationListeners = [];
    this._onDisconnect = null;
  }

  get connected() {
    return this.device?.gatt?.connected === true;
  }

  /**
   * Open the browser device picker and connect. Must be called from a user gesture.
   */
  async connect({ acceptAll = false } = {}) {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth not supported by this browser.");
    }

    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : {
          filters: [
            { services: [SERVICE_UUID] },
            { manufacturerData: [{ companyIdentifier: COMPANY_ID }] },
          ],
          optionalServices: [SERVICE_UUID],
        };

    try {
      this.device = await navigator.bluetooth.requestDevice(options);
    } catch (e) {
      if (!acceptAll && e instanceof TypeError) {
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [SERVICE_UUID] }],
          optionalServices: [SERVICE_UUID],
        });
      } else {
        throw e;
      }
    }

    this.device.addEventListener("gattserverdisconnected", () => {
      if (this.debug) console.warn("[idm] gattserverdisconnected");
      this.writeChar = null;
      this.notifyChar = null;
      this._writeFn = null;
      this.server = null;
      this._pendingAck?.reject(new Error("Device disconnected"));
      this._pendingAck = null;
      this._onDisconnect?.();
    });

    this.server = await this.device.gatt.connect();
    if (this.debug) console.log("[idm] connected:", this.device.name || "(unnamed)");

    const service = await this.server.getPrimaryService(SERVICE_UUID);
    const chars = await service.getCharacteristics();
    if (this.debug) {
      console.log("[idm] characteristics:", chars.map(c => ({
        uuid: c.uuid,
        properties: enabledProps(c),
      })));
    }

    this.writeChar = await service.getCharacteristic(WRITE_CHAR_UUID);

    const wp = this.writeChar.properties;
    const withResp = (v) => this.writeChar.writeValueWithResponse(v);
    const withoutResp = (v) => this.writeChar.writeValueWithoutResponse(v);

    let chosen;
    if (this.writeMode === "with-response") {
      chosen = wp.write ? withResp : withoutResp;
    } else if (this.writeMode === "without-response") {
      chosen = wp.writeWithoutResponse ? withoutResp : withResp;
    } else { // auto
      if (wp.writeWithoutResponse) chosen = withoutResp;
      else if (wp.write) chosen = withResp;
      else chosen = withoutResp;
    }
    this._writeFn = chosen;
    this._writeFnName = chosen === withResp ? "writeWithResponse" : "writeWithoutResponse";

    // Notifications come on a separate characteristic (fa03), not the write char.
    try {
      this.notifyChar = await service.getCharacteristic(NOTIFY_CHAR_UUID);
    } catch {
      // Fallback: some firmware variants may still notify on the write char.
      this.notifyChar = this.writeChar;
    }
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener("characteristicvaluechanged", (e) => {
      this._handleNotification(e.target.value);
    });
    // Give the device a beat to settle after CCCD subscription before issuing commands.
    await sleep(200);

    if (this.debug) {
      console.log("[idm] write char:", this.writeChar.uuid, "props:", enabledProps(this.writeChar));
      console.log("[idm] notify char:", this.notifyChar.uuid, "props:", enabledProps(this.notifyChar));
      console.log("[idm] write method:", this._writeFnName, "writeSize:", this.writeSize, "gap:", this.interWriteMs);
    }
  }

  onDisconnect(cb) { this._onDisconnect = cb; }

  async disconnect() {
    try { await this.device?.gatt?.disconnect(); } catch {}
  }

  get deviceName() { return this.device?.name ?? "(unnamed)"; }

  _handleNotification(dataView) {
    const note = parseNotification(dataView);
    if (!note) return;

    if (this.debug) {
      const hex = Array.from(note.raw).map(b => b.toString(16).padStart(2, "0")).join(" ");
      console.log("[idm] notify:", hex);
    }

    // Deliver to one-shot listeners (e.g. getLedType probe).
    for (const listener of this._anyNotificationListeners) listener(note);

    // Resolve chunked-upload ack if pending.
    if (this._pendingAck && (note.status === 0 || note.status === 1 || note.status === 2 || note.status === 3)) {
      const { resolve, timer } = this._pendingAck;
      clearTimeout(timer);
      this._pendingAck = null;
      resolve(note);
    }
  }

  _awaitAck() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAck = null;
        reject(new Error("Timed out waiting for device ack"));
      }, SUPER_CHUNK_TIMEOUT_MS);
      this._pendingAck = { resolve, reject, timer };
    });
  }

  /** Wait for the next notification matching predicate (or any if omitted). */
  _awaitNotification(predicate, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._anyNotificationListeners.indexOf(listener);
        if (idx >= 0) this._anyNotificationListeners.splice(idx, 1);
        reject(new Error("Timed out waiting for notification"));
      }, timeoutMs);
      const listener = (note) => {
        if (predicate && !predicate(note)) return;
        clearTimeout(timer);
        const idx = this._anyNotificationListeners.indexOf(listener);
        if (idx >= 0) this._anyNotificationListeners.splice(idx, 1);
        resolve(note);
      };
      this._anyNotificationListeners.push(listener);
    });
  }

  /**
   * Probe: send getLedType (`04 00 01 80`) and wait for the device's reply.
   * Returns the LED type code (and a friendly size string) so the caller can
   * confirm the bidirectional pipe works.
   */
  async getLedType() {
    if (!this.connected) throw new Error("Not connected");
    const pending = this._awaitNotification(
      (n) => n.type === 0x01 && n.sub === 0x80,
      PROBE_TIMEOUT_MS,
    );
    await this._writeFn(GET_LED_TYPE);
    const note = await pending;
    // The reply carries the type byte at offset 5 (just after the 5-byte preamble).
    const code = note.raw[5];
    return { code, size: LED_TYPE_NAMES[code] || `unknown(${code})` };
  }

  async _writeChunked(packet, { onSubWrite } = {}) {
    let i = 0;
    for (const sub of splitForWrite(packet, this.writeSize)) {
      try {
        await this._writeFn(sub);
      } catch (err) {
        const e = new Error(`Write failed at sub-chunk ${i} (size ${sub.length}): ${err.message || err}`);
        e.cause = err;
        throw e;
      }
      i++;
      onSubWrite?.(i);
      if (this.interWriteMs > 0) await sleep(this.interWriteMs);
    }
  }

  async uploadMedia(fileBytes, { mediaType, slot = SLOT.PREVIEW, animMs = 0, onProgress } = {}) {
    if (!this.connected) throw new Error("Not connected");

    const packets = [...buildSuperChunkPackets(fileBytes, { mediaType, slot, animMs })];
    const total = fileBytes.length;
    let sent = 0;

    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const ackPromise = this._awaitAck();
      await this._writeChunked(packet);

      const ack = await ackPromise;
      sent += packet.length - 16;
      onProgress?.({ sent: Math.min(sent, total), total });

      const isLast = i === packets.length - 1;
      if (ack.status === 0) throw new Error("Device: invalid transfer command (status=0)");
      if (ack.status === 2) throw new Error("Device: out of space (status=2)");
      if (!isLast && ack.status !== 1) {
        throw new Error(`Unexpected ack status=${ack.status} mid-upload`);
      }
      if (isLast && ack.status !== 3) {
        const finalAck = await this._awaitAck();
        if (finalAck.status !== 3) {
          throw new Error(`Upload did not complete cleanly (status=${finalAck.status})`);
        }
      }
    }
  }

  /** Send a brightness command (visible effect). No reply expected. */
  async setBrightness(pct) {
    if (!this.connected) throw new Error("Not connected");
    await this._writeFn(buildBrightness(pct));
  }

  async sendGifPreview(gifBytes, { animMs = 100, onProgress } = {}) {
    return this.uploadMedia(gifBytes, {
      mediaType: MEDIA_TYPE.GIF,
      slot: SLOT.PREVIEW,
      animMs,
      onProgress,
    });
  }
}

export function isWebBluetoothSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}
