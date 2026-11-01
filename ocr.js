/* Text recognition (OCR) for scanned pages, in English, Malay and Chinese.
 *
 * Uses Tesseract (tesseract.js, Apache-2.0) running locally in WebAssembly.
 * For each page it returns:
 *   - an invisible text layer as a small PDF page, placed over the scan to
 *     make the PDF searchable and selectable, and readable by the converter;
 *   - the recognised text and an overall confidence score.
 *
 * Where the files come from:
 *   - desktop app or served over http(s): the copies in vendor/ocr (offline);
 *   - a page opened straight from disk in a browser (file://), where browsers
 *     block loading these files: the same versions from the jsDelivr CDN.
 */
(() => {
  'use strict';

  const LANGUAGES = [
    { code: 'eng', label: 'English' },
    { code: 'msa', label: 'Malay' },
    { code: 'chi_sim', label: 'Chinese (Simplified)' },
    { code: 'chi_tra', label: 'Chinese (Traditional)' },
  ];
  const DPI = 300;
  const MAX_SIDE = 5000; // pixels; keeps memory in check for large pages

  const local = location.protocol !== 'file:' || !!window.desktop;
  const PATHS = local
    ? { workerPath: 'vendor/ocr/worker.min.js', corePath: 'vendor/ocr', langPath: 'vendor/ocr/lang' }
    : {}; // tesseract.js defaults: matching versions on cdn.jsdelivr.net

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the text recognition engine (' + src + ')'));
      document.head.appendChild(s);
    });
  }

  let worker = null, workerLangs = '', progressHandler = null;

  async function getWorker(langs) {
    const key = langs.join('+');
    if (worker && workerLangs === key) return worker;
    if (worker) { await worker.terminate(); worker = null; }
    if (!window.Tesseract) await loadScript('vendor/ocr/tesseract.min.js');
    worker = await Tesseract.createWorker(langs, 1 /* LSTM engine */, {
      ...PATHS,
      cacheMethod: local ? 'none' : 'write', // the CDN version is kept for offline use next time
      logger: (m) => { if (progressHandler && m.status === 'recognizing text') progressHandler(m.progress); },
      errorHandler: () => {},
    });
    workerLangs = key;
    return worker;
  }

  // Grey or yellowed paper → white paper: scale brightness so the paper's
  // level becomes white, keeping black at black so letter shapes don't
  // change. (Recognition works in shades of grey, so colour isn't needed.)
  function whitenPaper(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const hist = new Uint32Array(256);
    const lum = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) { lum[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; hist[lum[j]]++; }
    let n = 0, paper = 255;
    for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= 0.6 * lum.length) { paper = v; break; } } // most of a page is paper
    const k = 255 / Math.max(96, paper); // don't over-brighten very dark pages
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) d[i] = d[i + 1] = d[i + 2] = Math.min(255, lum[j] * k);
    ctx.putImageData(img, 0, 0);
  }

  // Erase long straight lines (table rules, underlines, borders) from a
  // black-and-white copy of the page: they confuse recognition, and real
  // letters are never this long.
  function removeLines(ctx, w, h, grow = 3) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const dark = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < dark.length; i += 4, j++) dark[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 150 ? 1 : 0;
    const minRun = Math.round(DPI * 0.55); // 14 mm
    const erase = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let start = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && dark[y * w + x];
        if (on && start < 0) start = x;
        if (!on && start >= 0) { if (x - start >= minRun) for (let k = start; k < x; k++) erase[y * w + k] = 1; start = -1; }
      }
    }
    for (let x = 0; x < w; x++) {
      let start = -1;
      for (let y = 0; y <= h; y++) {
        const on = y < h && dark[y * w + x];
        if (on && start < 0) start = y;
        if (!on && start >= 0) { if (y - start >= minRun) for (let k = start; k < y; k++) erase[k * w + x] = 1; start = -1; }
      }
    }
    // Widen in every direction to catch the soft, grey edges of the lines,
    // which would otherwise be read as | or ] marks.
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!erase[y * w + x]) continue;
      for (let dy = -grow; dy <= grow; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -grow; dx <= grow; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) out[yy * w + xx] = 1; }
      }
    }
    for (let j = 0, i = 0; j < out.length; j++, i += 4) if (out[j]) d[i] = d[i + 1] = d[i + 2] = 255;
    ctx.putImageData(img, 0, 0);
  }

  // How many degrees the text is tilted (scans are rarely perfectly straight).
  // Tries angles and keeps the one where text lines line up best, i.e. where
  // the rows of dark pixels form the sharpest peaks.
  function measureTilt(canvas) {
    const scale = Math.min(1, 1000 / canvas.width);
    const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const xs = [], ys = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 128) { xs.push(x); ys.push(y); }
    }
    if (xs.length < 200) return 0;
    const score = (deg) => {
      const t = Math.tan((deg * Math.PI) / 180);
      const rows = new Float64Array(h * 2);
      for (let k = 0; k < xs.length; k++) { const r = Math.round(ys[k] - xs[k] * t) + h / 2; if (r >= 0 && r < rows.length) rows[r]++; }
      let s = 0;
      for (let r = 1; r < rows.length; r++) s += (rows[r] - rows[r - 1]) ** 2;
      return s;
    };
    let best = 0, bestScore = score(0);
    for (let a = -5; a <= 5; a += 0.25) { const sc = score(a); if (sc > bestScore) { bestScore = sc; best = a; } }
    for (let a = best - 0.25; a <= best + 0.25; a += 0.05) { const sc = score(a); if (sc > bestScore) { bestScore = sc; best = a; } }
    return Math.abs(best) < 0.1 ? 0 : Math.round(best * 100) / 100;
  }

  // canvas: the page at roughly 300 DPI. Returns { pdf, text, confidence, tilt }
  // where tilt (degrees) is how much the scan was straightened before reading.
  async function recognize(canvas, { langs, onProgress = () => {}, grow }) {
    if (!langs || !langs.length) throw new Error('Choose at least one language.');
    const w = await getWorker(langs);
    const tilt = measureTilt(canvas);
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, copy.width, copy.height);
    // Straighten around the centre (the text layer is tilted back to match when placed).
    ctx.translate(copy.width / 2, copy.height / 2);
    ctx.rotate((-tilt * Math.PI) / 180);
    ctx.translate(-copy.width / 2, -copy.height / 2);
    ctx.drawImage(canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    whitenPaper(ctx, copy.width, copy.height);
    removeLines(ctx, copy.width, copy.height, grow);
    progressHandler = onProgress;
    try {
      const res = await w.recognize(copy, { pdfTitle: 'OCR', pdfTextOnly: true }, { text: true, pdf: true });
      const pdf = await joinChineseWords(new Uint8Array(res.data.pdf));
      return { pdf, text: res.data.text, confidence: res.data.confidence, tilt };
    } finally {
      progressHandler = null;
    }
  }

  // Tesseract ends every word with a space, and its word widths don't match
  // the gaps between words, so PDF readers guess where words break. That is
  // fine for English and Malay, but Chinese is written without spaces: a
  // search for "年度" must not have to match "年 度". So for Chinese words we
  // drop the trailing space and make each word exactly as wide as the step
  // to the next word on the line, so they join up.
  const isCJKCode = (c) => (c >= 0x2e80 && c <= 0x2fdf) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
  const GLYPH_WIDTH = 0.5; // every glyph of Tesseract's text-layer font is half an em wide

  function joinWords(text) {
    // "/f 65 Tf" sets the size; each word is "<stretch> Tz [ <codes> ] TJ",
    // usually followed by "<dx> <dy> Td" to the next word.
    const re = /\/\S+ ([\d.]+) Tf|([\d.]+) Tz \[ <((?:[0-9A-Fa-f]{4})+)> \] TJ(?:\s+([-\d.]+) ([-\d.]+) Td)?/g;
    const words = [];
    let size = 12, m;
    while ((m = re.exec(text))) {
      if (m[1]) { size = parseFloat(m[1]); continue; }
      const codes = m[3].match(/.{4}/g).map((h) => parseInt(h, 16));
      words.push({ start: m.index, end: m.index + m[0].length, raw: m[0], tz: parseFloat(m[2]), codes, size,
        dx: m[4] != null ? parseFloat(m[4]) : null, dy: m[5] != null ? parseFloat(m[5]) : null });
    }
    // Drop the trailing space after Chinese words.
    for (const w of words) {
      w.cjkEnd = w.codes.length > 1 && w.codes[w.codes.length - 1] === 0x20 && isCJKCode(w.codes[w.codes.length - 2]);
      w.out = w.cjkEnd ? w.codes.slice(0, -1) : w.codes;
      w.width = (w.codes.length * GLYPH_WIDTH * w.size * w.tz) / 100; // as Tesseract drew it
    }
    // Write each run of Chinese words on a line as ONE piece of text spanning
    // the same width, so readers can't split it into separate words.
    let out = '', pos = 0, changed = false;
    for (let i = 0; i < words.length; i++) {
      const first = words[i];
      if (!first.cjkEnd) continue;
      let j = i;
      while (j + 1 < words.length) {
        const w = words[j], next = words[j + 1];
        const sameLine = w.dx != null && w.dx > 0 && Math.abs(w.dy) < w.size * 0.5;
        const adjacent = /^\s*$/.test(text.slice(w.end, next.start)) && next.size === w.size &&
          w.dx - w.out.length * w.size < w.size; // not across a wide gap (e.g. between table columns)
        if (!(w.cjkEnd && sameLine && adjacent && isCJKCode(next.codes[0]))) break;
        j++;
      }
      const group = words.slice(i, j + 1);
      const last = group[group.length - 1];
      const steps = group.slice(0, -1).reduce((s, w) => s + w.dx, 0);
      const width = steps + (last.cjkEnd ? last.width * (last.out.length / last.codes.length) : last.width);
      const codes = group.flatMap((w) => w.out);
      const tz = (100 * width) / (codes.length * GLYPH_WIDTH * first.size);
      const hex = codes.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join('');
      // The move to the next word was relative to the last word: add up the steps.
      const move = last.dx != null ? ` ${(steps + last.dx).toFixed(3)} ${group.reduce((s, w) => s + (w.dy || 0), 0).toFixed(3)} Td` : '';
      out += text.slice(pos, first.start) + `${tz.toFixed(3)} Tz [ <${hex}> ] TJ${move}`;
      pos = last.end;
      changed = true;
      i = j;
    }
    return changed ? out + text.slice(pos) : text;
  }

  async function joinChineseWords(bytes) {
    const { PDFDocument, PDFRawStream, decodePDFRawStream } = PDFLib;
    const doc = await PDFDocument.load(bytes);
    let changed = false;
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      let text;
      try { text = new TextDecoder('latin1').decode(decodePDFRawStream(obj).decode()); } catch { continue; }
      if (!/\bTJ\b/.test(text)) continue;
      const fixed = joinWords(text);
      if (fixed !== text) {
        doc.context.assign(ref, doc.context.flateStream(Uint8Array.from(fixed, (ch) => ch.charCodeAt(0))));
        changed = true;
      }
    }
    return changed ? doc.save({ useObjectStreams: false }) : bytes;
  }

  // Free the memory (about 100 MB with Chinese) once recognition is done.
  async function release() {
    if (worker) { await worker.terminate().catch(() => {}); worker = null; workerLangs = ''; }
  }

  const api = { LANGUAGES, DPI, MAX_SIDE, recognize, release };
  window.PdfOcr = api;
})();
