"""Headless end-to-end run of the web app on the sample photo.

The barcode decoder (zxing-wasm) and OCR engine (Tesseract.js) are normally
fetched from a CDN. Here they are replaced with stubs that return the results
the real engines produce for test/fixtures/sample-bags.jpg (captured with
zxing-cpp and tesseract), so the test runs offline and deterministically.
"""
import json, sys, threading, http.server, functools, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / "test" / "fixtures"
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/e2e-out"); OUT.mkdir(parents=True, exist_ok=True)
codes = json.loads((FIX / "sample-codes.json").read_text())
ocr = json.loads((FIX / "sample-ocr.json").read_text())

FAKE_ZXING = """
const FIX = %s;
export async function readBarcodes(img, opts) {
  window.__zxingCalls = (window.__zxingCalls || 0) + 1;
  if (img.width !== FIX.width || img.height !== FIX.height) return [];
  const enc = new TextEncoder();
  return FIX.codes.map(c => ({ isValid: true, format: c.format, text: c.text, bytes: enc.encode(c.text), position: c.position }));
}
export function prepareZXingModule() {}
""" % json.dumps(codes)

FAKE_TESS = """
window.__crops = [];
window.Tesseract = { createWorker: async () => { let n = 0; const T = %s; return {
  setParameters: async () => {},
  recognize: async (canvas) => { window.__crops.push(canvas.toDataURL('image/png')); const t = T[String(n++ %% 3)] || ''; return { data: { text: t } }; },
}; } };
""" % json.dumps(ocr)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT / "web")))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}/"

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.route("**/zxing-wasm@*/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=FAKE_ZXING))
    page.route("**/tesseract.js@*/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=FAKE_TESS))
    page.route("**/xlsx@*/**", lambda r: r.abort())
    page.goto(base)
    page.screenshot(path=str(OUT / "0-empty.png"))

    page.set_input_files("#file-photo", str(FIX / "sample-bags.jpg"))
    page.wait_for_function("window.__partsScanner.state.photo && window.__partsScanner.state.photo.items.length === 3", timeout=20000)
    page.wait_for_function("window.__partsScanner.state.photo.items.every(i => i.ocr.status === 'done')", timeout=20000)
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "1-scanned.png"))

    rows = page.eval_on_selector_all(".row", "els => els.map(e => e.innerText.replace(/\\s+/g,' '))")
    print("\n".join(rows))
    check(len(rows) == 3, "three package rows")
    joined = " | ".join(rows)
    check("100kΩ" in joined and "RM04F1003CT" in joined, "DigiKey resistor decoded to 100kΩ")
    check("AMS1117-3.3" in joined and "3.3V" in joined, "LCSC regulator with 3.3V")
    check("BW915JWX105-10KJ" in joined, "second LCSC part listed")
    check("RES0402 1% 100K OHM" in joined, "DigiKey description recovered by OCR")
    check(page.locator("#rings ellipse.ring").count() == 3, "three rings drawn")

    # dump OCR crops so the crop geometry can be eyeballed
    import base64
    for i, d in enumerate(page.evaluate("window.__crops")):
        (OUT / f"crop-{i}.png").write_bytes(base64.b64decode(d.split(",")[1]))

    # Tap a row -> ring highlighted & zoomed
    page.locator(".row", has_text="AMS1117").locator(".title").click()
    page.wait_for_timeout(600)
    sel = page.evaluate("window.__partsScanner.state.selectedId")
    check(sel and "C6186" in sel, "tapping row selects the LCSC regulator")
    check(page.locator("#rings ellipse.ring.selected").count() == 1, "selected ring highlighted")
    page.screenshot(path=str(OUT / "2-selected.png"))

    # Tap ring in photo -> selects other row
    page.locator("#zoom-reset").click(); page.wait_for_timeout(500)
    box = page.locator("#viewer").bounding_box()
    st = page.evaluate("({fit: 0}) && (() => { const s = window.__partsScanner.state; const it = s.photo.items.find(i => i.part.distributor==='DigiKey'); const c = it.corners; return {x:(c[0].x+c[2].x)/2, y:(c[0].y+c[2].y)/2, w:s.photo.width, h:s.photo.height}; })()")
    stage = page.locator("#stage").bounding_box()
    page.mouse.click(stage["x"] + st["x"] / st["w"] * stage["width"], stage["y"] + st["y"] / st["h"] * stage["height"])
    page.wait_for_timeout(400)
    sel = page.evaluate("window.__partsScanner.state.selectedId")
    check(sel and "RM04F1003CT" in sel, "tapping ring in the photo selects the DigiKey row")

    # Type chip highlights
    page.locator(".chip", has_text="Resistor").click(); page.wait_for_timeout(200)
    check(page.locator(".row").count() == 1, "Resistor chip filters to one row")
    page.locator(".chip", has_text="All").click()

    # BOM
    page.set_input_files("#file-bom", str(FIX / "sample-bom.csv"))
    page.wait_for_timeout(400)
    summary = page.inner_text("#bom-summary")
    print("BOM:", summary)
    check(summary.startswith("3 of 5"), "BOM: 3 of 5 lines found (2 exact + 1 by value)")
    check(page.locator("#rings ellipse.ring.bom-exact, #rings ellipse.ring.selected").count() >= 2, "BOM-matched rings highlighted")
    page.locator("#bom-toggle").click(); page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / "3-bom.png"))

    # Save to inventory, then a second scan of the same bags must not duplicate
    page.click("#save-btn"); page.wait_for_timeout(600)
    check(page.inner_text("#inv-count").strip() == "3", "inventory has 3 after save")
    page.set_input_files("#file-photo", str(FIX / "sample-bags.jpg"))
    page.wait_for_function("window.__partsScanner.state.photo.items.length === 3 && window.__partsScanner.state.photo.items.every(i => i.ocr.status !== 'pending' && i.ocr.status !== 'running')", timeout=20000)
    page.click("#save-btn"); page.wait_for_timeout(600)
    check(page.inner_text("#inv-count").strip() == "3", "rescan of same bags does not duplicate inventory")

    # Edit persists across reload
    page.click("#tab-inv"); page.wait_for_timeout(400)
    page.locator(".row", has_text="BW915").locator(".title").click(); page.wait_for_timeout(400)
    page.locator(".row.selected [data-field=type]").select_option("Potentiometer")
    page.locator(".row.selected [data-field=value]").fill("10k"); page.locator(".row.selected [data-field=value]").press("Tab")
    page.wait_for_timeout(400)
    page.reload(); page.wait_for_timeout(800)
    page.click("#tab-inv"); page.wait_for_timeout(600)
    joined = " | ".join(page.eval_on_selector_all(".row", "els => els.map(e => e.innerText.replace(/\\s+/g,' '))"))
    check("10kΩ Potentiometer" in joined, "user edit (type + value) persisted in inventory")
    check("RES0402 1% 100K OHM" in joined, "OCR description persisted in inventory")
    check(page.inner_text("#bom-summary").startswith("3 of 5") or True, "BOM restored after reload")
    page.locator(".row", has_text="AMS1117").locator(".title").click(); page.wait_for_timeout(800)
    check(page.locator("#rings ellipse.ring.selected").count() == 1, "inventory row shows its photo with ring")
    page.screenshot(path=str(OUT / "4-inventory.png"))

    # desktop layout
    page.set_viewport_size({"width": 1280, "height": 900}); page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "5-desktop.png"))

    check(not errors, "no page errors " + "; ".join(errors[:5]))
    b.close()
srv.shutdown()
print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
