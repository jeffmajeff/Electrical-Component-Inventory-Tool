// Pulls a human-readable description (and manufacturer, if printed) out of the
// OCR text of a bag label. OCR text is noisy, so this is deliberately lenient.
import { normalizeText } from "./classify.js";

const DESC_WORDS = /\b(RES\w*|OHMS?|CAP\w*|CER\w*|IND\w*|INDUCTOR|FERRITE|BEAD|DIODES?|SCHOTTKY|ZENER|TVS|LEDS?|MOSFET|TRANS\w*|IC|REG\w*|LDO|LINEAR|CRYSTAL|XTAL|OSC\w*|CONN\w*|HEADER|SWITCH|FUSE|POT\w*|TRIM\w*|MCU|AMP\w*|SENSOR|DRIVER|LOGIC|MEMORY|FLASH|VOLTAG\w*|POSITIVE|NEGATIVE|FIXED|SMD|THICK|FILM|X7R|X5R|C0G|NP0|\d+(?:\.\d+)?\s*[PNUµ]?[FH]|\d+(?:\.\d+)?\s*[KM]?\s*OHM|\d+(?:\.\d+)?V|\d+%|0402|0603|0805|1206|0201|SOT-?\d+|SOD-?\d+|SOIC|QFN|DFN|TSSOP|MSOP)\b/gi;
const NOISE_LINE = /(LCSC\.COM|QTY|INV#|SO#|PO#|IDX|MPN|MFR|D\/C|COO|LOT|DATE|MSL|ROHS|CREF|QUANTITY|DIGI-?KEY|BROOKS|THIEF|RIVER|FALLS|USA|WM\d{6,}|PICK\d|^\W*$)/i;
const MFR_LINE = /\b([A-Z][A-Z0-9&.\- ]{2,40}?(?:ELECTRONICS?|SEMICONDUCTORS?|INC\.?|CORP\.?|CORPORATION|LTD\.?|CO\.,?|GMBH|TECHNOLOGY|TECHNOLOGIES|DEVICES|INSTRUMENTS|MICRO\w*))\b/i;

function score(line) {
  const hits = line.match(DESC_WORDS);
  return hits ? hits.length : 0;
}

function clean(line) {
  return normalizeText(line)
    .replace(/^[^A-Z0-9(]*(?:DESC\w*|PART|DESCRIPTION)?\s*[:|]?\s*/i, "")
    .replace(/[^A-Z0-9)%.]+$/i, "")
    .trim();
}

/**
 * @param {string} text raw OCR text
 * @param {string} distributor "LCSC" | "DigiKey" | ...
 * @returns {{description:string, manufacturer:string}}
 */
export function extractLabelInfo(text, distributor) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let description = "";
  let manufacturer = "";

  if (distributor === "LCSC") {
    // LCSC labels: "C6186" / "MPN:AMS1117-3.3" / <description, wrapped over 1-3 lines> / "D/C:25+ COO:US"
    const iMpn = lines.findIndex((l) => /M\s*P\s*N\s*[:;]/i.test(l));
    if (iMpn >= 0) {
      const parts = [];
      for (let i = iMpn + 1; i < lines.length && parts.length < 5; i++) {
        if (/D\s*\/\s*C|C\s*O\s*O\s*:|^\s*\d{4}-\d{4}\s*$/i.test(lines[i])) break;
        if (score(lines[i]) === 0 && !/[A-Za-z]{5,}/.test(lines[i])) continue; // OCR junk like "ft eee"
        parts.push(lines[i]);
      }
      description = parts.join(" ").replace(/\s+-\s+/g, " - ").replace(/(\w)- (\w)/g, "$1-$2");
      if (/^nan$/i.test(description.trim())) description = "";
    }
  }

  if (!description) {
    // Generic: pick the line with the most "description-ish" tokens.
    let best = "", bestScore = 0;
    for (const l of lines) {
      if (NOISE_LINE.test(l) && !/OHM|[PNU]F\b/i.test(l)) continue;
      const s = score(l);
      if (s > bestScore) { best = l; bestScore = s; }
    }
    if (bestScore >= 2 || (bestScore === 1 && best.length >= 8)) description = best;
  }

  description = clean(description).replace(/\s+/g, " ");
  // Drop anything before a recognisable description keyword ("5e%.| RES0402" -> "RES0402")
  const kw = /\b(RES|CAP|IND|IC|DIODE|LED|MOSFET|TRANS|CONN|XTAL|CRYSTAL|FERRITE|FUSE|SWITCH|POT|TVS)/i.exec(description);
  if (kw && kw.index > 0 && kw.index < 12 && distributor !== "LCSC") description = description.slice(kw.index);

  for (const l of lines) {
    const m = MFR_LINE.exec(l);
    if (m && !/DIGI-?KEY|LCSC|MOUSER/i.test(m[1])) { manufacturer = m[1].replace(/^\W+/, "").trim(); break; }
  }
  return { description, manufacturer };
}
