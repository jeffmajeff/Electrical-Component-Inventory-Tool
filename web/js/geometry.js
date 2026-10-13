// Geometry of a decoded code, and where its bag label sits relative to it.
// All measurements are in "code units": multiples of the code's own width (u)
// and height (v), measured in the code's upright frame. This makes the label
// layouts independent of photo resolution and of how the bag is rotated.

/** corners: [topLeft, topRight, bottomRight, bottomLeft] as {x,y} in image px */
export function codeFrame(corners) {
  const [tl, tr, br, bl] = corners;
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;
  const ux0 = (tr.x - tl.x + br.x - bl.x) / 2, uy0 = (tr.y - tl.y + br.y - bl.y) / 2;
  const vx0 = (bl.x - tl.x + br.x - tr.x) / 2, vy0 = (bl.y - tl.y + br.y - tr.y) / 2;
  const w = Math.hypot(ux0, uy0) || 1, h = Math.hypot(vx0, vy0) || 1;
  return {
    cx, cy, w, h,
    ux: ux0 / w, uy: uy0 / w, vx: vx0 / h, vy: vy0 / h,
    angle: Math.atan2(uy0, ux0) * 180 / Math.PI,
  };
}

/** Map code-frame coords (a, b in code units) to image px. */
export function toImage(f, a, b) {
  return { x: f.cx + f.ux * a * f.w + f.vx * b * f.h, y: f.cy + f.uy * a * f.w + f.vy * b * f.h };
}

// Label layout per distributor, in code units relative to the code centre.
//  ring: ellipse around the whole label (centre a,b; radii ra, rb)
//  ocr:  window holding the printed text [a0, a1] x [b0, b1]
const LAYOUTS = {
  // DigiKey: DataMatrix on the left of the label; PN / MPN / Desc rows above-right.
  DigiKey: { ring: { a: 1.3, b: -0.1, ra: 2.45, rb: 2.0 }, ocr: [-0.6, 4.2, -1.55, 1.25], psm: "6" },
  Mouser: { ring: { a: 0, b: 0, ra: 2.6, rb: 2.2 }, ocr: [-3.2, 3.2, -1.8, 1.8], psm: "11" },
  // LCSC: QR on the right; text block to its left.
  LCSC: { ring: { a: -1.0, b: 0.15, ra: 2.2, rb: 1.85 }, ocr: [-2.9, 0.75, -1.35, 1.6], psm: "11" },
  default: { ring: { a: 0, b: 0, ra: 1.9, rb: 1.9 }, ocr: [-2.8, 2.8, -1.6, 1.8], psm: "11" },
};

export function layoutFor(distributor) {
  return LAYOUTS[distributor] || LAYOUTS.default;
}

/** Rotated ellipse (image px) circling the bag label. */
export function labelRing(corners, distributor) {
  const f = codeFrame(corners);
  const r = layoutFor(distributor).ring;
  const c = toImage(f, r.a, r.b);
  return { cx: c.x, cy: c.y, rx: r.ra * f.w, ry: r.rb * f.h, angle: f.angle, frame: f };
}

/** Sort key so packages are numbered top-to-bottom, left-to-right. */
export function readingOrder(items, rowTol) {
  const withC = items.map((it) => ({ it, f: codeFrame(it.corners) }));
  const tol = rowTol ?? Math.max(40, ...withC.map(({ f }) => f.h * 1.5));
  withC.sort((a, b) => (Math.abs(a.f.cy - b.f.cy) > tol ? a.f.cy - b.f.cy : a.f.cx - b.f.cx));
  return withC.map(({ it }) => it);
}
