// Infers component type and key parameters (value, package, tolerance, voltage…)
// from whatever text we have: the label description (from OCR or the user),
// and the manufacturer part number, which for most passives encodes the value.

export const TYPES = [
  "Resistor", "Capacitor", "Inductor", "Ferrite bead", "Diode", "LED",
  "Transistor", "IC", "Crystal/Osc", "Connector", "Switch", "Fuse",
  "Potentiometer", "Other",
];

export const TYPE_COLORS = {
  "Resistor": "#e0a526", "Capacitor": "#3d8bfd", "Inductor": "#9b6dff",
  "Ferrite bead": "#7a7a7a", "Diode": "#e5534b", "LED": "#ff7ab8",
  "Transistor": "#1fb5a8", "IC": "#22a95b", "Crystal/Osc": "#b28a5c",
  "Connector": "#8f6b3e", "Switch": "#5c7cfa", "Fuse": "#d9480f",
  "Potentiometer": "#c2a000", "Other": "#8a8f98",
};

// ---------------------------------------------------------------- helpers
const SI = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, "": 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** OCR commonly reads 0 as O inside numbers ("RESO402"). Fix only digit-adjacent O's. */
export function normalizeText(s) {
  if (!s) return "";
  let t = String(s).replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) t = t.replace(/(\d)O/g, "$10").replace(/O(\d)/g, "0$1");
  return t;
}

/** "4K7" -> 4700, "100K" -> 1e5, "10R" -> 10, "0R1" -> 0.1, "1M5" -> 1.5e6 */
export function parseRKM(code) {
  const m = /^(\d*)([RKMG])(\d*)$/i.exec(code);
  if (m) {
    const mult = SI[m[2].toUpperCase() === "R" ? "R" : m[2].toUpperCase()];
    const num = parseFloat(`${m[1] || "0"}.${m[3] || "0"}`);
    return num * mult;
  }
  const n = /^(\d+(?:\.\d+)?)([RKMG]?)$/i.exec(code);
  if (n) return parseFloat(n[1]) * (SI[(n[2] || "").toUpperCase()] || 1);
  return null;
}

/** EIA resistor code: "1003" -> 100k, "103" -> 10k, "4R7" -> 4.7, "R100" -> 0.1 */
export function parseEiaResistor(code) {
  if (/R/i.test(code)) return parseFloat(code.toUpperCase().replace("R", "."));
  if (/^\d{3}$/.test(code)) return parseInt(code.slice(0, 2), 10) * 10 ** parseInt(code[2], 10);
  if (/^\d{4}$/.test(code)) return parseInt(code.slice(0, 3), 10) * 10 ** parseInt(code[3], 10);
  return null;
}

/** EIA capacitor code in pF: "104" -> 100nF (1e-7 F), "1R0" -> 1pF */
export function parseEiaCap(code) {
  if (/R/i.test(code)) return parseFloat(code.toUpperCase().replace("R", ".")) * 1e-12;
  if (/^\d{3}$/.test(code)) return parseInt(code.slice(0, 2), 10) * 10 ** parseInt(code[2], 10) * 1e-12;
  return null;
}

export function formatSI(value, unit) {
  if (value == null || !isFinite(value)) return "";
  const prefixes = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
  const abs = Math.abs(value);
  for (const [mult, p] of prefixes) {
    if (abs >= mult * 0.9999) {
      const n = value / mult;
      return `${+n.toPrecision(3)}${p}${unit}`;
    }
  }
  return `${+(value / 1e-12).toPrecision(3)}p${unit}`;
}

const TOL_LETTER = { B: 0.1, C: 0.25, D: 0.5, F: 1, G: 2, J: 5, K: 10, M: 20, Z: 80 };

// Murata/TDK rated-voltage codes
const V_CODE_MURATA = { "0E": 2.5, "0G": 4, "0J": 6.3, "1A": 10, "1C": 16, "1E": 25, "YA": 35, "1V": 35, "1H": 50, "2A": 100, "2D": 200, "2E": 250, "2W": 450, "2J": 630, "3A": 1000 };
// Samsung CL voltage letter
const V_CODE_SAMSUNG = { S: 2.5, R: 4, Q: 6.3, P: 10, O: 16, A: 25, L: 35, B: 50, C: 100, D: 200, E: 250, G: 500, H: 630, I: 1000 };
// Yageo CC voltage digit
const V_CODE_YAGEO = { 5: 6.3, 6: 10, 7: 16, 8: 25, 9: 50, 0: 100 };

