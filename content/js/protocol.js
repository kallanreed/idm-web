// iDotMatrix BLE protocol helpers. See docs/PROTOCOL.md.

export const MEDIA_TYPE = {
  GIF: 1,
  IMAGE: 2,
  TEXT: 4,
};

export const SLOT = {
  PREVIEW: 12, // live preview, don't save
  CURRENT: 13,
};

export const SUPER_CHUNK_SIZE = 4096;
export const HEADER_LEN = 16;
export const MTU_WRITE = 509; // effective payload when MTU 512 negotiated

// Standard zlib CRC-32 (polynomial 0xEDB88320, reflected). Returns unsigned 32-bit.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Build the 16-byte chunked-upload header for one super-chunk.
// See PROTOCOL.md §3.2.
function buildHeader({ chunkLen, mediaType, isFirst, totalLen, crc, animMs, slot }) {
  const buf = new ArrayBuffer(HEADER_LEN);
  const dv = new DataView(buf);
  dv.setUint16(0, HEADER_LEN + chunkLen, true);      // total packet length, LE16
  dv.setUint8(2, mediaType);                          // 1=GIF, 2=image, 4=text
  dv.setUint8(3, 0x00);                               // reserved
  dv.setUint8(4, isFirst ? 0 : 2);                    // flag: 0 first, 2 continuation
  dv.setUint32(5, totalLen, true);                    // full file length, LE32
  dv.setUint32(9, crc, true);                         // CRC-32 of full file, LE32
  dv.setUint16(13, animMs, true);                     // per-frame anim ms, LE16
  dv.setUint8(15, slot);                              // 12 = preview, 0..11 saved
  return new Uint8Array(buf);
}

/**
 * Yield (header + super-chunk) packets for a complete file blob.
 * Each yielded Uint8Array is a full "packet" ready to be written in MTU-sized sub-chunks.
 *
 * @param {Uint8Array} fileBytes - full media payload (e.g. raw GIF bytes)
 * @param {object} opts
 * @param {number} opts.mediaType - MEDIA_TYPE.*
 * @param {number} opts.slot - target slot (default: SLOT.PREVIEW = 12)
 * @param {number} opts.animMs - per-frame animation ms (forced to 0 for preview slot)
 */
export function* buildSuperChunkPackets(fileBytes, { mediaType, slot = SLOT.PREVIEW, animMs = 0 } = {}) {
  const totalLen = fileBytes.length;
  const crc = crc32(fileBytes);

  let offset = 0;
  let isFirst = true;
  while (offset < totalLen) {
    const chunk = fileBytes.subarray(offset, Math.min(offset + SUPER_CHUNK_SIZE, totalLen));
    const header = buildHeader({
      chunkLen: chunk.length,
      mediaType,
      isFirst,
      totalLen,
      crc,
      animMs,
      slot,
    });
    const packet = new Uint8Array(HEADER_LEN + chunk.length);
    packet.set(header, 0);
    packet.set(chunk, HEADER_LEN);
    yield packet;
    offset += chunk.length;
    isFirst = false;
  }
}

/** Split a single packet into MTU-sized sub-writes. */
export function* splitForWrite(packet, mtu = MTU_WRITE) {
  for (let i = 0; i < packet.length; i += mtu) {
    yield packet.subarray(i, Math.min(i + mtu, packet.length));
  }
}

// Short control commands (PROTOCOL.md §5).
export const GET_LED_TYPE = new Uint8Array([0x04, 0x00, 0x01, 0x80]);

/** Brightness 0..100. Visible effect — handy to confirm BLE writes reach the device. */
export function buildBrightness(pct) {
  const v = Math.max(0, Math.min(100, pct | 0));
  return new Uint8Array([0x05, 0x00, 0x04, 0x80, v]);
}

// Parse a notification frame. See PROTOCOL.md §4.
export function parseNotification(dataView) {
  if (dataView.byteLength < 5) return null;
  return {
    length: dataView.getUint16(0, true),
    type: dataView.getUint8(2),
    sub: dataView.getUint8(3),
    status: dataView.getUint8(4),
    raw: new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength),
  };
}
