// Reads the printed text on each bag label with Tesseract.js, to recover the
// part description (which isn't in the 2D code). Runs entirely in the browser.
import { codeFrame, layoutFor } from "./geometry.js";

export const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the OCR engine"));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  workerPromise ??= (async () => {
    await loadScript(TESSERACT_URL);
    return window.Tesseract.createWorker("eng");
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

/**
 * Cut the label's text region out of the photo, straightened so the text is
 * upright, scaled up, greyscaled and contrast-stretched.
 * @param {ImageBitmap|HTMLCanvasElement} source full-resolution photo
 */
export function labelCrop(source, corners, distributor) {
  const f = codeFrame(corners);
  const [a0, a1, b0, b1] = layoutFor(distributor).ocr;
  const spanW = (a1 - a0) * f.w;
  const s = Math.min(480 / f.w, 2000 / spanW, 4);
  const W = Math.round(spanW * s), H = Math.round((b1 - b0) * f.h * s);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  // Image px -> crop px:  X = s*((p-c)·u) - a0*w*s,  Y = s*((p-c)·v) - b0*h*s
  ctx.setTransform(
    s * f.ux, s * f.vx, s * f.uy, s * f.vy,
    -s * (f.cx * f.ux + f.cy * f.uy) - a0 * f.w * s,
    -s * (f.cx * f.vx + f.cy * f.vy) - b0 * f.h * s,
  );
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Greyscale + 1%/99% contrast stretch.
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data, hist = new Uint32Array(256), g = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    g[j] = v; hist[v]++;
  }
  let lo = 0, hi = 255, acc = 0;
  const n = W * H;
  for (; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, (g[j] - lo) * k));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** @returns {Promise<string>} raw OCR text */
export async function readLabel(source, corners, distributor) {
  const worker = await getWorker();
  const canvas = labelCrop(source, corners, distributor);
  await worker.setParameters({ tessedit_pageseg_mode: layoutFor(distributor).psm });
  const { data } = await worker.recognize(canvas);
  return data.text || "";
}