const MURATA_SIZE = { "02": "01005", "03": "0201", "15": "0402", "18": "0603", "21": "0805", "31": "1206", "32": "1210", "43": "1812", "55": "2220" };
const SAMSUNG_SIZE = { "03": "0201", "05": "0402", "10": "0603", "21": "0805", "31": "1206", "32": "1210", "43": "1812" };
const METRIC_SIZE = { "0402": "01005", "0603": "0201", "1005": "0402", "1608": "0603", "2012": "0805", "3216": "1206", "3225": "1210", "4532": "1812", "5750": "2220" };
const MURATA_DIEL = { "R7": "X7R", "R6": "X5R", "5C": "C0G", "C7": "X7S", "C8": "X6S", "D7": "X7T", "E7": "X7U", "F5": "Y5V", "R1": "X7R" };
const SAMSUNG_DIEL = { A: "X5R", B: "X7R", C: "C0G", F: "Y5V", X: "X6S", Y: "X7S", Z: "X7T", L: "X8L" };
const CALCHIP_SIZE = { "02": "0201", "04": "0402", "06": "0603", "10": "0805", "12": "1206", "20": "2010", "25": "2512" };
const ERJ_SIZE = { "XG": "01005", "1G": "0201", "2": "0402", "3": "0603", "6": "0805", "8": "1206", "14": "1210", "12": "1812", "1T": "2512" };

