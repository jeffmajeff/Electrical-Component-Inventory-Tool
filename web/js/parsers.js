// Parsers for the 2D codes printed on distributor component bags.
//
// Supported:
//   - ECIA / ANSI MH10.8.2 (ISO/IEC 15434 "[)>" envelope) DataMatrix — DigiKey,
//     Mouser, Arrow, Newark, TTI and most US/EU distributors.
//   - LCSC / JLCPCB QR — "{pbn:...,on:...,pc:C6186,pm:AMS1117-3.3,qty:5,...}"
//   - Generic "KEY:VALUE" text (TME-style and similar) as a fallback.
//
// Every parser returns a plain object (see `emptyPart`) or null.

const RS = "\x1e";
const GS = "\x1d";
const EOT = "\x04";

export function emptyPart() {
  return {
    distributor: "",      // "DigiKey", "LCSC", "Mouser", ...
    distributorPN: "",    // DigiKey PN, LCSC "C" number, Mouser PN
    mpn: "",              // manufacturer part number
    manufacturer: "",
    description: "",
    qty: null,
    dateCode: "",
    lotCode: "",
    countryOfOrigin: "",
    salesOrder: "",
    invoice: "",
    customerPO: "",
    packageId: "",        // unique id for this physical bag (dedupe key)
    raw: "",
  };
}

// ---------------------------------------------------------------- ECIA / ISO 15434
// Data identifiers (ANSI MH10.8.2) commonly found on distributor labels.
// Longest identifiers must be tested first ("30P" before "P").
const ECIA_DIS = [
  ["30P", "distributorPN"],   // DigiKey part number
  ["1P", "mpn"],              // supplier / manufacturer part number
  ["P", "customerPN"],        // customer part number (DigiKey repeats its PN here)
  ["10K", "invoice"],
  ["1K", "salesOrder"],
  ["11K", "packingList"],
  ["14K", "lineItem"],
  ["K", "customerPO"],
  ["10D", "dateCode"],
  ["9D", "dateCode"],
  ["1T", "lotCode"],
  ["4L", "countryOfOrigin"],
  ["1V", "manufacturer"],
  ["Q", "qty"],
  ["11Z", "z11"],
  ["12Z", "z12"],
  ["13Z", "z13"],
  ["20Z", "z20"],
];

export function isEcia(text) {
  return typeof text === "string" && text.includes("[)>");
}

export function parseEcia(text) {
  if (!isEcia(text)) return null;
  const body = text.slice(text.indexOf("[)>") + 3);
  // Split into records by RS, then fields by GS. Format "06" is the MH10 record.
  const records = body.split(RS).map((r) => r.replace(EOT, ""));
  const fields = {};
  for (const rec of records) {
    const parts = rec.split(GS);
    if (!parts.length) continue;
    const fmt = parts[0];
    if (fmt !== "06" && fmt !== "05" && fmt !== "") continue;
    for (const f of parts.slice(1)) {
      if (!f) continue;
      // ECIA_DIS lists longer identifiers first, so "30P" wins over "P", etc.
      const di = ECIA_DIS.find(([id]) => f.startsWith(id));
      if (!di) continue;
      const [id, key] = di;
      if (!(key in fields)) fields[key] = f.slice(id.length).trim();
    }
  }
  const p = emptyPart();
  p.raw = text;
  p.mpn = fields.mpn || "";
  p.distributorPN = fields.distributorPN || "";
  p.customerPO = fields.customerPO || "";
  p.salesOrder = fields.salesOrder || "";
  p.invoice = fields.invoice || "";
  p.dateCode = fields.dateCode || "";
  p.lotCode = fields.lotCode || "";
  p.countryOfOrigin = fields.countryOfOrigin || "";
  p.manufacturer = fields.manufacturer || "";
  p.qty = fields.qty ? toInt(fields.qty) : null;

  const cpn = fields.customerPN || "";
  if (fields.distributorPN || /-ND$/i.test(cpn) || fields.z11 === "PICK") {
    p.distributor = "DigiKey";
    if (!p.distributorPN && /-ND$/i.test(cpn)) p.distributorPN = cpn;
  } else if (fields.lineItem || /^\d{2,3}-/.test(cpn) && fields.manufacturer) {
    p.distributor = "Mouser";
    if (/^\d{2,3}-/.test(cpn)) p.distributorPN = cpn;
  } else {
    p.distributor = "ECIA label";
    if (cpn && cpn !== p.mpn) p.distributorPN = cpn;
  }
  p.packageId = [p.distributor, p.distributorPN || p.mpn, p.salesOrder, p.invoice, p.lotCode, p.qty]
    .join("|");
  return p;
}

