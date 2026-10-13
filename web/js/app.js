import { parseCode, distributorUrl } from "./parsers.js";
import { classify, TYPES, TYPE_COLORS, packageRank, parseValueString, formatSI } from "./classify.js";
import { extractLabelInfo } from "./labeltext.js";
import { decodeImage, loadZxing } from "./decode.js";
import { readLabel } from "./ocr.js";
import { labelRing, readingOrder } from "./geometry.js";
import { readBomFile, rowsToBom, matchBom, bomLineLabel } from "./bom.js";
import * as store from "./store.js";

// ---------------------------------------------------------------- state
const state = {
  view: "photo",          // "photo" (latest scan) | "inv" (cumulative inventory)
  photo: null,            // latest scan {id,name,created,width,height,blob,url,canvas,items}
  inventory: [],          // saved items
  photoUrls: new Map(),   // photoId -> {url,width,height,name,created}
  shown: null,            // photo in the viewer {id,url,width,height,name,created}
  selectedId: null,
  typeFilter: null,
  search: "",
  groupByType: true,
  sortKey: "value",
  bomOnly: false,
  bom: null,
  match: null,
  ocrEnabled: true,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------- items
function currentItems() {
  return state.view === "photo" ? (state.photo?.items ?? []) : state.inventory;
}

function findItem(id) {
  return currentItems().find((i) => i.id === id);
}

/** Effective (user-overridden) view of an item, with classification. */
function eff(item) {
  const o = item.overrides || {};
  const part = item.part;
  const description = o.description ?? (item.ocr?.description || part.description || "");
  const manufacturer = part.manufacturer || item.ocr?.manufacturer || "";
  const cls = classify({ mpn: part.mpn, description });
  if (o.type) cls.type = o.type;
  if (o.value) {
    cls.value = o.value;
    const v = parseValueString(o.value, cls.type);
    cls.valueNum = v;
    if (v != null) {
      const unit = { Resistor: "Ω", Potentiometer: "Ω", Capacitor: "F", Inductor: "H" }[cls.type] || "";
      cls.value = formatSI(v, unit);
    }
  }
  if (o.package) cls.package = o.package;
  return { description, manufacturer, cls, notes: o.notes || "" };
}

function makeItem(code, photoId) {
  const part = parseCode(code.text);
  if (!part) return null;
  return {
    id: part.packageId || `${photoId}:${code.text}`,
    photoId,
    num: 0,
    corners: code.corners,
    format: code.format,
    part,
    ocr: { status: "pending", text: "", description: "", manufacturer: "" },
    overrides: {},
    saved: false,
  };
}

// ---------------------------------------------------------------- photo intake
const MAX_PIXELS = 16_000_000;   // iOS Safari canvas limit is ~16.7 MP
const DISPLAY_MAX = 2400;

async function handleImageFile(file) {
  if (!file) return;
  setView("photo");
  setStatus("Loading photo…");
  try {
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { bitmap = await createImageBitmap(file); }
    const k = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
    const W = Math.round(bitmap.width * k), H = Math.round(bitmap.height * k);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, W, H);
    bitmap.close?.();

    const blob = await downscale(canvas, DISPLAY_MAX);
    if (state.photo?.url) URL.revokeObjectURL(state.photo.url);
    if (state.photo?.canvas) state.photo.canvas.width = 0;
    const photo = {
      id: "ph_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: file.name || "photo.jpg", created: Date.now(), width: W, height: H,
      blob, url: URL.createObjectURL(blob), canvas, items: [],
    };
    state.photo = photo;
    state.selectedId = null;
    showPhoto(photo);
    renderAll();

    setStatus("Loading decoder…");
    const codes = await decodeImage(ctx.getImageData(0, 0, W, H), setStatus);
    if (state.photo !== photo) return;

    const seen = new Set();
    for (const code of codes) {
      const it = makeItem(code, photo.id);
      if (it && !seen.has(it.id)) { seen.add(it.id); photo.items.push(it); }
    }
    readingOrder(photo.items).forEach((it, i) => { it.num = i + 1; });
    photo.items.sort((a, b) => a.num - b.num);

    // Packages already in the inventory keep the user's edits.
    const inv = new Map(state.inventory.map((i) => [i.id, i]));
    for (const it of photo.items) {
      const prev = inv.get(it.id);
      if (prev) { it.overrides = { ...prev.overrides }; it.known = true; }
    }

    setStatus(null);
    recomputeMatch();
    renderAll();
    const known = photo.items.filter((i) => i.known).length;
    toast(photo.items.length
      ? `Found ${photo.items.length} package${photo.items.length > 1 ? "s" : ""}${known ? ` (${known} already in inventory)` : ""}`
      : "No QR / DataMatrix codes found. Try a closer, sharper photo.");
    if (photo.items.length && state.ocrEnabled) runOcr(photo);
  } catch (e) {
    console.error(e);
    setStatus(null);
    toast(e.message || String(e));
  }
}