// ---------------------------------------------------------------- MPN decoders
function decodeMpn(mpnRaw) {
  const mpn = (mpnRaw || "").toUpperCase().replace(/\s+/g, "");
  if (!mpn) return {};
  let m;

  // ---- Resistors
  if ((m = /^RC(\d{4})([BCDFGJ])R-\d{2}([\dRKM.]+)L/.exec(mpn))) // Yageo RC0402FR-07100KL
    return { type: "Resistor", package: m[1], tolerance: TOL_LETTER[m[2]], valueNum: parseRKM(m[3]) };
  if ((m = /^RM(\d{2})([BDFGJ])(\d{3,4}|\d*R\d*)C?T/.exec(mpn))) // Cal-Chip RM04F1003CT
    return { type: "Resistor", package: CALCHIP_SIZE[m[1]], tolerance: TOL_LETTER[m[2]], valueNum: parseEiaResistor(m[3]) };
  if ((m = /^ERJ-?(XG|1G|1T|14|12|2|3|6|8)[A-Z]{1,3}?([BDFGJ])(\d{3,4}|\d*R\d+)[A-Z]$/.exec(mpn))) // Panasonic ERJ-2RKF1003X
    return { type: "Resistor", package: ERJ_SIZE[m[1]], tolerance: TOL_LETTER[m[2]], valueNum: parseEiaResistor(m[3]) };
  if ((m = /^ERJ-?(1G|1T|14|12|2|3|6|8)GEY(0R00)/.exec(mpn)))
    return { type: "Resistor", package: ERJ_SIZE[m[1]], valueNum: 0 };
  if ((m = /^CRCW(\d{4})([\dRKM]+?)([BDFGJ])[A-Z]{2,3}/.exec(mpn))) // Vishay CRCW0402100KFKED
    return { type: "Resistor", package: m[1], tolerance: TOL_LETTER[m[3]], valueNum: parseRKM(m[2]) };
  if ((m = /^RMC[FP](\d{4})([BDFGJ])T([\dRKM]+)/.exec(mpn))) // Stackpole RMCF0402FT100K
    return { type: "Resistor", package: m[1], tolerance: TOL_LETTER[m[2]], valueNum: parseRKM(m[3]) };
  if ((m = /^(\d{4})W[A-Z]([BDFGJ])(\d{3,4}|\d*R\d*)T/.exec(mpn))) // UniOhm 0402WGF1003TCE
    return { type: "Resistor", package: m[1], tolerance: TOL_LETTER[m[2]], valueNum: parseEiaResistor(m[3]) };
  if ((m = /^CR(\d{4})-([FJ])[A-Z]-(\d{3,4}|\d*R\d*)/.exec(mpn))) // Bourns CR0402-FX-1003GLF
    return { type: "Resistor", package: m[1], tolerance: TOL_LETTER[m[2]], valueNum: parseEiaResistor(m[3]) };
  if ((m = /^(?:AC|AT|AF|RT|RL)(\d{4})([BDFGJ])[RT]-\d{2}([\dRKM.]+)L/.exec(mpn))) // other Yageo families
    return { type: "Resistor", package: m[1], tolerance: TOL_LETTER[m[2]], valueNum: parseRKM(m[3]) };

  // ---- Capacitors
  if ((m = /^G(?:RM|CM|CJ|RT|JM|QM)(\d{2})\w(\w{2})(\w{2})(\d{3}|\dR\d|R\d{2})([A-Z])/.exec(mpn))) // Murata GRM155R71C104KA88D
    return { type: "Capacitor", package: MURATA_SIZE[m[1]], dielectric: MURATA_DIEL[m[2]], voltage: V_CODE_MURATA[m[3]], valueNum: parseEiaCap(m[4]), tolerance: TOL_LETTER[m[5]] };
  if ((m = /^CL(\d{2})([A-Z])(\d{3}|\dR\d)([A-Z])([A-Z])/.exec(mpn))) // Samsung CL05B104KO5NNNC
    return { type: "Capacitor", package: SAMSUNG_SIZE[m[1]], dielectric: SAMSUNG_DIEL[m[2]], valueNum: parseEiaCap(m[3]), tolerance: TOL_LETTER[m[4]], voltage: V_CODE_SAMSUNG[m[5]] };
  if ((m = /^C(\d{4})(X7R|X5R|C0G|X6S|X7S|X7T|Y5V|NP0|CH)(\d[A-Z])(\d{3}|\dR\d)([A-Z])/.exec(mpn))) // TDK C1005X7R1C104K050BC
    return { type: "Capacitor", package: METRIC_SIZE[m[1]], dielectric: m[2], voltage: V_CODE_MURATA[m[3]], valueNum: parseEiaCap(m[4]), tolerance: TOL_LETTER[m[5]] };
  if ((m = /^CGA\d(\w)\d?(X7R|X5R|C0G|X8R|X7S)(\d[A-Z])(\d{3}|\dR\d)([A-Z])/.exec(mpn))) // TDK CGA automotive
    return { type: "Capacitor", dielectric: m[2], voltage: V_CODE_MURATA[m[3]], valueNum: parseEiaCap(m[4]), tolerance: TOL_LETTER[m[5]] };
  if ((m = /^CC(\d{4})([BCDFGJKMZ])R(X7R|X5R|NP0|C0G|Y5V|X7S)(\d)BB(\d{3}|\dR\d)/.exec(mpn))) // Yageo CC0402KRX7R7BB104
    return { type: "Capacitor", package: m[1], tolerance: TOL_LETTER[m[2]], dielectric: m[3], voltage: V_CODE_YAGEO[m[4]], valueNum: parseEiaCap(m[5]) };
  if ((m = /^(\d{4})([A-Z])(\d{3}|\dR\d)([A-Z])(\d{3})/.exec(mpn)) && /^(0201|0402|0603|0805|1206|1210)$/.test(m[1])) // FH/Walsin style 0402B104K160
    return { type: "Capacitor", package: m[1], valueNum: parseEiaCap(m[3]), tolerance: TOL_LETTER[m[4]] };
  if (/^(EMK|JMK|LMK|TMK|UMK|GMK|AMK)\d{3}/.test(mpn)) return { type: "Capacitor" }; // Taiyo Yuden
  if (/^(885012|885382|8850)/.test(mpn)) return { type: "Capacitor" };                  // Wurth MLCC
  if (/^(T491|T495|TAJ|TPS[A-E]|293D|F93|EEE-|UWT|UCD|EEU|ECA|860020|865|870)/.test(mpn)) return { type: "Capacitor" };

  return { type: typeFromMpnPrefix(mpn) };
}

