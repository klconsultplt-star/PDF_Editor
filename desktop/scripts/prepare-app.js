// Copies the editor (the same files as the web version) into desktop/app.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(__dirname, '..', 'app');
const FILES = ['index.html', 'styles.css', 'app.js', 'convert.js', 'ocr.js', 'security.js', 'signature.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
fs.cpSync(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'), { recursive: true });
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Copied the editor into desktop/app (${(size(OUT) / 1e6).toFixed(1)} MB)`);