function downscale(canvas, max) {
  const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => { c.width = 0; res(b); }, "image/jpeg", 0.85));
}

async function runOcr(photo) {
  const todo = photo.items.filter((i) => i.ocr.status === "pending");
  let failed = false;
  for (let n = 0; n < todo.length; n++) {
    if (state.photo !== photo || !state.ocrEnabled) return;
    const it = todo[n];
    setStatus(`Reading label text ${n + 1} of ${todo.length}…`, true);
    it.ocr.status = "running";
    try {
      const text = await readLabel(photo.canvas, it.corners, it.part.distributor);
      const info = extractLabelInfo(text, it.part.distributor);
      Object.assign(it.ocr, { status: "done", text, ...info });
    } catch (e) {
      console.warn("OCR failed", e);
      it.ocr.status = "error";
      failed = true;
      if (/load/i.test(e.message)) { todo.slice(n + 1).forEach((t) => { t.ocr.status = "error"; }); break; }
    }
    if (it.saved) await persist(it);
    recomputeMatch();
    renderAll({ keepViewer: true });
  }
  if (state.photo === photo) setStatus(null);
  if (failed) toast("Couldn't read some label text — tap a row to add a description.");
}

// ---------------------------------------------------------------- inventory
async function loadInventory() {
  try {
    const parts = await store.getAllParts();
    state.inventory = parts.map((p) => ({ ...p, saved: true, overrides: p.overrides || {}, ocr: p.ocr || { status: "done" } }));
  } catch (e) {
    console.warn("IndexedDB unavailable", e);
    state.inventory = [];
  }
  $("inv-count").textContent = state.inventory.length ? String(state.inventory.length) : "";
}

function toRecord(it) {
  const { saved, known, ...rec } = it;
  return { ...rec, ocr: { status: it.ocr.status === "running" ? "pending" : it.ocr.status, text: it.ocr.text || "", description: it.ocr.description || "", manufacturer: it.ocr.manufacturer || "" } };
}

async function persist(it) {
  try { await store.putPart(toRecord(it)); } catch (e) { console.warn(e); }
}

async function saveCurrentPhoto() {
  const photo = state.photo;
  if (!photo?.items.length) return;
  const inv = new Map(state.inventory.map((i) => [i.id, i]));
  const records = photo.items.map((it) => {
    const prev = inv.get(it.id);
    const rec = toRecord(it);
    if (prev) {
      rec.overrides = { ...prev.overrides, ...rec.overrides };
      // A worse (or unfinished) label read never replaces a good one from an earlier scan.
      if (prev.ocr?.description && !rec.ocr.description) rec.ocr = prev.ocr;
      rec.created = prev.created;
    }
    return rec;
  });
  try {
    const { added, updated } = await store.savePhotoWithParts(
      { id: photo.id, name: photo.name, created: photo.created, width: photo.width, height: photo.height, blob: photo.blob },
      records,
    );
    photo.items.forEach((it) => { it.saved = true; });
    state.photoUrls.set(photo.id, { url: photo.url, width: photo.width, height: photo.height, name: photo.name, created: photo.created });
    await loadInventory();
    toast(`Saved: ${added} new${updated ? `, ${updated} updated` : ""}. Inventory has ${state.inventory.length} packages.`);
    renderToolbar();
  } catch (e) {
    toast("Couldn't save: " + e.message);
  }
}

async function photoForId(id) {
  if (state.photo?.id === id) return state.photo;
  if (state.photoUrls.has(id)) return { id, ...state.photoUrls.get(id) };
  const p = await store.getPhoto(id);
  if (!p?.blob) return null;
  const meta = { url: URL.createObjectURL(p.blob), width: p.width, height: p.height, name: p.name, created: p.created };
  state.photoUrls.set(id, meta);
  return { id, ...meta };
}

// ---------------------------------------------------------------- BOM
function recomputeMatch() {
  if (!state.bom) { state.match = null; return; }
  const items = currentItems().map((it) => ({ id: it.id, mpn: it.part.mpn, distributorPN: it.part.distributorPN, cls: eff(it).cls }));
  state.match = matchBom(state.bom, items);
}

