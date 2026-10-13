// BOM import (CSV / TSV / XLSX) and matching against scanned packages.
import { classify, extractPackage, parseValueString } from "./classify.js";

const HEADER_ALIASES = {
  refs: ["reference", "references", "designator", "designators", "refdes", "ref", "refs", "ref des", "part reference"],
  qty: ["qty", "quantity", "count", "qnty", "qty per board"],
  value: ["value", "val", "comment"],
  footprint: ["footprint", "package", "case", "case/package", "pcb footprint"],
  mpn: ["mpn", "mfr part", "mfr part #", "mfr. part #", "mfr pn", "mfr_pn", "mfg pn", "mfg part number", "manufacturer part number",
    "manufacturer part", "manufacturer_part_number", "manufacturer pn", "part number", "partnumber", "mpn1", "pn"],
  manufacturer: ["manufacturer", "mfr", "mfg", "manufacturer name"],
  lcsc: ["lcsc", "lcsc part", "lcsc part #", "lcsc pn", "lcsc part number", "jlcpcb part #", "jlc", "jlcpcb", "jlcpcb part"],
  digikey: ["digikey", "digi-key", "digikey pn", "digi-key pn", "digikey part number", "digi-key part number", "digi-key part #", "dk pn", "dk"],
  mouser: ["mouser", "mouser pn", "mouser part number", "mouser part #"],
  description: ["description", "desc"],
};

export function normPN(s) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").trim();
}

// ---------------------------------------------------------------- reading
export function parseDelimited(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 20).join("\n");
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of firstLines) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

async function readXlsx(file) {
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load the spreadsheet reader (offline?)"));
      document.head.appendChild(s);
    });
  }
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" })
    .map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c));
}

export async function readBomFile(file) {
  const name = file.name.toLowerCase();
  const rows = /\.(xlsx|xls|ods)$/.test(name) ? await readXlsx(file) : parseDelimited(await file.text());
  return rowsToBom(rows, file.name);
}

export function rowsToBom(rows, name = "BOM") {
  // Find the header row: the first row (within the first 30) that names ≥2 known columns.
  let headerIdx = -1, colMap = {};
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const map = mapHeaders(rows[i]);
    if (Object.keys(map).length >= 2) { headerIdx = i; colMap = map; break; }
  }
  const body = headerIdx >= 0 ? rows.slice(headerIdx + 1) : rows;
  const lines = body.map((cells, i) => {
    const get = (k) => (colMap[k] != null ? cells[colMap[k]] || "" : "");
    const line = {
      idx: i,
      refs: get("refs"), qty: parseInt(get("qty"), 10) || null, value: get("value"),
      footprint: get("footprint"), mpn: get("mpn"), manufacturer: get("manufacturer"),
      lcsc: get("lcsc"), digikey: get("digikey"), mouser: get("mouser"),
      description: get("description"), cells,
    };
    if (!line.qty && line.refs) line.qty = line.refs.split(/[,;\s]+/).filter(Boolean).length;
    // Part numbers to try for an exact match. With no PN columns, any cell will do.
    const pnCells = [line.mpn, line.lcsc, line.digikey, line.mouser].filter(Boolean);
    line.pns = new Set((pnCells.length ? pnCells : cells).flatMap((c) => c.split(/[,;\/]\s*|\s+/)).map(normPN).filter((p) => p.length >= 3));
    line.params = bomLineParams(line);
    return line;
  }).filter((l) => l.cells.some((c) => c) && !/^(total|sum)\b/i.test(l.cells[0] || ""));
  return { name, lines, columns: colMap, headerFound: headerIdx >= 0 };
}

function mapHeaders(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = h.toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[key] == null && aliases.includes(n)) map[key] = i;
    }
  });
  return map;
}

const REF_TYPES = [
  [/^FB/i, "Ferrite bead"], [/^LED/i, "LED"], [/^SW/i, "Switch"], [/^RV|^VR/i, "Potentiometer"],
  [/^R/i, "Resistor"], [/^C/i, "Capacitor"], [/^L/i, "Inductor"], [/^D/i, "Diode"], [/^Q/i, "Transistor"],
  [/^U|^IC/i, "IC"], [/^[YX]/i, "Crystal/Osc"], [/^[JP]/i, "Connector"], [/^F/i, "Fuse"], [/^S/i, "Switch"],
];

function bomLineParams(line) {
  const firstRef = (line.refs || "").split(/[,;\s]+/)[0] || "";
  let type = REF_TYPES.find(([re]) => re.test(firstRef))?.[1] || "";
  const c = classify({ mpn: line.mpn, description: [line.description, line.value].join(" ") });
  if (!type || (c.type !== "Other" && type === "Diode" && c.type === "LED")) type = c.type !== "Other" ? c.type : type;
  let valueNum = ["Resistor", "Capacitor", "Inductor", "Potentiometer"].includes(type) ? parseValueString(line.value, type) : null;
  if (valueNum == null && c.type === type) valueNum = c.valueNum;
  const pkg = extractPackage(line.footprint) || extractPackage(line.description) || (c.type === type ? c.package : "");
  return { type, valueNum, package: pkg };
}

// ---------------------------------------------------------------- matching
/**
 * @param bom from rowsToBom
 * @param items array of {id, mpn, distributorPN, cls:{type,valueNum,package}}
 * @returns {{byItem: Map<id,{kind:'exact'|'param', lines:number[]}>, byLine: Map<lineIdx,{kind, items:id[]}>}}
 */
export function matchBom(bom, items) {
  const byItem = new Map();
  const byLine = new Map();
  const add = (item, line, kind) => {
    const a = byItem.get(item.id) || { kind, lines: [] };
    if (kind === "exact") a.kind = "exact";
    a.lines.push(line.idx); byItem.set(item.id, a);
    const b = byLine.get(line.idx) || { kind, items: [] };
    if (kind === "exact") b.kind = "exact";
    b.items.push(item.id); byLine.set(line.idx, b);
  };
  for (const line of bom.lines) {
    let exact = false;
    for (const it of items) {
      const keys = [it.mpn, it.distributorPN].map(normPN).filter(Boolean);
      if (keys.some((k) => line.pns.has(k))) { add(it, line, "exact"); exact = true; }
    }
    if (exact) continue;
    const p = line.params;
    if (!p.type || p.valueNum == null) continue;
    for (const it of items) {
      const c = it.cls;
      if (!c || c.type !== p.type || c.valueNum == null) continue;
      const rel = Math.abs(c.valueNum - p.valueNum) / Math.max(Math.abs(p.valueNum), 1e-15);
      if (rel > 0.005 && !(p.valueNum === 0 && c.valueNum === 0)) continue;
      if (p.package && c.package && p.package !== c.package) continue;
      add(it, line, "param");
    }
  }
  return { byItem, byLine };
}

export function bomLineLabel(line) {
  const bits = [line.refs, line.value, line.mpn || line.lcsc || line.digikey || line.mouser].filter(Boolean);
  return bits.join(" · ") || line.cells.filter(Boolean).slice(0, 3).join(" · ");
}