const MPN_PREFIX_TYPES = [
  ["Ferrite bead", /^(BLM\d|MPZ\d|HZ\d|FBMH|BK\d{4}|742792|MMZ\d|GZ\d{4})/],
  ["Inductor", /^(LQ[GHMPW]\d|SRN\d|SRP\d|SRR\d|XAL\d|XFL\d|LPS\d|MSS\d|DFE\d|VLS\d|NR[S]?\d|CDRH|IHLP|7440|7443|744\d|MLZ\d|SWPA|FTC\d|CBC\d|SDR\d)/],
  ["LED", /^(LTST|150060|150080|150120|XL-\d|KT-\d|WS2812|SK6812|APA102|LT[WGRYB]|19-21\d|IN-S|KP-\d|APT\d|APHHS|NCD\d|SML-|OSG|QTLP|LS[RTMG]\d|LG[RT]\d|LY[RT]\d|LW[RT]\d|KPT-|XZ[A-Z]{2})/],
  ["Diode", /^(1N\d|BAT\d|BAS\d|BAV\d|SS\d{2}|SMAJ|SMBJ|SMCJ|SMF\d|MBR\d|B5\d{3}|SK\d{2}|ES\d[A-Z]|US\d[A-Z]|RB\d{3}|PMEG|PESD|ESD\d|MMSZ|BZT|BZX|SM712|NSR\d|CUS\d|1SS|SBR\d|S1[A-M]\b|M7\b|MURS|RS1[A-M]|PRTR|USBLC|TPD\d|SD05|SRV05|SMF05|DSS\d|BAT54|SS34)/],
  ["Transistor", /^(2N\d|BSS\d|BSN\d|AO\d{4}|AON\d|SI\d{4}|SI[AS]\d|MMBT|DMG\d|DMN\d|DMP\d|IRL\w|IRF\w|BC[85]\d{2}|MMBF|NTR\d|NTS\d|NX\d{3}|PMV\d|FDN\d|FDV\d|2SC|2SA|S8050|S8550|SS8050|SS8550|DTC\d|BSH\d|CSD\d|BCR\d|PBSS|AP\d{4}[GN]|WSD\d|NCE\d)/],
  ["Crystal/Osc", /^(ABM\d|ABL|ABS0|FC-\d|TSX-|X3\d|ECS-|SIT\d|ASE|FA-\d|NX\d{4}|HC-?49|CSTN|X1E|Q\d{2}\.|YXC|SG-\d|7[A-Z]-|8Z-|ECX-|FQ\d)/],
  ["Fuse", /^(0466|0451|0467|0603SF|MF-|SMD\d{3}|BSMD|PTC|1206L|0805L|MINISMDC|JK-|NANOSMDC|MICROSMD|SF-\d)/],
  ["Potentiometer", /^(3296|3362|3266|3386|PV36|TC33|RV\d{2}|PTV\d|EVM-|TSR-|RK09|PTR\d|ST-?4)/],
  ["Switch", /^(TS-\d|PTS\d|SKQ|EVQ|KMR\d|TL\d{4}|SS-\d|MSK-|1825\d|B3U|DTSM|K2-\d|TS\d{3,}|SW-|JS\d{3}|PCM12|EG\d{4})/],
  ["Connector", /^(B\d+B-|SM\d+B-|S\d+B-|BM\d+B-|PH-|XH-|ZH-|SH-|GH-|DF\d{2}|FH\d{2}|USB\d|TYPE-C|HDR-|PZ254|PM254|TSW-|SSW-|FTSH|SFH\d|KH-|HX\d|BWIPX|U\.FL|IPEX|SMA-|10118\d|1053|0532|0533|5267|5023|61\d{9}|62\d{9}|M20-|DS1\d{3}|WJ\d|KF\d|HC-\d|A\d{4}WV|TJC|PJ-\d|CUI|GSB|UJ\d)/],
  ["IC", /^(AMS1117|LM\d|LMR|TPS\d|TLV\d|AP\d{4}|MCP\d|STM32|STM8|ESP32|ESP8|ATMEGA|ATTINY|ATSAMD|NE555|LP\d|XC6\d|RT\d{4}|MP\d{4}|SY8\d|TP4\d|CH3\d|CP21\d|FT23\d|AD\d{3}|MAX\d|ICM-|BME\d|BMP\d|BMI\d|MPU-?\d|LIS\d|LSM\d|INA\d|OPA\d|TL0\d|74HC|74LVC|74AHC|SN74|CD4\d|ULN\d|DRV\d|A49\d|PCA9|PCF8|W25Q|AT24|24C|24LC|IS31|GD32|RP2040|NRF5|CC\d{4}|SX12|LT\d{4}|LTC\d|ADP\d|ME6\d|HT7\d|XL\d{4}|SGM\d|ETA\d|TMP\d|SHT\d|AHT\d|HDC\d|ADS\d|TCA\d|TXS\d|TXB\d|PI\d|NCP\d|UCC\d|BQ\d|IP5\d|HX711|ACS7|LMV\d|LMC\d|MIC\d|TC\d{4}|ISL\d)/],
];