async function handleBomFile(file) {
  if (!file) return;
  try {
    const bom = await readBomFile(file);
    if (!bom.lines.length) throw new Error("No rows found in that file");
    state.bom = bom;
    ls.set("bom", { name: bom.name, rows: [bom.headerFound ? headerRowFrom(bom) : null, ...bom.lines.map((l) => l.cells)].filter(Boolean) });
    recomputeMatch();
    renderAll({ keepViewer: true });
    const m = state.match;
    toast(`BOM loaded: ${bom.lines.length} lines, ${m.byLine.size} found ${state.view === "photo" ? "in this photo" : "in inventory"}`);
  } catch (e) {
    toast("Couldn't read BOM: " + e.message);
  }
}

function headerRowFrom(bom) {
  // Rebuild a header row from the column map so the BOM can be restored after reload.
  const width = Math.max(...bom.lines.map((l) => l.cells.length));
  const row = Array(width).fill("");
  const names = { refs: "Reference", qty: "Qty", value: "Value", footprint: "Footprint", mpn: "MPN", manufacturer: "Manufacturer", lcsc: "LCSC", digikey: "DigiKey", mouser: "Mouser", description: "Description" };
  for (const [k, i] of Object.entries(bom.columns)) row[i] = names[k];
  return row;
}

function restoreBom() {
  const saved = ls.get("bom", null);
  if (saved?.rows?.length) {
    state.bom = rowsToBom(saved.rows, saved.name);
  }
}

// ---------------------------------------------------------------- filtering / sorting
function filteredItems() {
  const q = state.search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  return currentItems().filter((it) => {
    const e = eff(it);
    if (state.typeFilter && e.cls.type !== state.typeFilter) return false;
    if (state.bomOnly && state.match && !state.match.byItem.has(it.id)) return false;
    if (!terms.length) return true;
    const hay = [it.part.mpn, it.part.distributorPN, it.part.distributor, e.description, e.manufacturer,
      e.cls.type, e.cls.value, e.cls.package, e.cls.dielectric, e.notes,
      e.cls.voltage != null ? `${e.cls.voltage}v` : "", e.cls.tolerance != null ? `${e.cls.tolerance}%` : ""]
      .join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function sortItems(items) {
  const k = state.sortKey;
  const key = (it) => {
    const c = eff(it).cls;
    switch (k) {
      case "value": return [c.valueNum ?? Infinity, packageRank(c.package), it.part.mpn];
      case "package": return [packageRank(c.package), c.package || "~", c.valueNum ?? Infinity];
      case "voltage": return [c.voltage ?? Infinity, c.valueNum ?? Infinity];
      case "tolerance": return [c.tolerance ?? Infinity, c.valueNum ?? Infinity];
      case "qty": return [-(it.part.qty ?? -1)];
      case "mpn": return [it.part.mpn.toLowerCase()];
      default: return [it.photoId, it.num];
    }
  };
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (typeof a[i] === "number" && typeof b[i] === "number") return a[i] - b[i];
      return String(a[i]).localeCompare(String(b[i]), undefined, { numeric: true });
    }
    return 0;
  };
  return items.map((it) => [key(it), it]).sort((a, b) => cmp(a[0], b[0])).map((x) => x[1]);
}

// ---------------------------------------------------------------- rendering
function renderAll(opts = {}) {
  renderToolbar();
  renderChips();
  renderBom();
  renderList();
  if (!opts.keepViewer || state.shown) renderOverlay();
}

function renderToolbar() {
  $("tab-photo").setAttribute("aria-selected", String(state.view === "photo"));
  $("tab-inv").setAttribute("aria-selected", String(state.view === "inv"));
  const save = $("save-btn");
  const p = state.photo;
  const canSave = state.view === "photo" && p?.items.length;
  save.hidden = !canSave;
  if (canSave) {
    const all = p.items.every((i) => i.saved);
    save.disabled = all;
    save.textContent = all ? "Saved ✓" : `Save ${p.items.length} to inventory`;
  }
  const s = state.shown;
  let cap = "";
  if (s) {
    const n = currentItems().filter((i) => i.photoId === s.id).length;
    const d = new Date(s.created || Date.now());
    cap = `${n} package${n === 1 ? "" : "s"} · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  } else if (state.view === "inv") {
    cap = state.inventory.length ? "Tap a part to see its photo" : "";
  }
  $("photo-caption").textContent = cap;
  $("viewer-wrap").classList.toggle("empty", !s);
  $("empty-hint").innerHTML = state.view === "inv" && !s
    ? (state.inventory.length ? "<p>Tap a part below to show the photo it was scanned in.</p>"
      : "<p><strong>Your inventory is empty.</strong></p><p>Scan a photo, then tap <em>Save to inventory</em>.</p>")
    : "<p><strong>Lay your component bags out flat</strong>, labels facing up, and take one photo.</p><p>DigiKey, Mouser and LCSC labels are read automatically.</p>";
}

function renderChips() {
  const counts = new Map();
  for (const it of currentItems()) {
    const t = eff(it).cls.type;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const types = TYPES.filter((t) => counts.has(t));
  if (state.typeFilter && !counts.has(state.typeFilter)) state.typeFilter = null;
  const total = currentItems().length;
  $("chips").innerHTML = (total ? [
    `<button class="chip" data-type="" aria-pressed="${!state.typeFilter}">All <span class="n">${total}</span></button>`,
    ...types.map((t) => `<button class="chip" data-type="${esc(t)}" aria-pressed="${state.typeFilter === t}">
      <span class="dot" style="background:${TYPE_COLORS[t]}"></span>${esc(t)} <span class="n">${counts.get(t)}</span></button>`),
  ] : []).join("");
}

function renderBom() {
  const panel = $("bom-panel");
  $("bom-only-wrap").hidden = !state.bom;
  if (!state.bom) { panel.hidden = true; return; }
  panel.hidden = false;
  const { lines } = state.bom;
  const m = state.match || { byLine: new Map(), byItem: new Map() };
  let exact = 0, param = 0;
  for (const l of lines) { const r = m.byLine.get(l.idx); if (r?.kind === "exact") exact++; else if (r) param++; }
  const where = state.view === "photo" ? "in this photo" : "in inventory";
  $("bom-name").textContent = state.bom.name;
  $("bom-summary").innerHTML = `<b>${exact + param}</b> of ${lines.length} lines found ${where}`
    + (param ? ` · <span style="color:var(--warn)">${param} by value</span>` : "")
    + (currentItems().length ? ` · ${lines.length - exact - param} missing` : "");
  const qtyHave = (r) => r ? r.items.map((id) => findItem(id)?.part.qty || 0).reduce((a, b) => a + b, 0) : 0;
  $("bom-lines").innerHTML = lines.map((l) => {
    const r = m.byLine.get(l.idx);
    const st = r ? r.kind : "missing";
    const sym = { exact: "✓", param: "≈", missing: "–" }[st];
    const nums = r ? r.items.map((id) => findItem(id)).filter(Boolean).map((i) => `#${i.num}`).join(" ") : "";
    const have = r ? qtyHave(r) : 0;
    const need = l.qty ? ` · need ${l.qty}` : "";
    const haveTxt = r ? ` · have ${have}` : "";
    return `<li class="${st}" data-line="${l.idx}"><span class="st ${st}">${sym}</span>
      <span class="lbl">${esc(bomLineLabel(l))}</span>
      <span style="margin-left:auto;color:var(--ink-3);white-space:nowrap">${esc(nums)}${need}${haveTxt}</span></li>`;
  }).join("");
}

