// Finds and decodes every QR / DataMatrix code in a photo, in the browser,
// using zxing-cpp compiled to WebAssembly (zxing-wasm). Nothing is uploaded.

export const ZXING_URL = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.5/dist/es/reader/index.js";

let zxingPromise = null;
export function loadZxing() {
  zxingPromise ??= import(/* @vite-ignore */ ZXING_URL).catch((e) => {
    zxingPromise = null;
    throw new Error("Couldn't load the barcode decoder — check your connection. (" + e.message + ")");
  });
  return zxingPromise;
}

const OPTIONS = {
  formats: ["QRCode", "DataMatrix", "PDF417", "Aztec"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  tryDownscale: true,
  maxNumberOfSymbols: 64,
  textMode: "Plain",
};

const utf8 = new TextDecoder("utf-8", { fatal: false });

function toCode(r, dx = 0, dy = 0, scale = 1) {
  const p = r.position;
  const pt = (q) => ({ x: q.x * scale + dx, y: q.y * scale + dy });
  let text = r.text || "";
  if (r.bytes && r.bytes.length) text = utf8.decode(r.bytes);
  return {
    format: r.format,
    text,
    corners: [pt(p.topLeft), pt(p.topRight), pt(p.bottomRight), pt(p.bottomLeft)],
  };
}

function center(c) {
  return { x: c.corners.reduce((s, p) => s + p.x, 0) / 4, y: c.corners.reduce((s, p) => s + p.y, 0) / 4 };
}

function addUnique(list, code) {
  const c = center(code);
  const size = Math.hypot(code.corners[1].x - code.corners[0].x, code.corners[1].y - code.corners[0].y);
  const dup = list.find((o) => {
    const oc = center(o);
    return o.text === code.text && Math.hypot(oc.x - c.x, oc.y - c.y) < Math.max(size, 20);
  });
  if (!dup) list.push(code);
}

function crop(src, x, y, w, h) {
  const out = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * src.width + x) * 4;
    out.data.set(src.data.subarray(s, s + w * 4), row * w * 4);
  }
  return out;
}

/**
 * @param {ImageData} img full-resolution photo
 * @param {(msg:string)=>void} [progress]
 * @returns {Promise<Array<{format:string,text:string,corners:{x:number,y:number}[]}>>}
 */
export async function decodeImage(img, progress = () => {}) {
  const { readBarcodes } = await loadZxing();
  const found = [];

  progress("Scanning whole photo…");
  for (const r of await readBarcodes(img, OPTIONS)) if (r.isValid !== false) addUnique(found, toCode(r));

  // Second pass over overlapping tiles: small codes in a big photo are easier to
  // find when each tile is processed at full resolution.
  const { width: W, height: H } = img;
  if (Math.max(W, H) >= 1600) {
    const n = Math.max(W, H) >= 3200 ? 3 : 2;
    const tw = Math.ceil(W / n * 1.3), th = Math.ceil(H / n * 1.3);
    let k = 0;
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        progress(`Scanning section ${++k} of ${n * n}…`);
        const x = Math.min(W - tw, Math.max(0, Math.round(ix * W / n - (tw - W / n) / 2)));
        const y = Math.min(H - th, Math.max(0, Math.round(iy * H / n - (th - H / n) / 2)));
        const tile = crop(img, Math.max(0, x), Math.max(0, y), Math.min(tw, W), Math.min(th, H));
        for (const r of await readBarcodes(tile, OPTIONS)) {
          if (r.isValid !== false) addUnique(found, toCode(r, Math.max(0, x), Math.max(0, y)));
        }
        await new Promise((res) => setTimeout(res, 0)); // let the UI breathe
      }
    }
  }
  return found;
}