function typeFromMpnPrefix(mpn) {
  for (const [type, re] of MPN_PREFIX_TYPES) if (re.test(mpn)) return type;
  return "";
}

const REGULATOR_RE = /\b(LDO|REGULATOR|BUCK|BOOST|DC-?DC|STEP-?DOWN|STEP-?UP)\b|^(AMS1117|LM1117|AP2112|AP2210|AP7\d|XC62\d|ME62\d|HT73\d|LM78|78L|LM317|TLV7\d|TPS7\d|TPS6\d|MCP17\d|RT90\d|LP590\d|SPX3819|MIC5\d)/;

// ---------------------------------------------------------------- description parsing
const DESC_TYPE_RULES = [
  ["Potentiometer", /\b(POT(ENTIOMETER)?|TRIM(MER|POT)?|VARIABLE RES|RHEOSTAT)\b/],
  ["Ferrite bead", /\b(FERRITE|BEAD)\b/],
  ["LED", /\bLEDS?\b|LIGHT EMITTING/],
  ["Fuse", /\b(FUSE|PTC|POLYFUSE|RESETTABLE)\b/],
  ["Crystal/Osc", /\b(CRYSTAL|XTAL|OSCILLATOR|RESONATOR)\b/],
  ["Transistor", /\b(MOSFET|TRANSISTOR|BJT|NPN|PNP|N-CH|P-CH|N-CHANNEL|P-CHANNEL|IGBT)\b/],
  ["Diode", /\b(DIODES?|SCHOTTKY|ZENER|TVS|RECTIFIER|ESD SUPPRESS|ESD PROT)/],
  ["Capacitor", /\b(CAP|CAPS|CAPACITORS?|MLCC|CERAMIC CAP|ELECTROLYTIC|TANTALUM|CAP CER)\b|\d\s*(PF|NF|UF|µF|ΜF)\b/],
  ["Inductor", /\b(IND|INDUCTORS?|CHOKE|COIL)\b|\d\s*(NH|UH|µH|MH)\b/],
  ["Resistor", /\bRES(\d|\b)|RESISTORS?|\bOHMS?\b|Ω|THICK FILM|THIN FILM|CHIP RES/],
  ["Switch", /\b(SWITCH|TACTILE|PUSHBUTTON|BUTTON)\b/],
  ["Connector", /\b(CONN|CONNECTOR|HEADER|RECEPTACLE|SOCKET|TERMINAL|JACK|PLUG|USB-?C)\b/],
  ["IC", /\b(REGULATORS?|LDO|CONVERTER|IC|MCU|MICROCONTROLLER|AMPLIFIER|OP ?AMP|SENSOR|DRIVER|INTERFACE|MEMORY|FLASH|EEPROM|LOGIC|BUFFER|TRANSCEIVER|COMPARATOR|ADC|DAC|PMIC|CHARGER|CONTROLLER)\b/],
];

function typeFromDescription(desc) {
  const d = desc.toUpperCase();
  for (const [type, re] of DESC_TYPE_RULES) if (re.test(d)) return type;
  return "";
}