function renderList() {
  const list = $("list");
  const items = filteredItems();
  if (!currentItems().length) {
    list.innerHTML = `<div class="empty-list">${state.view === "photo" ? "Scanned packages will appear here." : "No saved packages yet."}</div>`;
    return;
  }
  if (!items.length) { list.innerHTML = `<div class="empty-list">Nothing matches.</div>`; return; }

  let html = "";
  if (state.groupByType) {
    const groups = new Map();
    for (const it of items) {
      const t = eff(it).cls.type;
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(it);
    }
    for (const t of TYPES) {
      if (!groups.has(t)) continue;
      const g = sortItems(groups.get(t));
      html += `<div class="group-head"><span class="dot" style="background:${TYPE_COLORS[t]}"></span>${esc(t)} <span class="n">${g.length}</span></div>`;
      html += g.map(rowHtml).join("");
    }
  } else {
    html = sortItems(items).map(rowHtml).join("");
  }
  list.innerHTML = html;
}

function rowHtml(it) {
  const e = eff(it), c = e.cls, p = it.part;
  const bm = state.match?.byItem.get(it.id);
  const sel = it.id === state.selectedId;
  const title = c.value || p.mpn || p.distributorPN || "Unknown part";
  const tp = c.subtype || c.type;
  const pills = [
    c.package, c.tolerance != null ? `${c.tolerance}%` : "", c.voltage != null ? `${c.voltage}V` : "",
    c.dielectric, c.power, e.manufacturer,
  ].filter(Boolean).map((x) => `<span class="pill">${esc(x)}</span>`);
  if (bm) {
    const refs = bm.lines.map((i) => state.bom.lines.find((l) => l.idx === i)).filter(Boolean)
      .map((l) => l.refs || l.value || "BOM").join(", ");
    pills.push(`<span class="pill bom ${bm.kind}">${bm.kind === "exact" ? "BOM ✓" : "BOM ≈"} ${esc(truncate(refs, 40))}</span>`);
  }
  let desc;
  if (e.description) desc = `<div class="desc">${esc(e.description)}</div>`;
  else if (it.ocr?.status === "pending" || it.ocr?.status === "running") desc = `<div class="desc pending">Reading label…</div>`;
  else desc = "";
  const idsLine = [
    c.value && p.mpn ? `<span>${esc(p.mpn)}</span>` : "",
    p.distributorPN && p.distributorPN !== p.mpn ? `<span class="dist">${esc(p.distributor)} ${esc(p.distributorPN)}</span>` : `<span class="dist">${esc(p.distributor)}</span>`,
  ].filter(Boolean).join(" · ");

  return `<article class="row${sel ? " selected" : ""}${bm ? " bom-" + bm.kind : ""}" data-id="${esc(it.id)}" style="--tcolor:${TYPE_COLORS[c.type]}">
    <div class="num">${it.num || "·"}</div>
    <div class="title">${esc(title)} <span class="tp">${esc(tp)}</span></div>
    <div class="qty">${p.qty != null ? `<small>×</small>${p.qty}` : ""}</div>
    <div class="ids">${idsLine}</div>
    ${desc}
    ${pills.length ? `<div class="pills">${pills.join("")}</div>` : ""}
    ${sel ? detailHtml(it, e) : ""}
  </article>`;
}

