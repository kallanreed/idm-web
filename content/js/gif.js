// GIF normalization: decode → composite frames → cover+center-crop to NxN → re-encode.
//
// Uses:
//   - gifuct-js (ESM via esm.sh) for decode
//   - gif.js (vendored UMD; sets window.GIF) for encode

import { parseGIF, decompressFrames } from "https://esm.sh/gifuct-js@2.1.2";

const GIFJS_URL = "/content/vendor/gif.js";
const GIF_WORKER_URL = "/content/vendor/gif.worker.js";

let gifjsLoadingPromise = null;

/** Lazily inject the vendored gif.js script and resolve when window.GIF is available. */
function ensureGifJs() {
  if (window.GIF) return Promise.resolve(window.GIF);
  if (gifjsLoadingPromise) return gifjsLoadingPromise;
  gifjsLoadingPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIFJS_URL;
    s.async = true;
    s.onload = () => window.GIF ? resolve(window.GIF) : reject(new Error("gif.js loaded but window.GIF missing"));
    s.onerror = () => reject(new Error("Failed to load gif.js"));
    document.head.appendChild(s);
  });
  return gifjsLoadingPromise;
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Render each animation frame of a GIF to RGBA bitmaps the size of the original
 * canvas (logical screen). Handles disposal methods 0, 1, 2, 3.
 */
async function decodeGif(arrayBuffer) {
  const parsed = parseGIF(arrayBuffer);
  const frames = decompressFrames(parsed, true); // buildImagePatch → RGBA patches
  const width = parsed.lsd.width;
  const height = parsed.lsd.height;

  const screen = makeCanvas(width, height);
  const sctx = screen.getContext("2d", { willReadFrequently: true });
  const patchCanvas = makeCanvas(width, height);
  const pctx = patchCanvas.getContext("2d");

  const out = [];
  let prevSnapshot = null;
  let dispose = 0;
  let prevDims = null;

  for (const frame of frames) {
    // Apply prior frame's disposal *before* drawing the new frame.
    if (dispose === 2 && prevDims) {
      sctx.clearRect(prevDims.left, prevDims.top, prevDims.width, prevDims.height);
    } else if (dispose === 3 && prevSnapshot) {
      sctx.putImageData(prevSnapshot, 0, 0);
    }

    if (frame.disposalType === 3) {
      prevSnapshot = sctx.getImageData(0, 0, width, height);
    }

    const patchImage = new ImageData(new Uint8ClampedArray(frame.patch), frame.dims.width, frame.dims.height);
    pctx.clearRect(0, 0, width, height);
    pctx.putImageData(patchImage, frame.dims.left, frame.dims.top);
    sctx.drawImage(patchCanvas, 0, 0);

    const snapshot = sctx.getImageData(0, 0, width, height);
    // gifuct-js already converts the GCE delay to milliseconds. Fall back to
    // 100 ms (10 fps) for frames missing a GCE; clamp to 20 ms minimum to
    // match the protocol's stated 50 fps cap.
    const delayMs = Math.max(20, frame.delay || 100);
    out.push({ imageData: snapshot, delayMs });

    dispose = frame.disposalType;
    prevDims = frame.dims;
  }

  return { width, height, frames: out };
}

/** Cover + center-crop an ImageData into a target NxN HTMLCanvasElement. */
function coverCropToCanvas(imageData, srcW, srcH, targetSize) {
  const tmp = makeCanvas(srcW, srcH);
  tmp.getContext("2d").putImageData(imageData, 0, 0);

  const out = makeCanvas(targetSize, targetSize);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";

  const scale = Math.max(targetSize / srcW, targetSize / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const dx = (targetSize - drawW) / 2;
  const dy = (targetSize - drawH) / 2;
  octx.fillStyle = "#000";
  octx.fillRect(0, 0, targetSize, targetSize);
  octx.drawImage(tmp, dx, dy, drawW, drawH);

  return out;
}

/**
 * Normalize a GIF file to a target panel size and re-encode.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {object} opts
 * @param {number} opts.size - target panel size (square)
 * @param {(p) => void} [opts.onProgress]
 * @returns {Promise<{blob: Blob, bytes: Uint8Array, frameCount: number, originalSize: {w:number,h:number}}>}
 */
export async function normalizeGifToPanel(input, { size = 32, onProgress } = {}) {
  const ab = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input;

  onProgress?.({ phase: "decoding" });
  const { width, height, frames } = await decodeGif(ab);

  onProgress?.({ phase: "loading-encoder" });
  const GIF = await ensureGifJs();

  return new Promise((resolve, reject) => {
    const encoder = new GIF({
      workers: 2,
      workerScript: GIF_WORKER_URL,
      quality: 10,
      width: size,
      height: size,
    });

    encoder.on("progress", (p) => onProgress?.({ phase: "encoding", progress: p }));
    encoder.on("finished", (blob) => {
      blob.arrayBuffer().then((buf) => {
        const avgDelayMs = Math.round(
          frames.reduce((s, f) => s + f.delayMs, 0) / Math.max(1, frames.length)
        );
        resolve({
          blob,
          bytes: new Uint8Array(buf),
          frameCount: frames.length,
          originalSize: { w: width, h: height },
          avgDelayMs,
        });
      }, reject);
    });
    encoder.on("abort", () => reject(new Error("GIF encoding aborted")));

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const canvas = coverCropToCanvas(f.imageData, width, height, size);
      encoder.addFrame(canvas, { delay: f.delayMs, copy: true });
      onProgress?.({ phase: "scaling", frame: i + 1, total: frames.length });
    }

    encoder.render();
  });
}
