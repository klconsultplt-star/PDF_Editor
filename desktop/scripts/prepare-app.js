// Copies the editor (the same files as the web version) into desktop/app.
// With --lite: PDF Editor Lite, the same app without text recognition (OCR).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(__dirname, '..', 'app');
const LITE = process.argv.includes('--lite');
const FILES = ['index.html', 'styles.css', 'app.js', 'convert.js', 'ocr.js', 'security.js', 'compress.js', 'pdftext.js', 'signature.js']
  .filter((f) => !(LITE && f === 'ocr.js'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
fs.cpSync(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'), {
  recursive: true,
  filter: (src) => !(LITE && path.relative(path.join(ROOT, 'vendor'), src).split(path.sep)[0] === 'ocr'),
});
if (LITE) {
  const html = path.join(OUT, 'index.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(/\s*<script src="ocr.js"><\/script>/, '').replace('<title>PDF Editor</title>', '<title>PDF Editor Lite</title>'));
}
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Copied ${LITE ? 'PDF Editor Lite' : 'the editor'} into desktop/app (${(size(OUT) / 1e6).toFixed(1)} MB)`);