function detailHtml(it, e) {
  const p = it.part, o = it.overrides || {};
  const url = distributorUrl(p);
  const meta = [
    ["Distributor", p.distributor], ["Dist. PN", p.distributorPN], ["MPN", p.mpn], ["Manufacturer", e.manufacturer],
    ["Qty", p.qty], ["Date code", p.dateCode], ["Lot", p.lotCode], ["Origin", p.countryOfOrigin],
    ["Order", p.salesOrder], ["Invoice", p.invoice],
  ].filter(([, v]) => v != null && v !== "");
  return `<div class="detail" data-detail>
    <div class="fields">
      <label class="wide">Description<textarea data-field="description" rows="2" placeholder="e.g. RES 100K 1% 0402">${esc(o.description ?? e.description)}</textarea></label>
      <label>Type<select data-field="type">${TYPES.map((t) => `<option ${t === e.cls.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Value<input data-field="value" value="${esc(o.value ?? e.cls.value)}" placeholder="100k, 0.1uF…"></label>
      <label>Package<input data-field="package" value="${esc(o.package ?? e.cls.package)}" placeholder="0402, SOT-23…"></label>
      <label>Notes<input data-field="notes" value="${esc(o.notes ?? "")}" placeholder="Drawer 3, bin B"></label>
    </div>
    <dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div class="links">
      ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Open on ${esc(p.distributor === "Unknown" || p.distributor === "ECIA label" ? "Octopart" : p.distributor)} ↗</a>` : ""}
      ${Object.keys(o).length ? `<button class="btn small" data-act="reset">Undo my edits</button>` : ""}
      ${it.saved && state.view === "inv" ? `<button class="btn small danger" data-act="delete">Remove from inventory</button>` : ""}
    </div>
    <details><summary style="font-size:12px;color:var(--ink-3);cursor:pointer">Raw code${it.ocr?.text ? " & label text" : ""}</summary>
      <div class="raw">${esc(visibleControls(p.raw))}${it.ocr?.text ? "\n\n— OCR —\n" + esc(it.ocr.text) : ""}</div>
    </details>
  </div>`;
}

const visibleControls = (s) => String(s || "").replace(/\x1e/g, "␞").replace(/\x1d/g, "␝").replace(/\x04/g, "␄");
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------------------------------------------------------------- viewer (pan / zoom / rings)
const view = { fit: 1, z: 1, tx: 0, ty: 0, vw: 0, vh: 0 };

function showPhoto(photo) {
  state.shown = photo ? { id: photo.id, url: photo.url, width: photo.width, height: photo.height, name: photo.name, created: photo.created } : null;
  const svg = $("overlay");
  if (!photo) { svg.innerHTML = ""; renderToolbar(); return; }
  svg.setAttribute("viewBox", `0 0 ${photo.width} ${photo.height}`);
  svg.innerHTML = `<image href="${photo.url}" x="0" y="0" width="${photo.width}" height="${photo.height}" preserveAspectRatio="none"/><g id="rings"></g>`;
  resetZoom(false);
  renderToolbar();
}

function measure() {
  const r = $("viewer").getBoundingClientRect();
  view.vw = r.width; view.vh = r.height;
  const s = state.shown;
  if (!s) return;
  view.fit = Math.min(view.vw / s.width, view.vh / s.height);
  const stage = $("stage");
  stage.style.width = `${s.width * view.fit}px`;
  stage.style.height = `${s.height * view.fit}px`;
}

function applyTransform(animate) {
  const stage = $("stage");
  stage.style.transition = animate ? "transform .35s cubic-bezier(.2,.8,.2,1)" : "none";
  stage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
  $("viewer").classList.toggle("zoomed", view.z > 1.01);
}

function clampView() {
  const s = state.shown;
  if (!s) return;
  const w = s.width * view.fit * view.z, h = s.height * view.fit * view.z;
  view.tx = w <= view.vw ? (view.vw - w) / 2 : Math.min(0, Math.max(view.vw - w, view.tx));
  view.ty = h <= view.vh ? (view.vh - h) / 2 : Math.min(0, Math.max(view.vh - h, view.ty));
}

function resetZoom(animate = true) {
  measure();
  view.z = 1; view.tx = 0; view.ty = 0;
  clampView(); applyTransform(animate); renderOverlay();
}

function zoomAt(z, px, py, animate) {
  const nz = Math.max(1, Math.min(8, z));
  // keep the image point under (px,py) fixed
  view.tx = px - (px - view.tx) * (nz / view.z);
  view.ty = py - (py - view.ty) * (nz / view.z);
  view.z = nz;
  clampView(); applyTransform(animate);
}

function focusItem(it) {
  if (!state.shown || it.photoId !== state.shown.id) return;
  measure();
  const r = labelRing(it.corners, it.part.distributor);
  const span = 2 * Math.max(r.rx, r.ry) * view.fit;
  const z = Math.max(1, Math.min(4, Math.min(view.vw, view.vh) * 0.7 / span));
  view.z = z;
  view.tx = view.vw / 2 - r.cx * view.fit * z;
  view.ty = view.vh / 2 - r.cy * view.fit * z;
  clampView(); applyTransform(true); renderOverlay();
}

function renderOverlay() {
  const g = document.getElementById("rings");
  if (!g || !state.shown) return;
  const visible = new Set(filteredItems().map((i) => i.id));
  const filtering = state.typeFilter || state.search.trim() || state.bomOnly;
  const items = currentItems().filter((i) => i.photoId === state.shown.id);
  const badgeR = 13 / (view.fit * view.z || 1);
  // Draw the selected ring last so it sits on top.
  items.sort((a, b) => (a.id === state.selectedId) - (b.id === state.selectedId));
  g.innerHTML = items.map((it) => {
    const r = labelRing(it.corners, it.part.distributor);
    const e = eff(it);
    const bm = state.match?.byItem.get(it.id);
    const cls = ["ring"];
    let style = "";
    if (it.id === state.selectedId) cls.push("selected");
    else if (bm) cls.push("bom-" + bm.kind);
    else if (filtering && visible.has(it.id) && state.typeFilter) { cls.push("type"); style = `stroke:${TYPE_COLORS[e.cls.type]}`; }
    else if (filtering && !visible.has(it.id)) cls.push("dim");
    else if (state.bom) cls.push("dim");
    const t = `rotate(${r.angle.toFixed(2)} ${r.cx.toFixed(1)} ${r.cy.toFixed(1)})`;
    // badge at the top-left of the ellipse, in screen orientation
    const bx = r.cx - r.rx * 0.72, by = r.cy - r.ry * 0.72;
    const rot = r.angle * Math.PI / 180;
    const dx = bx - r.cx, dy = by - r.cy;
    const qx = r.cx + dx * Math.cos(rot) - dy * Math.sin(rot);
    const qy = r.cy + dx * Math.sin(rot) + dy * Math.cos(rot);
    const bcls = ["badge-bg"];
    if (it.id === state.selectedId) bcls.push("selected"); else if (bm) bcls.push("bom-" + bm.kind);
    return `<g data-id="${esc(it.id)}">
      <ellipse class="ring-hit" cx="${r.cx}" cy="${r.cy}" rx="${r.rx}" ry="${r.ry}" transform="${t}"/>
      <ellipse class="${cls.join(" ")}" style="${style}" cx="${r.cx}" cy="${r.cy}" rx="${r.rx}" ry="${r.ry}" transform="${t}"/>
      <circle class="${bcls.join(" ")}" cx="${qx}" cy="${qy}" r="${badgeR}"/>
      <text class="badge-txt" x="${qx}" y="${qy}" font-size="${badgeR * 1.15}">${it.num}</text>
    </g>`;
  }).join("");
}

function initViewer() {
  const el = $("viewer");
  const pts = new Map();
  let start = null, lastTap = 0, moved = false;

  el.addEventListener("pointerdown", (e) => {
    if (!state.shown) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, t: Date.now() };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const r = el.getBoundingClientRect();
      start = { pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y), z: view.z, tx: view.tx, ty: view.ty,
        mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
    }
    if (view.z > 1.01 || pts.size === 2) el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (start.pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const nz = Math.max(1, Math.min(8, start.z * d / start.d));
      view.tx = start.mx - (start.mx - start.tx) * (nz / start.z);
      view.ty = start.my - (start.my - start.ty) * (nz / start.z);
      view.z = nz; moved = true;
      clampView(); applyTransform(false);
    } else if (!start.pinch && view.z > 1.01) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 6) moved = true;
      view.tx = start.tx + dx; view.ty = start.ty + dy;
      clampView(); applyTransform(false);
    } else if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) moved = true;
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (start?.pinch) { if (pts.size === 0) { start = null; renderOverlay(); } return; }
    if (pts.size === 0 && start && !moved && Date.now() - start.t < 400) {
      const now = Date.now();
      const r = el.getBoundingClientRect();
      if (now - lastTap < 300) {               // double-tap: zoom in / reset
        lastTap = 0;
        if (view.z > 1.01) resetZoom(); else { zoomAt(2.5, e.clientX - r.left, e.clientY - r.top, true); renderOverlay(); }
      } else {
        lastTap = now;
        const hit = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest?.("[data-id]")).find((n) => n && el.contains(n));
        if (hit) selectItem(hit.dataset.id, { fromPhoto: true });
      }
    } else if (moved) renderOverlay();
    start = null;
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); start = null; });
  el.addEventListener("wheel", (e) => {
    if (!state.shown) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    zoomAt(view.z * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top, false);
    clearTimeout(initViewer.t); initViewer.t = setTimeout(renderOverlay, 120);
  }, { passive: false });
  new ResizeObserver(() => { if (state.shown) { const z = view.z; measure(); if (z <= 1.01) resetZoom(false); else { clampView(); applyTransform(false); } } }).observe(el);
}

