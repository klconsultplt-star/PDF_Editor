#!/usr/bin/env python3
"""Bundle the editor into one self-contained HTML file: dist/pdf-editor.html.

The normal app (index.html) loads styles.css, app.js, export.js and the
vendor/ libraries as separate files. This script inlines all of them so the
editor can be shared or downloaded as a single file and opened by
double-clicking it.

qpdf (password support) is built in too. Text recognition (OCR) downloads its
engine from the jsDelivr CDN the first time it's used (internet needed once);
the desktop app includes everything offline.

The pdf.js worker is inlined as a normal script. pdf.js notices it
(window.pdfjsWorker) and does its work on the page itself instead of in a
separate worker, which is a little slower on very large PDFs but needs no
extra file.

Run it again after changing any of the app's files:
    python3 build-single-file.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "dist" / "pdf-editor.html"


def read(name):
    return (ROOT / name).read_text(encoding="utf-8")


def inline_script(name):
    code = read(name).replace("</script", "<\\/script")
    return f"<script>/* {name} */\n{code}\n</script>"


html = read("index.html")

html = html.replace(
    '<link rel="stylesheet" href="styles.css">',
    f"<style>\n{read('styles.css')}\n</style>",
)

scripts = re.findall(r'<script src="([^"]+)"></script>', html)
assert scripts, "no scripts found in index.html"
for src in scripts:
    replacement = inline_script(src)
    if src == "vendor/pdf.min.js":
        # Load the worker code on the page, right after pdf.js itself.
        replacement += "\n" + inline_script("vendor/pdf.worker.min.js")
    if src == "ocr.js":
        # The OCR loader is built in; the engine and languages (about 15 MB)
        # come from the jsDelivr CDN on first use, since a page opened from
        # disk can't load them from files. The desktop app has them built in.
        replacement = inline_script("vendor/ocr/tesseract.min.js") + "\n" + replacement
    if src == "security.js":
        # Password support normally loads qpdf on first use; build it in here.
        replacement = inline_script("vendor/qpdf.js") + "\n" + inline_script("vendor/qpdf-wasm.js") + "\n" + replacement
    html = html.replace(f'<script src="{src}"></script>', replacement)

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(html, encoding="utf-8")
print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.1f} MB)")
