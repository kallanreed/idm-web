// UI wiring: connect button, file picker / drag-drop, normalize + upload pipeline.

import { IdmDevice, isWebBluetoothSupported } from "./ble.js";
import { normalizeGifToPanel } from "./gif.js";

const PANEL_SIZE = 32; // hard-coded for the 32x32 panel for now

const $ = (id) => document.getElementById(id);

const connectBtn = $("connect-btn");
const scanAllBtn = $("scan-all-btn");
const sendBtn = $("send-btn");
const brightnessRow = $("brightness-row");
const brightnessSlider = $("brightness-slider");
const brightnessValue = $("brightness-value");
const statusEl = $("device-status");
const progressEl = $("progress");
const errorEl = $("error");
const fileInput = $("file-input");
const dropZone = $("drop-zone");
const previews = $("previews");
const previewOriginal = $("preview-original");
const previewNormalized = $("preview-normalized");
const supportNote = $("support-note");

const device = new IdmDevice();
let normalizedBytes = null;     // Uint8Array of the normalized GIF, ready to send
let normalizedAnimMs = 100;     // average frame delay of the normalized GIF
let normalizedBlobUrl = null;
let originalBlobUrl = null;

function setStatus(text) { statusEl.textContent = text; }
function setProgress(text) { progressEl.textContent = text; }
function setError(text) { errorEl.textContent = text || ""; }
function updateSendBtn() {
  sendBtn.disabled = !(device.connected && normalizedBytes);
}

if (!isWebBluetoothSupported()) {
  supportNote.hidden = false;
  connectBtn.disabled = true;
  scanAllBtn.disabled = true;
  setStatus("Web Bluetooth unavailable");
}

device.onDisconnect(() => {
  setStatus("Disconnected");
  connectBtn.textContent = "Connect";
  scanAllBtn.hidden = false;
  brightnessRow.hidden = true;
  updateSendBtn();
});

async function runConnect(opts) {
  setError("");
  if (device.connected) {
    await device.disconnect();
    return;
  }
  try {
    setStatus(opts?.acceptAll ? "Scanning all devices..." : "Selecting device...");
    await device.connect(opts);
    setStatus(`Connected: ${device.deviceName} — probing...`);
    connectBtn.textContent = "Disconnect";
    scanAllBtn.hidden = true;
    brightnessRow.hidden = false;
    updateSendBtn();

    // Non-fatal probe: if it works we learn the panel size. If not, writes
    // probably still work and uploads can be tried.
    try {
      const led = await device.getLedType();
      setStatus(`Connected: ${device.deviceName} (panel ${led.size})`);
    } catch {
      setStatus(`Connected: ${device.deviceName} (probe didn't reply; try brightness)`);
    }
  } catch (err) {
    setStatus("Not connected");
    if (err?.name !== "NotFoundError") setError(err.message || String(err));
  }
}

connectBtn.addEventListener("click", () => runConnect());
scanAllBtn.addEventListener("click", () => runConnect({ acceptAll: true }));

// Brightness slider — live label, send on release (avoids spamming BLE).
brightnessSlider.addEventListener("input", () => {
  brightnessValue.textContent = brightnessSlider.value;
});
brightnessSlider.addEventListener("change", async () => {
  if (!device.connected) return;
  setError("");
  try {
    await device.setBrightness(Number(brightnessSlider.value));
  } catch (err) {
    setError(err.message || String(err));
  }
});

// ---- File handling ----

function revokeIfSet(url) { if (url) URL.revokeObjectURL(url); }

async function handleFile(file) {
  setError("");
  setProgress("");
  normalizedBytes = null;
  updateSendBtn();

  if (!file) return;
  if (!/^image\/gif$/i.test(file.type) && !/\.gif$/i.test(file.name)) {
    setError("Please choose a .gif file.");
    return;
  }

  revokeIfSet(originalBlobUrl);
  originalBlobUrl = URL.createObjectURL(file);
  previewOriginal.src = originalBlobUrl;
  previews.hidden = false;
  previewNormalized.removeAttribute("src");

  try {
    setProgress(`Decoding ${file.name}...`);
    const arrayBuffer = await file.arrayBuffer();
    const result = await normalizeGifToPanel(arrayBuffer, {
      size: PANEL_SIZE,
      onProgress: (p) => {
        if (p.phase === "scaling") setProgress(`Scaling frame ${p.frame}/${p.total}`);
        else if (p.phase === "encoding") setProgress(`Encoding ${(p.progress * 100).toFixed(0)}%`);
        else if (p.phase === "loading-encoder") setProgress("Loading encoder...");
        else if (p.phase === "decoding") setProgress("Decoding GIF...");
      },
    });
    normalizedBytes = result.bytes;
    normalizedAnimMs = result.avgDelayMs;
    revokeIfSet(normalizedBlobUrl);
    normalizedBlobUrl = URL.createObjectURL(result.blob);
    previewNormalized.src = normalizedBlobUrl;
    setProgress(`Ready: ${result.frameCount} frame(s), ${result.bytes.length} bytes, ~${result.avgDelayMs}ms/frame (from ${result.originalSize.w}x${result.originalSize.h})`);
    updateSendBtn();
  } catch (err) {
    setError(err.message || String(err));
    setProgress("");
  }
}

fileInput.addEventListener("change", () => {
  handleFile(fileInput.files?.[0]);
});

// Drag & drop (desktop)
["dragenter", "dragover"].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
  });
});
dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// ---- Send ----

sendBtn.addEventListener("click", async () => {
  if (!normalizedBytes || !device.connected) return;
  setError("");
  sendBtn.disabled = true;
  try {
    setProgress("Uploading...");
    await device.sendGifPreview(normalizedBytes, {
      animMs: normalizedAnimMs,
      onProgress: ({ sent, total }) => setProgress(`Uploading ${sent}/${total} bytes`),
    });
    setProgress("Sent.");
  } catch (err) {
    setError(err.message || String(err));
  } finally {
    updateSendBtn();
  }
});