const PACKAGE_RE = /\b(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512|2220|SOT-?23(?:-[356])?|SOT-?223(?:-3)?|SOT-?89|SOT-?363|SOT-?563|SOT-?323|SOT-?143|SC-?70(?:-[56])?|SC-?59|SOD-?123F?|SOD-?323F?|SOD-?523|SOD-?923|SOD-?80|DO-?214A[ABC]|DO-?41|DO-?35|SMA|SMB|SMC|SMAF|TO-?92|TO-?220|TO-?252|TO-?263|DPAK|D2PAK|SOIC-?\d+|SOP-?\d+|SSOP-?\d+|TSSOP-?\d+|MSOP-?\d+|QFN-?\d+|DFN-?\d+|VQFN-?\d+|WSON-?\d+|SON-?\d+|LQFP-?\d+|TQFP-?\d+|QFP-?\d+|BGA-?\d*|LGA-?\d+|ESOP-?\d+|DIP-?\d+|PDIP-?\d+|TSOT-?23(?:-\d)?)\b/i;
const PACKAGE_ORDER = ["01005", "0201", "0402", "0603", "0805", "1206", "1210", "1812", "2010", "2220", "2512"];

function valueFromDescription(d, type) {
  let m;
  if (type === "Resistor" || type === "Potentiometer" || !type) {
    if ((m = /(\d+(?:\.\d+)?)\s*([KMGkm]?)\s*(?:OHMS?|Ω)/i.exec(d)))
      return { valueNum: parseFloat(m[1]) * (SI[m[2].toUpperCase() === "M" && m[2] === "m" ? "m" : m[2].toUpperCase()] || 1), unit: "Ω" };
    if (type && (m = /\b(\d+[RKM]\d*|\d+(?:\.\d+)?[KM])\b/i.exec(d)))
      return { valueNum: parseRKM(m[1]), unit: "Ω" };
  }
  if (type === "Capacitor" || !type) {
    if ((m = /(\d+(?:\.\d+)?)\s*([PNUµμ])\s*F\b/i.exec(d)))
      return { valueNum: parseFloat(m[1]) * SI[m[2].toLowerCase() === "µ" || m[2].toLowerCase() === "μ" ? "u" : m[2].toLowerCase()], unit: "F" };
  }
  if (type === "Inductor" || type === "Ferrite bead" || !type) {
    if ((m = /(\d+(?:\.\d+)?)\s*([NUµμ])\s*H\b/i.exec(d)))
      return { valueNum: parseFloat(m[1]) * SI[m[2].toLowerCase() === "µ" || m[2].toLowerCase() === "μ" ? "u" : m[2].toLowerCase()], unit: "H" };
    if (type === "Ferrite bead" && (m = /(\d+(?:\.\d+)?)\s*(?:OHMS?|Ω)/i.exec(d)))
      return { valueNum: parseFloat(m[1]), unit: "Ω" };
  }
  if (type === "Crystal/Osc" && (m = /(\d+(?:\.\d+)?)\s*([KMG]?)HZ\b/i.exec(d)))
    return { valueNum: parseFloat(m[1]) * (SI[m[2].toUpperCase()] || 1), unit: "Hz" };
  return {};
}

// ---------------------------------------------------------------- main
/**
 * @param {{mpn?:string, description?:string, ocrText?:string}} part
 * @returns {{type:string, subtype:string, valueNum:number|null, unit:string, value:string,
 *            package:string, tolerance:number|null, voltage:number|null, power:string, dielectric:string}}
 */