// ---------------------------------------------------------------- LCSC
export function isLcsc(text) {
  return typeof text === "string" && /^\s*\{.*\bpc:\s*C\d+/i.test(text);
}

export function parseLcsc(text) {
  if (!isLcsc(text)) return null;
  const inner = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  const kv = {};
  // Values never contain commas in practice; split on ",key:" boundaries to be safe.
  for (const m of inner.matchAll(/(?:^|,)\s*([a-zA-Z_]+)\s*:([^,]*)/g)) {
    kv[m[1].toLowerCase()] = m[2].trim();
  }
  const p = emptyPart();
  p.raw = text;
  p.distributor = "LCSC";
  p.distributorPN = kv.pc || "";
  p.mpn = kv.pm || "";
  p.qty = kv.qty ? toInt(kv.qty) : null;
  p.salesOrder = kv.on || "";
  p.manufacturer = kv.mc && kv.mc !== "null" ? kv.mc : "";
  p.lotCode = kv.pbn || "";
  p.packageId = ["LCSC", p.distributorPN, kv.pdi || kv.on || "", p.qty].join("|");
  p.lcscPdi = kv.pdi || "";
  return p;
}

// ---------------------------------------------------------------- Generic KEY:VALUE
const GENERIC_KEYS = {
  mpn: ["MPN", "MFR PN", "MFRPN", "MFG PN", "PM", "1P"],
  distributorPN: ["PN", "SPN", "PART", "P/N", "PC"],
  qty: ["QTY", "QUANTITY", "Q"],
  manufacturer: ["MFR", "MANUFACTURER", "MFG", "MC"],
  description: ["DESC", "DESCRIPTION"],
};

export function parseGeneric(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const kv = {};
  for (const m of text.matchAll(/([A-Za-z][A-Za-z /]{0,14}?)\s*[:=]\s*([^\s,;|]+(?: [^\s,;|:]+)*)/g)) {
    kv[m[1].trim().toUpperCase()] = m[2].trim();
  }
  const p = emptyPart();
  p.raw = text;
  for (const [field, keys] of Object.entries(GENERIC_KEYS)) {
    for (const k of keys) {
      if (kv[k]) { p[field] = field === "qty" ? toInt(kv[k]) : kv[k]; break; }
    }
  }
  if (!p.mpn && !p.distributorPN) {
    // Last resort: a short single token code is probably a part number.
    const t = text.trim();
    if (/^[A-Z0-9][A-Z0-9\-_.\/#+]{3,40}$/i.test(t)) p.mpn = t;
    else return null;
  }
  p.distributor = /\bTME\b/i.test(text) ? "TME" : "Unknown";
  p.packageId = ["GEN", p.distributorPN, p.mpn, p.qty, text.length].join("|");
  return p;
}

export function parseCode(text) {
  // Some decoders render control characters as visible symbols (␞ ␝ ␄); undo that.
  const t = String(text || "").replace(/\u241e/g, RS).replace(/\u241d/g, GS).replace(/\u2404/g, EOT);
  return parseEcia(t) || parseLcsc(t) || parseGeneric(t);
}

// ---------------------------------------------------------------- Links
export function distributorUrl(part) {
  const enc = encodeURIComponent;
  switch (part.distributor) {
    case "DigiKey":
      return `https://www.digikey.com/en/products/result?keywords=${enc(part.distributorPN || part.mpn)}`;
    case "LCSC":
      return part.distributorPN
        ? `https://www.lcsc.com/product-detail/${enc(part.distributorPN)}.html`
        : `https://www.lcsc.com/search?q=${enc(part.mpn)}`;
    case "Mouser":
      return `https://www.mouser.com/c/?q=${enc(part.distributorPN || part.mpn)}`;
    default:
      return part.mpn ? `https://octopart.com/search?q=${enc(part.mpn)}` : "";
  }
}

function toInt(s) {
  const n = parseInt(String(s).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