// ---------------------------------------------------------------- selection
async function selectItem(id, { fromPhoto = false, toggle = false } = {}) {
  if (toggle && state.selectedId === id) { state.selectedId = null; renderList(); renderOverlay(); return; }
  state.selectedId = id;
  const it = findItem(id);
  if (it && (!state.shown || state.shown.id !== it.photoId)) {
    const ph = await photoForId(it.photoId);
    if (ph) showPhoto(ph);
  }
  renderList();
  renderOverlay();
  if (it) {
    if (!fromPhoto) focusItem(it);
    const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row && fromPhoto) {
      const top = row.getBoundingClientRect().top;
      const viewerBottom = $("viewer-wrap").getBoundingClientRect().bottom;
      if (top < viewerBottom || top > window.innerHeight - 80) {
        window.scrollBy({ top: top - viewerBottom - 8, behavior: "smooth" });
      }
    }
  }
}

// ---------------------------------------------------------------- misc UI
function setStatus(msg) {
  const el = $("status");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  $("status-text").textContent = msg;
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  state.selectedId = null;
  state.typeFilter = null;
  if (v === "photo") showPhoto(state.photo);
  else {
    // show the most recent inventory photo, if any
    const latest = [...state.inventory].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    showPhoto(null);
    if (latest) photoForId(latest.photoId).then((ph) => { if (ph && state.view === "inv") { showPhoto(ph); renderOverlay(); } });
  }
  recomputeMatch();
  renderAll();
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportCsv() {
  const items = sortItems(filteredItems());
  const head = ["#", "Type", "Value", "Package", "Tolerance %", "Voltage V", "Dielectric", "MPN", "Manufacturer", "Description", "Qty",
    "Distributor", "Distributor PN", "Date code", "Lot", "Notes", "BOM"];
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = items.map((it) => {
    const e = eff(it), c = e.cls, p = it.part;
    const bm = state.match?.byItem.get(it.id);
    return [it.num, c.type, c.value, c.package, c.tolerance, c.voltage, c.dielectric, p.mpn, e.manufacturer, e.description, p.qty,
      p.distributor, p.distributorPN, p.dateCode, p.lotCode, e.notes, bm ? bm.kind : ""].map(q).join(",");
  });
  download(new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" }),
    `parts-${state.view === "photo" ? "photo" : "inventory"}-${new Date().toISOString().slice(0, 10)}.csv`);
}

function bindEvents() {
  $("file-camera").addEventListener("change", (e) => { handleImageFile(e.target.files[0]); e.target.value = ""; });
  $("file-photo").addEventListener("change", (e) => { handleImageFile(e.target.files[0]); e.target.value = ""; });
  $("file-bom").addEventListener("change", (e) => { handleBomFile(e.target.files[0]); e.target.value = ""; });
  $("tab-photo").addEventListener("click", () => setView("photo"));
  $("tab-inv").addEventListener("click", () => setView("inv"));
  $("save-btn").addEventListener("click", saveCurrentPhoto);
  $("zoom-reset").addEventListener("click", () => resetZoom());

  $("search").addEventListener("input", (e) => { state.search = e.target.value; renderList(); renderOverlay(); });
  $("group-type").addEventListener("change", (e) => { state.groupByType = e.target.checked; ls.set("groupByType", state.groupByType); renderList(); });
  $("sort").addEventListener("change", (e) => { state.sortKey = e.target.value; ls.set("sortKey", state.sortKey); renderList(); });
  $("bom-only").addEventListener("change", (e) => { state.bomOnly = e.target.checked; renderList(); renderOverlay(); });
  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const t = b.dataset.type || null;
    state.typeFilter = state.typeFilter === t ? null : t;
    renderChips(); renderList(); renderOverlay();
  });

  $("bom-toggle").addEventListener("click", () => {
    const ul = $("bom-lines");
    ul.hidden = !ul.hidden;
    $("bom-toggle").setAttribute("aria-expanded", String(!ul.hidden));
  });
  $("bom-clear").addEventListener("click", () => {
    state.bom = null; state.match = null; state.bomOnly = false; $("bom-only").checked = false;
    ls.set("bom", null); renderAll({ keepViewer: true });
  });
  $("bom-lines").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-line]");
    if (!li) return;
    const r = state.match?.byLine.get(Number(li.dataset.line));
    if (!r?.items.length) { toast("Not found " + (state.view === "photo" ? "in this photo" : "in inventory")); return; }
    const i = r.items.indexOf(state.selectedId);
    selectItem(r.items[(i + 1) % r.items.length]);
  });

  const list = $("list");
  list.addEventListener("click", async (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    const it = findItem(row.dataset.id);
    if (act === "reset" && it) {
      it.overrides = {}; if (it.saved) await persist(it);
      recomputeMatch(); renderAll({ keepViewer: true }); return;
    }
    if (act === "delete" && it) {
      if (!confirm(`Remove ${it.part.mpn || it.part.distributorPN} from the inventory?`)) return;
      await store.deletePart(it.id);
      await loadInventory();
      state.selectedId = null; recomputeMatch(); renderAll(); return;
    }
    if (e.target.closest("[data-detail]")) return;
    selectItem(row.dataset.id, { toggle: true });
  });
  list.addEventListener("change", async (e) => {
    const f = e.target.dataset?.field;
    if (!f) return;
    const it = findItem(e.target.closest(".row").dataset.id);
    if (!it) return;
    const v = e.target.value.trim();
    it.overrides = { ...it.overrides };
    if (v) it.overrides[f] = v; else delete it.overrides[f];
    if (it.saved) await persist(it);
    // keep the same package's edits in step between the photo and inventory views
    for (const other of [...(state.photo?.items ?? []), ...state.inventory]) {
      if (other !== it && other.id === it.id) other.overrides = { ...it.overrides };
    }
    recomputeMatch(); renderAll({ keepViewer: true });
  });

  // menu
  const menu = $("menu");
  $("menu-btn").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  $("opt-ocr").addEventListener("change", (e) => {
    state.ocrEnabled = e.target.checked; ls.set("ocr", state.ocrEnabled);
    if (state.ocrEnabled && state.photo?.items.some((i) => i.ocr.status === "pending")) runOcr(state.photo);
  });
  menu.addEventListener("click", async (e) => {
    const act = e.target.closest("button[data-act]")?.dataset.act;
    if (!act) return;
    menu.hidden = true;
    if (act === "export-csv") exportCsv();
    if (act === "backup") download(await store.exportBackup(), `parts-inventory-backup-${new Date().toISOString().slice(0, 10)}.json`);
    if (act === "restore") $("file-restore").click();
    if (act === "clear" && confirm("Delete every saved package and photo from this device?")) {
      await store.clearAll(); await loadInventory();
      state.photo?.items.forEach((i) => { i.saved = false; });
      if (state.view === "inv") showPhoto(null);
      renderAll(); toast("Inventory cleared");
    }
  });
  $("file-restore").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const r = await store.importBackup(f);
      await loadInventory(); renderAll();
      toast(`Restored ${r.parts} packages from ${r.photos} photos`);
    } catch (err) { toast("Restore failed: " + err.message); }
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  state.groupByType = ls.get("groupByType", true);
  state.sortKey = ls.get("sortKey", "value");
  state.ocrEnabled = ls.get("ocr", true);
  $("group-type").checked = state.groupByType;
  $("sort").value = state.sortKey;
  $("opt-ocr").checked = state.ocrEnabled;
  bindEvents();
  initViewer();
  restoreBom();
  await loadInventory();
  recomputeMatch();
  renderAll();
  loadZxing().catch(() => {}); // warm the decoder while the user frames the photo
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();

// For debugging from the console.
window.__partsScanner = { state, eff };