export function classify(part) {
  const desc = normalizeText(part.description || "");
  const mpn = (part.mpn || "").trim();
  const fromMpn = decodeMpn(mpn);
  const descType = typeFromDescription(desc);
  const type = descType || fromMpn.type || "Other";

  const out = {
    type, subtype: "", valueNum: null, unit: "", value: "",
    package: "", tolerance: null, voltage: null, power: "", dielectric: "",
  };

  const unitFor = { Resistor: "Ω", Potentiometer: "Ω", Capacitor: "F", Inductor: "H" };
  // MPN-decoded parameters are exact; description fills in the gaps.
  if (fromMpn.type === type) {
    if (fromMpn.valueNum != null) { out.valueNum = fromMpn.valueNum; out.unit = unitFor[type] || ""; }
    if (fromMpn.package) out.package = fromMpn.package;
    if (fromMpn.tolerance != null) out.tolerance = fromMpn.tolerance;
    if (fromMpn.voltage != null) out.voltage = fromMpn.voltage;
    if (fromMpn.dielectric) out.dielectric = fromMpn.dielectric;
  }

  if (desc) {
    if (out.valueNum == null) {
      const v = valueFromDescription(desc, type === "Other" ? "" : type);
      if (v.valueNum != null && isFinite(v.valueNum)) { out.valueNum = v.valueNum; out.unit = v.unit; }
    }
    if (!out.package) {
      const p = PACKAGE_RE.exec(desc);
      if (p) out.package = p[1].toUpperCase().replace(/^(SOT|SOD|SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|VQFN|WSON|SON|LQFP|TQFP|QFP|LGA|ESOP|DIP|PDIP|TO|DO|SC|TSOT)-?/, "$1-");
    }
    let m;
    if (out.tolerance == null && (m = /±?\s*(\d+(?:\.\d+)?)\s*%/.exec(desc))) out.tolerance = parseFloat(m[1]);
    if (out.voltage == null && (m = /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*V(?:DC|AC)?\b/i.exec(desc))) out.voltage = parseFloat(m[1]);
    if (!out.power && (m = /\b(\d+\/\d+|\d*\.\d+|\d+)\s*W\b/i.exec(desc))) out.power = `${m[1]}W`;
    if (!out.dielectric && (m = /\b(X7R|X5R|C0G|NP0|X6S|X7S|X7T|Y5V|X8R)\b/i.exec(desc))) out.dielectric = m[1].toUpperCase().replace("NP0", "C0G");
  }

  // Fixed-output regulators carry their voltage in the MPN (AMS1117-3.3).
  if (type === "IC" && (REGULATOR_RE.test(desc.toUpperCase()) || REGULATOR_RE.test(mpn.toUpperCase()))) {
    out.subtype = "Voltage regulator";
    if (out.voltage == null) {
      let m;
      if ((m = /-(\d{1,2}\.\d{1,2})(?!\d)/.exec(mpn))) out.voltage = parseFloat(m[1]);       // AMS1117-3.3, AP2112K-3.3TRG1
      else if ((m = /-(\d)(\d)(?![\d.])/.exec(mpn))) out.voltage = parseFloat(`${m[1]}.${m[2]}`); // MCP1700-33
    }
  }

  if (out.valueNum != null) {
    out.valueNum = Number(out.valueNum.toPrecision(12));
    out.value = formatSI(out.valueNum, out.unit);
  }
  return out;
}

export function packageRank(pkg) {
  const i = PACKAGE_ORDER.indexOf(pkg);
  return i === -1 ? 100 : i;
}

/** Imperial package code (or IC package name) found anywhere in a string. */
export function extractPackage(text) {
  if (!text) return "";
  const s = String(text);
  const imp = /(?:^|[^\d])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2220|2512)(?!\d)/.exec(s);
  if (imp) return imp[1];
  const p = PACKAGE_RE.exec(s.replace(/_/g, "-"));
  return p ? p[1].toUpperCase().replace(/^(SOT|SOD|SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|VQFN|WSON|SON|LQFP|TQFP|QFP|LGA|ESOP|DIP|PDIP|TO|DO|SC|TSOT)-?/, "$1-") : "";
}

/** Parse a schematic value like "100k", "4k7", "0.1uF", "2n2", "10R", "4.7µH". */
export function parseValueString(v, type) {
  const r = parseValueStringRaw(v, type);
  return r == null ? null : Number(r.toPrecision(12));
}

function parseValueStringRaw(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/\s+/g, "").replace(/Ω|ohms?/i, "");
  let m = /^(\d+)([pnuµμmkKMGR])(\d+)[FH]?$/.exec(s); // 4k7, 2n2, 4u7, 4R7
  if (m) {
    const p = m[2] === "R" ? "" : m[2];
    return parseFloat(`${m[1]}.${m[3]}`) * mult(p);
  }
  m = /^(\d+(?:\.\d+)?)([pnuµμmkKMG]?)[FH]?$/.exec(s);
  if (m) return parseFloat(m[1]) * mult(m[2]);
  return null;
}

function mult(p) {
  if (!p) return 1;
  if (p === "m") return 1e-3;
  if (p === "K" || p === "k") return 1e3;
  return { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, M: 1e6, G: 1e9 }[p] ?? 1;
}
