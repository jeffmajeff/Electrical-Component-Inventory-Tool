// Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCode } from "../web/js/parsers.js";
import { classify, parseValueString, extractPackage } from "../web/js/classify.js";
import { extractLabelInfo } from "../web/js/labeltext.js";
import { rowsToBom, parseDelimited, matchBom } from "../web/js/bom.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/sample-codes.json", import.meta.url)));
const ocr = JSON.parse(readFileSync(new URL("./fixtures/sample-ocr.json", import.meta.url)));
const [dk, lc1, lc2] = fx.codes.map((c) => parseCode(c.text));

test("DigiKey ECIA DataMatrix", () => {
  assert.equal(dk.distributor, "DigiKey");
  assert.equal(dk.distributorPN, "4713-RM04F1003CT-ND");
  assert.equal(dk.mpn, "RM04F1003CT");
  assert.equal(dk.qty, 15);
  assert.equal(dk.salesOrder, "100196620");
  assert.equal(dk.invoice, "128622820");
  assert.equal(dk.dateCode, "2535");
  assert.equal(dk.lotCode, "2133110");
  assert.equal(dk.countryOfOrigin, "TH");
});

test("visible control symbols (HRI text mode) are accepted", () => {
  const hri = fx.codes[0].text.replace(/\x1e/g, "␞").replace(/\x1d/g, "␝").replace(/\x04/g, "␄");
  assert.equal(parseCode(hri).mpn, "RM04F1003CT");
});

test("LCSC QR", () => {
  assert.deepEqual([lc1.distributor, lc1.distributorPN, lc1.mpn, lc1.qty], ["LCSC", "C6186", "AMS1117-3.3", 5]);
  assert.deepEqual([lc2.distributorPN, lc2.mpn, lc2.qty], ["C496579", "BW915JWX105-10KJ", 2]);
  assert.notEqual(lc1.packageId, lc2.packageId);
});

test("Mouser-style ECIA label", () => {
  const p = parseCode("[)>\x1e06\x1dK123\x1d14K001\x1d1PGRM155R71C104KA88D\x1dQ100\x1d11K777\x1d4LJP\x1d1VMurata\x1e\x04");
  assert.equal(p.distributor, "Mouser");
  assert.equal(p.mpn, "GRM155R71C104KA88D");
  assert.equal(p.manufacturer, "Murata");
  assert.equal(p.qty, 100);
});

test("OCR description extraction", () => {
  const d = extractLabelInfo(ocr["0"], "DigiKey");
  assert.equal(d.description, "RES0402 1% 100K OHM");
  assert.match(d.manufacturer, /ELECTRONICS/);
  const l = extractLabelInfo(ocr["1"], "LCSC");
  assert.match(l.description, /^3\.3V Pos\w+ Fixed SOT-223 Voltag.*Low Drop Out/);
});

test("classification from MPN and description", () => {
  const r = classify({ mpn: dk.mpn, description: "RES0402 1% 100K OHM" });
  assert.deepEqual([r.type, r.value, r.package, r.tolerance], ["Resistor", "100kΩ", "0402", 1]);
  const u = classify({ mpn: "AMS1117-3.3", description: "3.3V Positive Fixed SOT-223 Voltage Regulators - Linear, Low Drop Out (LDO)" });
  assert.deepEqual([u.type, u.subtype, u.voltage, u.package], ["IC", "Voltage regulator", 3.3, "SOT-223"]);
  const c = classify({ mpn: "CL05B104KO5NNNC" });
  assert.deepEqual([c.type, c.value, c.package, c.voltage, c.dielectric], ["Capacitor", "100nF", "0402", 16, "X7R"]);
  assert.equal(classify({ description: "CAP CER 10UF 25V X5R 0805" }).value, "10µF");
  assert.equal(classify({ mpn: "RC0402FR-074K7L" }).value, "4.7kΩ");
  assert.equal(classify({ mpn: "SS34" }).type, "Diode");
});

test("value strings and footprints", () => {
  assert.equal(parseValueString("4k7", "Resistor"), 4700);
  assert.equal(parseValueString("100nF", "Capacitor"), 1e-7);
  assert.equal(parseValueString("2u2", "Inductor"), 2.2e-6);
  assert.equal(extractPackage("Resistor_SMD:R_0402_1005Metric"), "0402");
  assert.equal(extractPackage("Package_TO_SOT_SMD:SOT-223-3_TabPin2"), "SOT-223-3");
});

test("BOM matching: exact by PN and by value+package", () => {
  const rows = parseDelimited(readFileSync(new URL("./fixtures/sample-bom.csv", import.meta.url), "utf8"));
  const bom = rowsToBom(rows, "b.csv");
  assert.equal(bom.lines.length, 5);
  const items = [dk, lc1, lc2].map((p, i) => ({ id: String(i), mpn: p.mpn, distributorPN: p.distributorPN,
    cls: classify({ mpn: p.mpn, description: i === 0 ? "RES0402 1% 100K OHM" : "" }) }));
  const m = matchBom(bom, items);
  assert.equal(m.byLine.get(0).kind, "exact");   // RM04F1003CT
  assert.equal(m.byLine.get(1).kind, "exact");   // C6186 / AMS1117-3.3
  assert.equal(m.byLine.get(2).kind, "param");   // 100k 0402, different MPN
  assert.equal(m.byLine.has(3), false);
  assert.equal(m.byItem.get("0").kind, "exact");
});
