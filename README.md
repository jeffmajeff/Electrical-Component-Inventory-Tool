# Electrical Component Inventory Tool

A phone web app for inventorying the components in a prototype build. Lay your
distributor bags out flat, take one photo, and every bag's QR / DataMatrix code
is decoded into a searchable table: distributor PN, manufacturer PN, quantity,
description, and the type, value, package, tolerance and voltage inferred from them.

Everything runs in the browser on your phone. Photos and inventory never leave the device.

## Features

- **Multi-package scan** – finds every code in one photo (whole-image pass plus
  overlapping full-resolution tiles so small codes in a 12 MP photo are still found).
- **Label formats** – DigiKey / Mouser / most US & EU distributors (ECIA / ANSI
  MH10.8.2 DataMatrix), LCSC / JLCPCB QR codes, and a generic `KEY:VALUE` fallback.
- **Description from the printed label** – the 2D codes don't carry a description,
  so each label is cropped, straightened using the code's orientation, and read with
  OCR (Tesseract.js). Any field can be corrected by tapping the row.
- **Type / value inference** – from the description and from the MPN itself
  (Yageo, Cal-Chip, Panasonic ERJ, Vishay CRCW, Stackpole, UniOhm, Bourns resistors;
  Murata GRM, Samsung CL, TDK C, Yageo CC capacitors; prefix rules for inductors,
  ferrites, diodes, LEDs, transistors, ICs, regulators, crystals, connectors…).
- **Photo ↔ table linking** – every bag gets a numbered ring. Tap a row to
  highlight and zoom to its bag; tap a bag in the photo to jump to its row.
  Pinch / double-tap to zoom.
- **BOM check** – load a CSV / TSV / XLSX BOM (KiCad, JLCPCB and similar column
  names are recognised). Bags matching a BOM line by part number get a green ring;
  passives matching by value + package get an amber dashed ring. The BOM panel lists
  every line as found / found by value / missing, with quantity needed vs on hand.
- **Type highlighting** – tap a type chip (Resistor, Capacitor, Diode…) to filter
  the table and colour those bags in the photo.
- **Group and sort** – group by component type, then sort by value, package,
  voltage, tolerance, quantity or MPN.
- **Cumulative inventory** – *Save to inventory* stores the photo and its parts
  on the device (IndexedDB). Re-photographing the same bag updates it rather than
  double counting; separate bags of the same part are kept separately. The
  Inventory tab shows everything, and tapping a part opens the photo it was in.
- **Export** – CSV of the current table, and JSON backup / restore of the whole inventory.
- **Installable** – add to home screen for a full-screen app that also works offline
  once the decoder and OCR engine have been loaded once.

## Using it on your phone

The app is static files in [`web/`](web/). The included GitHub Actions workflow
publishes them to GitHub Pages on every push to `main`:

1. In the repo on GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push (or re-run the *Deploy to GitHub Pages* workflow).
3. Open `https://<user>.github.io/Electrical-Component-Inventory-Tool/` on your phone,
   then *Share → Add to Home Screen* (iPhone) or *⋮ → Install app* (Android).

HTTPS is required for the camera, which Pages provides.

### Photo tips

- Labels facing up, flat, not overlapping the codes; fill the frame with the bags.
- Avoid glare across a code on shiny anti-static bags — tilt slightly if needed.
- A 12 MP phone photo of 6–10 bags decodes reliably. If a bag is missed, take a closer shot.

## How it works

| Step | Module |
| --- | --- |
| Decode all QR / DataMatrix codes, with corner positions | `web/js/decode.js` ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm), zxing-cpp in WebAssembly) |
| Parse ECIA / LCSC / generic payloads | `web/js/parsers.js` |
| Locate each label relative to its code; ring and OCR crop geometry | `web/js/geometry.js` |
| OCR the label text, extract description & manufacturer | `web/js/ocr.js`, `web/js/labeltext.js` |
| Infer type, value, package, tolerance, voltage | `web/js/classify.js` |
| BOM parsing and matching | `web/js/bom.js` |
| Inventory persistence | `web/js/store.js` (IndexedDB) |
| UI | `web/index.html`, `web/js/app.js`, `web/css/app.css` |

Libraries are loaded from jsDelivr at pinned versions (zxing-wasm 3.1.5, tesseract.js 5.1.1,
SheetJS 0.18.5 only when an XLSX BOM is opened) and cached by the service worker.
No build step.

## Development

```sh
npm run serve      # http://localhost:8000
npm test           # unit tests (node --test), no dependencies
npm run test:e2e   # headless Chromium run of the full UI on test/fixtures/sample-bags.jpg (needs Python Playwright)
```

The end-to-end test swaps the CDN decoder and OCR engine for stubs that return the
results the real engines produce on the sample photo, so it runs offline.

To test on a phone against your local machine, serve over HTTPS (camera access
requires it), or use Pages.

## Roadmap ideas

- Online enrichment of descriptions (DigiKey / Mouser APIs need a small server or
  user-supplied API keys; LCSC lookup by C-number).
- Export straight into a KiCad parts database / BOM.
- Storage locations (drawer / bin) as first-class fields with a "where is it?" search.
