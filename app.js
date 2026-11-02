/* PDF Editor — runs entirely in the browser.
 *
 * pdf.js draws the original pages; pdf-lib builds the edited file on download.
 * Every edit (text, drawings, boxes, images) is kept as an "annotation" in PDF
 * coordinates (points, origin bottom-left), so what you see on screen and
 * what gets written to the file use the same numbers.
 */
(() => {
  'use strict';

  const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const THUMB_WIDTH = 130;
  const LINE_HEIGHT = 1.2;
  const HANDLE_PX = 9;
  const BLANK_SIZE = [0, 0, 612, 792]; // US Letter
  // The 12 fonts built into every PDF reader: regular, bold, italic and bold
  // italic of a sans, a serif and a monospaced family.
  const FONT_FAMILIES = {
    Helvetica: { css: 'Helvetica, Arial, sans-serif', names: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'] },
    Times: { css: '"Times New Roman", Times, serif', names: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'] },
    Courier: { css: '"Courier New", Courier, monospace', names: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] },
  };
  const FONTS = {}; // name -> { css, bold, italic }
  for (const { css, names } of Object.values(FONT_FAMILIES)) {
    names.forEach((n, i) => { FONTS[n] = { css, bold: i % 2 === 1, italic: i >= 2 }; });
  }
  const fontKey = (family, bold, italic) => FONT_FAMILIES[family].names[(bold ? 1 : 0) + (italic ? 2 : 0)];
  const cssFont = (name, size) => {
    const f = FONTS[name] || FONTS.Helvetica;
    return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${size}px ${f.css}`;
  };
  const isText = (a) => a && (a.type === 'text' || a.type === 'replace');
  // PDF Editor Lite is built without text recognition (no ocr.js).
  const HAS_OCR = !!window.PdfOcr;
  const WATERMARK = { text: 'DRAFT', size: 150, opacity: 0.1, angle: 45, font: 'HelveticaBold', color: '#000000' };

  // ---------- State ----------
  const sources = [];        // { bytes, pdfjs, lib, pageCache: Map }
  const images = new Map();  // id -> { bytes, kind: 'png'|'jpg', el }
  let pages = [];            // { id, src, srcPage, rotation, view, annots: [] }
  let fileName = 'document.pdf';
  let zoom = 1;
  let tool = 'select';
  let selection = null;      // { pageId, index }
  let currentPageId = null;
  let undoStack = [];
  let redoStack = [];
  let dirty = false;
  let nextId = 1;
  let measureFonts = null;   // pdf-lib fonts used to measure text widths
  let savePassword = '';     // password for downloads ('' = none)
  let pendingStamp = null;   // signature waiting to be placed: { imageId, w, h }
  let hoverChunk = null;     // existing text under the mouse in "Edit text" mode
  const chunkCache = new Map(); // "src:page" -> text chunks of an original page
  // Recognised text (OCR) per page id: { pdf: invisible text layer, rotation, langs }.
  // Kept outside the undo history; page ids survive undo/redo.
  const ocrLayers = new Map();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer');
  const sidebar = $('sidebar');
  const emptyState = $('emptyState');
  const colorInput = $('colorInput');
  const fontInput = $('fontInput');
  const sizeInput = $('sizeInput');
  const widthInput = $('widthInput');
  const watermarkInput = $('watermarkInput');

  // ---------- Small helpers ----------
  const uid = () => 'p' + (nextId++);
  const rad = (deg) => (deg * Math.PI) / 180;
  const rotateVec = (x, y, deg) => {
    const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
    return [x * c - y * s, x * s + y * c];
  };
  const toLocal = (a, px, py) => rotateVec(px - a.x, py - a.y, -(a.rot || 0));
  const fromLocal = (a, lx, ly) => {
    const [dx, dy] = rotateVec(lx, ly, a.rot || 0);
    return [a.x + dx, a.y + dy];
  };
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  };
  const pageById = (id) => pages.find((p) => p.id === id);
  const pageEl = (id) => viewer.querySelector(`.page[data-id="${id}"]`);

  let statusTimer;
  function status(msg, ms = 2500) {
    const el = $('status');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // Maps PDF points to screen pixels for a page at a given scale and rotation
  // (same math as pdf.js, which doesn't export its viewport class).
  function viewportFor(page, scale) {
    const [x1, y1, x2, y2] = page.view;
    const rot = ((page.rotation % 360) + 360) % 360;
    const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rot];
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const sideways = rot % 180 !== 0;
    const width = (sideways ? y2 - y1 : x2 - x1) * scale;
    const height = (sideways ? x2 - x1 : y2 - y1) * scale;
    const offX = (sideways ? cy - y1 : cx - x1) * scale;
    const offY = (sideways ? cx - x1 : cy - y1) * scale;
    const t = [a * scale, b * scale, c * scale, d * scale,
      offX - a * scale * cx - c * scale * cy, offY - b * scale * cx - d * scale * cy];
    const det = t[0] * t[3] - t[1] * t[2];
    return {
      width, height, scale, rotation: rot, transform: t,
      convertToViewportPoint: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
      convertToPdfPoint: (x, y) => {
        const dx = x - t[4], dy = y - t[5];
        return [(t[3] * dx - t[2] * dy) / det, (t[0] * dy - t[1] * dx) / det];
      },
    };
  }

  // ---------- Text measuring ----------
  async function loadMeasureFonts() {
    const doc = await PDFDocument.create();
    const fonts = {};
    for (const name of Object.keys(FONTS)) fonts[name] = await doc.embedFont(StandardFonts[name]);
    measureFonts = fonts;
  }

  // The built-in PDF fonts only cover Western characters; swap out the rest.
  function cleanText(text, font) {
    let out = '';
    for (const ch of text.replace(/\t/g, '    ')) {
      if (ch === '\n') { out += ch; continue; }
      try { font.encodeText(ch); out += ch; } catch { out += '?'; }
    }
    return out;
  }

  // Recompute a text annotation's box from its text and size (keeps top-left fixed).
  function layoutText(a, keepTop = true) {
    const font = measureFonts[a.font];
    a.text = cleanText(a.text, font);
    const lines = a.text.split('\n');
    const w = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, a.size)), a.size * 0.5);
    const h = lines.length * a.size * LINE_HEIGHT;
    if (keepTop && a.h != null) {
      const [tx, ty] = fromLocal(a, 0, a.h);
      const [dx, dy] = rotateVec(0, -h, a.rot);
      a.x = tx + dx; a.y = ty + dy;
    }
    a.w = w; a.h = h;
  }

  // Baseline (local y) of line i inside a text box.
  const baselineY = (a, i) => a.h - i * a.size * LINE_HEIGHT - a.size * 0.95;

  // ---------- Undo / redo ----------
  const snapshot = () => JSON.stringify({ pages, nextId });

  function checkpoint() {
    undoStack.push(snapshot());
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    dirty = true;
    updateButtons();
  }

  function restore(json) {
    const s = JSON.parse(json);
    const old = pages;
    const same = s.pages.length === old.length && s.pages.every((p, i) => p.id === old[i].id && p.src === old[i].src
      && p.srcPage === old[i].srcPage && p.rotation === old[i].rotation && String(p.view) === String(old[i].view));
    pages = s.pages;
    nextId = Math.max(nextId, s.nextId);
    selection = null;
    if (!same) { renderAll(); return; }
    // Same pages: redraw only the ones whose edits changed.
    closeTextEditor(false);
    const paras = (p) => JSON.stringify(p.annots.filter((a) => a.type === 'para').map((a) => [a.runs, a.x, a.y, a.width, a.wrap, a.rot]));
    pages.forEach((p, i) => {
      if (JSON.stringify(p.annots) === JSON.stringify(old[i].annots)) return;
      if (paras(p) !== paras(old[i])) refreshPage(p.id);
      else { drawOverlay(p.id); refreshThumb(p.id); }
    });
    updateButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    updateButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    updateButtons();
  }

  function updateButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
    $('saveBtn').disabled = !pages.length;
    $('watermarkBtn').disabled = !pages.length;
    $('splitBtn').disabled = !pages.length;
    $('passwordBtn').disabled = !pages.length;
    updateConvertButton();
    $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  }

  // ---------- Loading files ----------
  class Cancelled extends Error {}

  // Returns readable (decrypted) bytes, asking for the password if needed.
  async function unlock(bytes, name) {
    try {
      const lib = await PDFDocument.load(bytes);
      return { bytes, lib, password: '' };
    } catch (err) {
      // Not encrypted but pdf-lib can't read it: let pdf.js try, as before.
      if (!/encrypt/i.test(String(err && err.message))) return { bytes, lib: null, password: '' };
    }
    status('Unlocking ' + name + '…', 30000);
    try {
      // Opens freely but has editing/printing restrictions.
      return { bytes: await PdfSecurity.decrypt(bytes, ''), lib: null, password: '' };
    } catch (err) {
      if (err.code !== 'password') throw err;
    }
    for (let wrong = false; ; wrong = true) {
      const pw = await askPassword(name, wrong);
      if (pw == null) throw new Cancelled('Cancelled');
      status('Unlocking ' + name + '…', 30000);
      try {
        return { bytes: await PdfSecurity.decrypt(bytes, pw), lib: null, password: pw };
      } catch (err) {
        if (err.code !== 'password') throw err;
      }
    }
  }

  function askPassword(name, wrong) {
    const dlg = $('unlockDialog');
    const form = dlg.querySelector('form');
    $('unlockName').textContent = name;
    $('unlockError').textContent = wrong ? 'Wrong password. Please try again.' : '';
    $('unlockInput').value = '';
    return new Promise((resolve) => {
      const done = (value) => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(value);
      };
      const onSubmit = (e) => { e.preventDefault(); done($('unlockInput').value); };
      const onClose = () => done(null);
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      $('unlockInput').focus();
    });
  }

  // Loads one PDF file; returns { pages, password }.
  async function loadSource(bytes, name = 'this PDF') {
    const unlocked = await unlock(bytes, name);
    bytes = unlocked.bytes;
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    task.onPassword = (updatePassword, reason) => {
      const pw = window.prompt(reason === 2 ? 'Wrong password. Try again:' : 'This PDF is password protected. Password:');
      if (pw == null) task.destroy(); else updatePassword(pw);
    };
    const pdfjs = await task.promise;
    const src = { bytes, pdfjs, lib: unlocked.lib, pageCache: new Map(), textPages: new Set() };
    sources.push(src);
    const index = sources.length - 1;
    const out = [];
    for (let n = 0; n < pdfjs.numPages; n++) {
      const p = await getPdfjsPage(src, n);
      out.push({ id: uid(), src: index, srcPage: n, rotation: p.rotate % 360, view: p.view.slice(), annots: [] });
    }
    // Note which pages contain real text; pages without any are scans
    // (pictures of text). Done in the background, page by page, so the
    // document shows straight away.
    src.textChecked = false;
    src.textReady = (async () => {
      for (const pg of out) {
        try {
          const tc = await (await getPdfjsPage(src, pg.srcPage)).getTextContent();
          if (tc.items.some((it) => it.str && it.str.trim())) src.textPages.add(pg.srcPage);
        } catch { src.textPages.add(pg.srcPage); }
      }
      src.textChecked = true;
      updateButtons();
    })();
    return { pages: out, password: unlocked.password, src };
  }

  function getPdfjsPage(src, n) {
    if (!src.pageCache.has(n)) src.pageCache.set(n, src.pdfjs.getPage(n + 1));
    return src.pageCache.get(n);
  }

  async function readFile(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  async function openFile(file) {
    if (!file) return;
    if (dirty && pages.length && !confirm('Open a new file? Unsaved changes will be lost.')) return;
    status('Opening ' + file.name + '…', 10000);
    try {
      const bytes = await readFile(file);
      const loaded = await loadSource(bytes, file.name);
      // Only replace the current document once the new one has loaded.
      sources.splice(0, sources.length - 1);
      loaded.pages.forEach((p) => { p.src = 0; });
      images.clear();
      chunkCache.clear();
      paraCache.clear();
      paraSync.clear();
      for (const pv of previews.values()) pv.page.then(() => pv.doc && pv.doc.destroy()).catch(() => {});
      previews.clear();
      ocrLayers.clear();
      sharpPage = null;
      strokeCache.clear();
      pages = loaded.pages;
      fileName = file.name;
      document.title = file.name + (HAS_OCR ? ' – PDF Editor' : ' – PDF Editor Lite');
      savePassword = loaded.password; // a locked file stays locked when downloaded
      updatePasswordButton();
      undoStack = []; redoStack = []; dirty = false; selection = null;
      zoom = fitZoom();
      renderAll();
      const n = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
      status(loaded.password
        ? `Opened ${file.name} (${n}). It's password protected: the downloaded copy keeps the same password (change it with the Password button).`
        : `Opened ${file.name} (${n})`, loaded.password ? 7000 : 2500);
      // Once the pages have been checked for text, mention scanned ones.
      loaded.src.textReady.then(() => {
        if (!sources.includes(loaded.src) || loaded.password) return;
        const scanned = pages.filter(isScanned).length;
        if (!scanned) return;
        const scanNote = HAS_OCR ? 'click Recognize text to make it searchable and convertible.' : 'its text is a picture, which PDF Editor Lite can\'t read (the full PDF Editor can).';
        status(`${file.name}: ${scanned === pages.length ? 'it is scanned' : scanned + ' page' + (scanned === 1 ? ' is' : 's are') + ' scanned'}: ${scanNote}`, 7000);
      });
    } catch (err) {
      if (err instanceof Cancelled) return status('Opening cancelled');
      console.error(err);
      status('Could not open this file: ' + (err.message || err), 5000);
    }
  }

  async function mergeFiles(files) {
    if (!files.length) return;
    try {
      const added = [];
      for (const f of files) added.push(...(await loadSource(await readFile(f), f.name)).pages);
      checkpoint();
      pages.push(...added);
      if (!fileName || !sources.length) fileName = files[0].name;
      renderAll();
      status(`Added ${added.length} page${added.length === 1 ? '' : 's'}`);
    } catch (err) {
      if (err instanceof Cancelled) return status('Cancelled');
      console.error(err);
      status('Could not add this file: ' + (err.message || err), 5000);
    }
  }

  function newBlankDocument() {
    sources.length = 0;
    images.clear();
    pages = [{ id: uid(), src: null, srcPage: 0, rotation: 0, view: BLANK_SIZE.slice(), annots: [] }];
    fileName = 'document.pdf';
    document.title = 'PDF Editor';
    chunkCache.clear();
    ocrLayers.clear();
    savePassword = '';
    updatePasswordButton();
    undoStack = []; redoStack = []; dirty = false; selection = null;
    zoom = fitZoom();
    renderAll();
  }

  function fitZoom() {
    if (!pages.length) return 1;
    const v = pages[0].view;
    const w = pages[0].rotation % 180 ? v[3] - v[1] : v[2] - v[0];
    const avail = viewer.clientWidth - 48;
    return Math.max(0.25, Math.min(1.5, Math.floor((avail / w) * 20) / 20));
  }

  // ---------- Rendering ----------
  // Pages near the screen get their pictures; pages scrolled far away give
  // the memory back (two full-size images per page add up quickly).
  const renderObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { sizeOverlay(e.target); renderBase(e.target); }
      else releasePage(e.target);
    }
  }, { root: viewer, rootMargin: '1200px 0px' });

  function sizeOverlay(el) {
    const page = pageById(el.dataset.id);
    if (!page) return;
    const vp = viewportFor(page, zoom);
    const ov = el.querySelector('canvas.overlay');
    const w = Math.round(vp.width * DPR), h = Math.round(vp.height * DPR);
    if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
    drawOverlay(page.id);
  }

  function releasePage(el) {
    const ov = el.querySelector('canvas.overlay');
    if (ov.width) { ov.width = 0; ov.height = 0; }
    if (el._drawing && el._drawing._task) el._drawing._task.cancel();
    el._drawing = null;
    const base = el.querySelector('canvas.base');
    if (base && base.width) { base.width = 0; base.height = 0; }
    el.dataset.rendered = '';
  }

  // Thumbnails are drawn one at a time, after the pages on screen, so they
  // don't slow down showing the document.
  const thumbQueue = new Set();
  let thumbBusy = false;
  async function drainThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (thumbQueue.size) {
        // Wait while pages on screen are still being drawn.
        while ([...viewer.querySelectorAll('.page')].some((el) => el._drawing)) await new Promise((r) => setTimeout(r, 50));
        const t = thumbQueue.values().next().value;
        thumbQueue.delete(t);
        if (t.isConnected) await renderThumb(t);
      }
    } finally { thumbBusy = false; }
  }
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) thumbQueue.add(e.target); else thumbQueue.delete(e.target);
    }
    setTimeout(drainThumbs, 150);
  }, { root: sidebar, rootMargin: '400px 0px' });

  function renderAll() {
    closeTextEditor(true);
    renderObserver.disconnect();
    thumbObserver.disconnect();
    viewer.querySelectorAll('.page').forEach((el) => el.remove());
    sidebar.innerHTML = '';
    emptyState.hidden = pages.length > 0;
    if (!pages.some((p) => p.id === currentPageId)) currentPageId = pages[0] && pages[0].id;

    pages.forEach((page, i) => {
      const vp = viewportFor(page, zoom);
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.id = page.id;
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      const base = document.createElement('canvas');
      base.className = 'base';
      const overlay = document.createElement('canvas');
      overlay.className = 'overlay';
      overlay.width = 0; overlay.height = 0; // sized when the page comes near the screen
      el.append(base, overlay);
      attachPointer(overlay, page.id);
      viewer.appendChild(el);
      renderObserver.observe(el);

      sidebar.appendChild(makeThumb(page, i));
    });
    viewer.dataset.tool = tool;
    updateButtons();
  }

  // Draws a page into a new canvas and swaps it in when it's ready, so the
  // old picture (stretched) stays visible meanwhile instead of a blank page.
  async function renderBase(el, force = false) {
    const page = pageById(el.dataset.id);
    if (!page) return;
    const key = zoom + ':' + page.rotation;
    if (el.dataset.rendered === key && !force) return;
    el.dataset.rendered = key;
    if (el._drawing && el._drawing._task) el._drawing._task.cancel();
    const fresh = document.createElement('canvas');
    fresh.className = 'base';
    el._drawing = fresh;
    const vp = await paintPage(page, fresh, zoom * DPR);
    if (!vp || el._drawing !== fresh) return; // cancelled or superseded
    el._drawing = null;
    const old = el.querySelector('canvas.base');
    if (old) old.replaceWith(fresh); else el.prepend(fresh);
  }

  // Draw the original page content (or blank white) onto a canvas.
  async function paintPage(page, canvas, scale) {
    const vp = viewportFor(page, scale);
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (page.src == null) return vp;
    if (canvas._task) canvas._task.cancel();
    try {
      const p = hasParas(page) ? await previewPage(page) : await getPdfjsPage(sources[page.src], page.srcPage);
      const viewport = p.getViewport({ scale, rotation: page.rotation });
      const task = (canvas._task = p.render({ canvasContext: ctx, viewport }));
      await task.promise;
      if (canvas._task === task) canvas._task = null;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return null;
      console.error(err);
    }
    return vp;
  }

  function drawOverlay(pageId) {
    const page = pageById(pageId);
    const el = pageEl(pageId);
    if (!page || !el) return;
    const canvas = el.querySelector('canvas.overlay');
    if (!canvas.width) return; // off screen: drawn when it comes back
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const vp = viewportFor(page, zoom * DPR);
    ctx.setTransform(...vp.transform);
    const editingHere = editing && editing.pageId === pageId;
    page.annots.forEach((a, i) => {
      // The text being typed is shown in the text box; keep its cover patch.
      if (editingHere && editing.index === i) { if (a.cover) drawCover(ctx, a.cover); return; }
      drawAnnot(ctx, a);
    });
    if (editingHere && editing.index < 0 && editing.annot.cover) drawCover(ctx, editing.annot.cover);
    if (drag && drag.pageId === pageId && drag.preview) drawAnnot(ctx, drag.preview);
    if (hoverChunk && hoverChunk.pageId === pageId && tool === 'edittext' && !editing) drawChunkOutline(ctx, hoverChunk.chunk);
    if (selection && selection.pageId === pageId) {
      const a = page.annots[selection.index];
      if (a) drawSelection(ctx, a);
    }
  }

  // A patch in the page's background colour that hides original text.
  function drawCover(ctx, c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(rad(c.rot || 0));
    ctx.fillStyle = c.fill;
    ctx.fillRect(0, 0, c.w, c.h);
    ctx.restore();
  }

  // ctx must already map PDF points to canvas pixels.
  function drawAnnot(ctx, a) {
    if (a.cover) drawCover(ctx, a.cover);
    ctx.save();
    if (a.type === 'pen') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (a.points.length === 1) ctx.lineTo(a.points[0][0] + 0.01, a.points[0][1]);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.translate(a.x, a.y);
    ctx.rotate(rad(a.rot || 0));
    switch (a.type) {
      case 'text':
      case 'replace': {
        if (a.opacity != null) ctx.globalAlpha = a.opacity;
        ctx.fillStyle = a.color;
        ctx.font = cssFont(a.font, a.size);
        ctx.textBaseline = 'alphabetic';
        a.text.split('\n').forEach((line, i) => {
          ctx.save();
          ctx.translate(0, baselineY(a, i));
          ctx.scale(1, -1);
          ctx.fillText(line, 0, 0);
          ctx.restore();
        });
        break;
      }
      case 'image': {
        const img = images.get(a.imageId);
        if (img && img.el.complete) {
          ctx.scale(1, -1);
          ctx.drawImage(img.el, 0, -a.h, a.w, a.h);
        } else if (img) {
          img.el.addEventListener('load', () => redrawAll(), { once: true });
        }
        break;
      }
      case 'highlight':
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = a.color;
        ctx.fillRect(0, 0, a.w, a.h);
        break;
      case 'whiteout':
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, a.w, a.h);
        break;
      case 'rect':
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.lineWidth;
        ctx.strokeRect(0, 0, a.w, a.h);
        break;
    }
    ctx.restore();
  }

  function drawSelection(ctx, a) {
    const px = 1 / (zoom * DPR); // one screen pixel in PDF units
    ctx.save();
    ctx.lineWidth = 1.5 * DPR * px;
    ctx.strokeStyle = '#2563eb';
    ctx.setLineDash([4 * DPR * px, 3 * DPR * px]);
    const b = bounds(a);
    ctx.translate(b.x, b.y);
    ctx.rotate(rad(b.rot));
    const pad = 3 * DPR * px;
    ctx.strokeRect(-pad, -pad, b.w + 2 * pad, b.h + 2 * pad);
    if (a.type !== 'pen') {
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      const hs = HANDLE_PX * DPR * px;
      ctx.fillRect(b.w - hs / 2, -hs / 2, hs, hs);
      ctx.strokeRect(b.w - hs / 2, -hs / 2, hs, hs);
    }
    ctx.restore();
  }

  // A rotated box describing an annotation (pen strokes use their bounding box).
  function bounds(a) {
    if (a.type === 'replace' && !a.text) return { ...a.cover }; // text deleted: just the patch
    if (a.type !== 'pen') return { x: a.x, y: a.y, w: a.w, h: a.h, rot: a.rot || 0 };
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    const r = a.lineWidth / 2;
    const x = Math.min(...xs) - r, y = Math.min(...ys) - r;
    return { x, y, w: Math.max(...xs) + r - x, h: Math.max(...ys) + r - y, rot: 0 };
  }

  function redrawAll() {
    pages.forEach((p) => drawOverlay(p.id));
  }

  // ---------- Thumbnails & page operations ----------
  function makeThumb(page, i) {
    const t = document.createElement('div');
    t.className = 'thumb' + (page.id === currentPageId ? ' current' : '');
    t.dataset.id = page.id;
    t.draggable = true;
    t.innerHTML = `<canvas></canvas><div class="num">${i + 1}</div>
      <div class="actions">
        <button data-act="rotl" title="Rotate left">⟲</button>
        <button data-act="rotr" title="Rotate right">⟳</button>
        <button data-act="blank" title="Insert blank page after">＋</button>
        <button data-act="del" title="Delete page">✕</button>
      </div>`;
    const v = viewportFor(page, 1);
    const c = t.querySelector('canvas');
    c.style.width = THUMB_WIDTH + 'px';
    c.style.height = (THUMB_WIDTH * v.height) / v.width + 'px';
    t.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act) return pageAction(act, page.id);
      currentPageId = page.id;
      sidebar.querySelectorAll('.thumb').forEach((x) => x.classList.toggle('current', x.dataset.id === page.id));
      pageEl(page.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-page', page.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    t.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-page')) return;
      e.preventDefault();
      t.classList.add('drag-over');
    });
    t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
    t.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('text/x-page');
      t.classList.remove('drag-over');
      if (!from || from === page.id) return;
      e.preventDefault();
      e.stopPropagation();
      movePage(from, page.id);
    });
    thumbObserver.observe(t);
    return t;
  }

  async function renderThumb(t) {
    const page = pageById(t.dataset.id);
    if (!page) return;
    const c = t.querySelector('canvas');
    const scale = (THUMB_WIDTH * DPR) / viewportFor(page, 1).width;
    const vp = await paintPage(page, c, scale);
    if (!vp) return;
    const ctx = c.getContext('2d');
    ctx.setTransform(...vp.transform);
    page.annots.forEach((a) => drawAnnot(ctx, a));
  }

  const thumbTimers = new Map();
  function refreshThumb(pageId) {
    clearTimeout(thumbTimers.get(pageId));
    thumbTimers.set(pageId, setTimeout(() => {
      thumbTimers.delete(pageId);
      const t = sidebar.querySelector(`.thumb[data-id="${pageId}"]`);
      if (t) renderThumb(t);
    }, 300));
  }

  function pageAction(act, id) {
    const i = pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (act === 'del') {
      if (pages.length === 1) return status('A PDF needs at least one page');
      checkpoint();
      pages.splice(i, 1);
    } else if (act === 'rotl' || act === 'rotr') {
      checkpoint();
      pages[i].rotation = (pages[i].rotation + (act === 'rotr' ? 90 : 270)) % 360;
    } else if (act === 'blank') {
      checkpoint();
      const v = pages[i].view;
      const size = [0, 0, v[2] - v[0], v[3] - v[1]];
      pages.splice(i + 1, 0, { id: uid(), src: null, srcPage: 0, rotation: pages[i].rotation, view: size, annots: [] });
    }
    selection = null;
    renderAll();
  }

  function movePage(fromId, toId) {
    const from = pages.findIndex((p) => p.id === fromId);
    const to = pages.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0) return;
    checkpoint();
    const [p] = pages.splice(from, 1);
    pages.splice(to, 0, p);
    renderAll();
  }

  // ---------- Pointer interaction ----------
  let drag = null;     // the gesture in progress
  let editing = null;  // the text box being typed into

  function pdfPoint(e, pageId) {
    const page = pageById(pageId);
    const canvas = pageEl(pageId).querySelector('canvas.overlay');
    const r = canvas.getBoundingClientRect();
    const vp = viewportFor(page, zoom);
    return vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
  }

  function hitTest(page, x, y) {
    const tol = 4 / zoom;
    for (let i = page.annots.length - 1; i >= 0; i--) {
      const a = page.annots[i];
      if (a.type === 'pen') {
        const lim = a.lineWidth / 2 + tol;
        for (let k = 0; k < a.points.length; k++) {
          const p = a.points[k], q = a.points[k + 1] || p;
          if (distToSegment(x, y, p, q) <= lim) return i;
        }
      } else if (inBox(a, x, y, tol) || (a.cover && inBox(a.cover, x, y, 0))) {
        return i;
      }
    }
    return -1;
  }

  function inBox(b, x, y, tol) {
    const [lx, ly] = toLocal(b, x, y);
    return lx >= -tol && ly >= -tol && lx <= b.w + tol && ly <= b.h + tol;
  }

  function distToSegment(x, y, [x1, y1], [x2, y2]) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  }

  function onHandle(a, x, y) {
    if (!a || a.type === 'pen') return false;
    const [lx, ly] = toLocal(a, x, y);
    const r = (HANDLE_PX / zoom) * 0.8;
    return Math.abs(lx - a.w) <= r && Math.abs(ly) <= r;
  }

  function select(pageId, index) {
    const old = selection && selection.pageId;
    selection = index >= 0 ? { pageId, index } : null;
    if (old && old !== pageId) drawOverlay(old);
    drawOverlay(pageId);
    if (selection) {
      const a = pageById(pageId).annots[index];
      if (a.color && a.color.startsWith('#')) colorInput.value = a.color;
      if (isText(a)) { sizeInput.value = a.size; fontInput.value = a.font; }
      if (a.lineWidth) widthInput.value = a.lineWidth;
    }
  }

  function attachPointer(canvas, pageId) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const page = pageById(pageId);
      const [x, y] = pdfPoint(e, pageId);
      currentPageId = pageId;
      if (editing) { closeTextEditor(); return; }

      if (tool === 'select') {
        const sel = selection && selection.pageId === pageId ? page.annots[selection.index] : null;
        if (onHandle(sel, x, y)) {
          drag = { kind: 'resize', pageId, index: selection.index, orig: { ...sel }, saved: false };
        } else {
          const i = hitTest(page, x, y);
          select(pageId, i);
          if (i >= 0) drag = { kind: 'move', pageId, index: i, start: [x, y], orig: JSON.parse(JSON.stringify(page.annots[i])), saved: false };
        }
      } else if (tool === 'text') {
        const i = hitTest(page, x, y);
        if (i >= 0 && isText(page.annots[i])) openTextEditor(pageId, i);
        else openTextEditor(pageId, -1, x, y);
        e.preventDefault();
        return;
      } else if (tool === 'edittext') {
        const i = hitTest(page, x, y);
        if (i >= 0 && page.annots[i].type === 'para') openParaEditor(pageId, i);
        else if (i >= 0 && isText(page.annots[i])) openTextEditor(pageId, i);
        else startTextEdit(pageId, x, y);
        e.preventDefault();
        return;
      } else if (tool === 'stamp') {
        if (pendingStamp) placeImage(page, pendingStamp.imageId, pendingStamp.w, pendingStamp.h, x, y, { signature: true });
        e.preventDefault();
        return;
      } else if (tool === 'pen') {
        drag = { kind: 'pen', pageId, preview: { type: 'pen', points: [[x, y]], color: colorInput.value, lineWidth: +widthInput.value || 2 } };
      } else {
        drag = { kind: 'box', pageId, start: [x, y], preview: null };
      }
      if (drag) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag || drag.pageId !== pageId) {
        if (tool === 'select') updateHoverCursor(canvas, pageId, e);
        else if (tool === 'edittext') updateTextHover(pageId, e);
        return;
      }
      const page = pageById(pageId);
      const [x, y] = pdfPoint(e, pageId);
      if (drag.kind === 'move') {
        const a = page.annots[drag.index];
        const dx = x - drag.start[0], dy = y - drag.start[1];
        if (!drag.saved) { if (Math.hypot(dx, dy) < 2 / zoom) return; checkpoint(); drag.saved = true; }
        if (a.type === 'pen') a.points = drag.orig.points.map(([px, py]) => [px + dx, py + dy]);
        else { a.x = drag.orig.x + dx; a.y = drag.orig.y + dy; }
      } else if (drag.kind === 'resize') {
        if (!drag.saved) { checkpoint(); drag.saved = true; }
        resizeAnnot(page.annots[drag.index], drag.orig, x, y);
      } else if (drag.kind === 'pen') {
        const pts = drag.preview.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 1.5 / zoom) return;
        pts.push([x, y]);
        // Just add the new piece of line (redrawing everything each time is slow).
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.setTransform(...viewportFor(page, zoom * DPR).transform);
        ctx.strokeStyle = drag.preview.color; ctx.lineWidth = drag.preview.lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(x, y); ctx.stroke();
        ctx.restore();
        return;
      } else if (drag.kind === 'box') {
        drag.preview = boxFromDrag(tool, drag.start, [x, y], page.rotation);
      }
      drawOverlay(pageId);
    });

    const finish = () => {
      if (!drag || drag.pageId !== pageId) return;
      const page = pageById(pageId);
      const d = drag;
      drag = null;
      if (d.kind === 'pen') {
        checkpoint();
        page.annots.push(d.preview);
      } else if (d.kind === 'box' && d.preview && d.preview.w > 2 && d.preview.h > 2) {
        checkpoint();
        page.annots.push(d.preview);
      }
      drawOverlay(pageId);
      if (d.saved && page.annots[d.index] && page.annots[d.index].type === 'para') refreshPage(pageId);
      else if (d.saved || d.kind === 'pen' || d.kind === 'box') refreshThumb(pageId);
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    canvas.addEventListener('pointerleave', () => {
      if (hoverChunk && hoverChunk.pageId === pageId) { hoverChunk = null; drawOverlay(pageId); }
    });

    canvas.addEventListener('dblclick', (e) => {
      if (tool !== 'select') return;
      const page = pageById(pageId);
      const [x, y] = pdfPoint(e, pageId);
      const i = hitTest(page, x, y);
      if (i >= 0 && page.annots[i].type === 'para') openParaEditor(pageId, i);
      else if (i >= 0 && isText(page.annots[i])) openTextEditor(pageId, i);
    });
  }

  function updateHoverCursor(canvas, pageId, e) {
    const page = pageById(pageId);
    const [x, y] = pdfPoint(e, pageId);
    const sel = selection && selection.pageId === pageId ? page.annots[selection.index] : null;
    canvas.style.cursor = onHandle(sel, x, y) ? 'nwse-resize' : hitTest(page, x, y) >= 0 ? 'move' : '';
  }

  // Box drawn by dragging; it is aligned with the page as shown on screen.
  function boxFromDrag(kind, [x0, y0], [x1, y1], rot) {
    const [ax, ay] = rotateVec(x0, y0, -rot);
    const [bx, by] = rotateVec(x1, y1, -rot);
    const [ox, oy] = rotateVec(Math.min(ax, bx), Math.min(ay, by), rot);
    return {
      type: kind, x: ox, y: oy, w: Math.abs(bx - ax), h: Math.abs(by - ay), rot,
      color: colorInput.value, lineWidth: +widthInput.value || 2,
    };
  }

  // Drag the bottom-right handle; the top-left corner stays put.
  function resizeAnnot(a, orig, x, y) {
    const [tx, ty] = fromLocal(orig, 0, orig.h);
    let [w, negH] = rotateVec(x - tx, y - ty, -(orig.rot || 0));
    w = Math.max(w, 4);
    let h = Math.max(-negH, 4);
    if (a.type === 'image') h = (w * orig.h) / orig.w;
    if (a.type === 'para') { // a wider or narrower paragraph: the text re-flows
      a.width = Math.max(10, w - orig.dx); a.w = orig.dx + a.width; a.wrap = true;
      return;
    }
    if (isText(a)) {
      a.size = Math.max(4, Math.round(((orig.size * w) / orig.w) * 2) / 2);
      a.x = orig.x; a.y = orig.y; a.h = orig.h;
      layoutText(a);
      return;
    }
    const [dx, dy] = rotateVec(0, -h, orig.rot || 0);
    a.x = tx + dx; a.y = ty + dy; a.w = w; a.h = h;
  }

  // ---------- Text editing ----------
  // index >= 0: edit that annotation; otherwise new text at (x, y), or the
  // given draft (replacing original text, from the Edit text tool).
  function openTextEditor(pageId, index, x, y, draft) {
    closeTextEditor();
    const page = pageById(pageId);
    const existing = index >= 0 ? page.annots[index] : null;
    const a = existing || draft || {
      type: 'text', text: '', size: +sizeInput.value || 14, font: fontInput.value,
      color: colorInput.value, rot: page.rotation, x, y, w: 0, h: null,
    };
    // Top-left corner of the text box, in PDF points.
    const top = existing || draft ? fromLocal(a, 0, a.h) : [x, y];
    const vp = viewportFor(page, zoom);
    const [sx, sy] = vp.convertToViewportPoint(top[0], top[1]);
    // Where the box's top-left lands on screen depends on page vs. text rotation.
    const screenRot = ((page.rotation - (a.rot || 0)) % 360 + 360) % 360;

    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.value = a.text;
    ta.spellcheck = false;
    ta.style.left = sx + 'px';
    ta.style.top = sy + 'px';
    ta.style.transformOrigin = '0 0';
    ta.style.transform = screenRot ? `rotate(${screenRot}deg)` : '';
    ta.style.font = cssFont(a.font, a.size * zoom);
    ta.style.lineHeight = LINE_HEIGHT;
    ta.style.color = a.color;
    if (a.cover) ta.style.background = a.cover.fill; // hide the original words while typing
    const fit = () => {
      const lines = ta.value.split('\n');
      ta.rows = Math.max(1, lines.length);
      ta.style.height = lines.length * a.size * zoom * LINE_HEIGHT + 4 + 'px';
      const w = Math.max(...lines.map((l) => measureFonts[a.font].widthOfTextAtSize(cleanText(l, measureFonts[a.font]), a.size)));
      ta.style.width = Math.max(120, w * zoom + 24) + 'px';
    };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeTextEditor(); }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => closeTextEditor());
    pageEl(pageId).appendChild(ta);
    fit();
    editing = { pageId, index, annot: a, top, el: ta };
    if (existing || draft) drawOverlay(pageId);
    if (draft) ta.select();
    ta.focus();
    setTimeout(() => { if (editing && editing.el === ta) ta.focus(); }, 0);
  }

  function closeTextEditor(commit = true) {
    if (!editing) return;
    const ed = editing;
    editing = null;
    ed.el.remove();
    if (ed.kind === 'para') { closeParaEditor(ed, commit); return; }
    const page = pageById(ed.pageId);
    if (!page) return;
    const text = ed.el.value.replace(/\s+$/, '');
    if (commit) {
      const target = ed.index >= 0 ? page.annots[ed.index] : ed.annot;
      const replacing = target.type === 'replace';
      const original = ed.index >= 0 ? target.text : replacing ? target.orig : '';
      if (text !== original) {
        checkpoint();
        if (!text && ed.index >= 0 && !replacing) {
          page.annots.splice(ed.index, 1);
          selection = null;
        } else if (text || replacing) { // replaced text may become empty: that deletes the original words
          const a = target;
          a.text = text;
          if (ed.index < 0) {
            if (!replacing) { a.h = 0; a.x = ed.top[0]; a.y = ed.top[1]; } // h=0 so the top-left stays at the click point
            page.annots.push(a);
          }
          layoutText(a);
          selection = { pageId: ed.pageId, index: ed.index >= 0 ? ed.index : page.annots.length - 1 };
        }
        refreshThumb(ed.pageId);
      }
    }
    drawOverlay(ed.pageId);
  }

  // ---------- Editing text that is already in the PDF ----------
  // pdf.js reports where each piece of text sits. Pieces on the same line that
  // are close together form one editable "chunk" (a phrase, line or table cell).
  // Editing covers the original words with a patch in the background colour
  // and writes the new words on top in a matching font, size and colour.

  // On recognised (OCR) pages the text comes from the recognised-text layer.
  const chunkKey = (page) => (ocrLayers.has(page.id) ? 'ocr:' + page.id : page.src + ':' + page.srcPage);

  function pageChunks(page) { // the chunks, or null while still loading
    if (page.src == null) return [];
    const key = chunkKey(page);
    const cached = chunkCache.get(key);
    if (Array.isArray(cached)) return cached;
    if (!cached) {
      const layer = ocrLayers.get(page.id);
      chunkCache.set(key, (layer ? loadOcrChunks(page, layer) : loadChunks(page.src, page.srcPage))
        .catch((err) => { console.error(err); return []; })
        .then((list) => { chunkCache.set(key, list); return list; }));
    }
    return null;
  }

  const pageChunksAsync = async (page) => pageChunks(page) || chunkCache.get(chunkKey(page));

  async function loadChunks(srcIndex, n) {
    const tc = await (await getPdfjsPage(sources[srcIndex], n)).getTextContent();
    return groupChunks(textItems(tc));
  }

  async function loadOcrChunks(page, layer) {
    const doc = await pdfjsLib.getDocument({ data: layer.pdf.slice() }).promise;
    try {
      const p = await doc.getPage(1);
      const [, , lw, lh] = p.view;
      const chunks = groupChunks(textItems(await p.getTextContent(), ocrMatrix(page, layer, lw, lh)));
      chunks.forEach((ch) => { ch.ocr = true; });
      return chunks;
    } finally {
      doc.destroy();
    }
  }

  // Text pieces in page coordinates; `m` maps them there when they come from
  // another coordinate system (the recognised-text layer).
  function textItems(tc, m = null) {
    // Work in each piece's own direction: u along the baseline, v across it.
    const items = [];
    const stretch = m ? Math.hypot(m[0], m[1]) : 1;
    for (const it of tc.items) {
      // Skip spaces: pdf.js stretches them across gaps (even between table
      // columns); real word gaps are re-detected from the positions below.
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = m ? mulMatrix(m, it.transform) : it.transform;
      const size = Math.hypot(c, d);
      if (!size) continue;
      const rot = Math.round((Math.atan2(b, a) * 180) / Math.PI * 10) / 10;
      const [u, v] = rotateVec(e, f, -rot);
      items.push({ str: it.str, u, v, w: it.width * stretch, size, rot, fontName: it.fontName, family: (tc.styles[it.fontName] || {}).fontFamily });
    }
    return items;
  }

  function groupChunks(items) {
    // Group into lines, then join neighbours on each line.
    const lines = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l.rot - it.rot) < 1 && Math.abs(l.v - it.v) < Math.min(l.size, it.size) * 0.3);
      if (line) line.items.push(it); else lines.push({ rot: it.rot, v: it.v, size: it.size, items: [it] });
    }
    const chunks = [];
    for (const line of lines) {
      line.items.sort((p, q) => p.u - q.u);
      let cur = null;
      for (const it of line.items) {
        const gap = cur ? it.u - cur.end : 0;
        const ratio = cur ? it.size / cur.size : 1;
        if (cur && gap > -cur.size * 0.5 && gap < cur.size * 1.0 && ratio > 0.75 && ratio < 1.33) {
          if (gap > cur.size * 0.15 && !/\s$/.test(cur.str) && !/^\s/.test(it.str) && !(isCJKChar(cur.str.slice(-1)) && isCJKChar(it.str[0]))) cur.str += ' ';
          cur.str += it.str;
          cur.end = Math.max(cur.end, it.u + it.w);
          cur.size = Math.max(cur.size, it.size);
        } else {
          cur = { str: it.str, u: it.u, v: it.v, end: it.u + it.w, size: it.size, rot: it.rot, fontName: it.fontName, family: it.family };
          chunks.push(cur);
        }
      }
    }
    chunks.forEach((ch) => { ch.str = ch.str.replace(/\s+/g, ' ').trim(); });
    return chunks.filter((ch) => ch.str);
  }

  const isCJKChar = (ch) => !!ch && /[\u2e80-\u2fdf\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch);

  // Corners of a chunk's box in its own direction (u, v), with room for
  // descenders below the baseline and capitals above it.
  const chunkBox = (ch, pad = 0) => ({ u0: ch.u - pad, u1: ch.end + pad, v0: ch.v - ch.size * 0.3, v1: ch.v + ch.size * 0.95 });

  function chunkAt(chunks, x, y) {
    for (const ch of chunks) {
      const [u, v] = rotateVec(x, y, -ch.rot);
      const b = chunkBox(ch, 1);
      if (u >= b.u0 && u <= b.u1 && v >= b.v0 && v <= b.v1) return ch;
    }
    return null;
  }

  function drawChunkOutline(ctx, ch) {
    const px = 1 / (zoom * DPR);
    if (ch.areas) { // a paragraph: outline each of its lines
      ctx.save();
      ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.2 * DPR * px;
      ctx.setLineDash([4 * DPR * px, 3 * DPR * px]);
      for (const r of ch.areas) {
        ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(rad(r.rot || 0));
        ctx.fillRect(0, 0, r.w, r.h); ctx.strokeRect(0, 0, r.w, r.h);
        ctx.restore();
      }
      ctx.restore();
      return;
    }
    const b = chunkBox(ch, 1);
    ctx.save();
    ctx.rotate(rad(ch.rot));
    ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.2 * DPR * px;
    ctx.setLineDash([4 * DPR * px, 3 * DPR * px]);
    ctx.fillRect(b.u0, b.v0, b.u1 - b.u0, b.v1 - b.v0);
    ctx.strokeRect(b.u0, b.v0, b.u1 - b.u0, b.v1 - b.v0);
    ctx.restore();
  }

  function updateTextHover(pageId, e) {
    const page = pageById(pageId);
    const [x, y] = pdfPoint(e, pageId);
    const paras = paragraphsNow(page);
    const para = paras && hitTest(page, x, y) < 0 ? paragraphAt(paras, page, x, y) : null;
    const chunks = para ? null : pageChunks(page);
    const ch = para || (chunks && hitTest(page, x, y) < 0 ? chunkAt(chunks, x, y) : null);
    const prev = hoverChunk;
    if ((prev && prev.chunk) === ch) return;
    hoverChunk = ch ? { pageId, chunk: ch } : null;
    if (prev && prev.pageId !== pageId) drawOverlay(prev.pageId);
    drawOverlay(pageId);
  }

  // Closest built-in font, from the embedded font's name (e.g. "ABCDEF+Arial-BoldItalicMT").
  async function matchFont(page, ch) {
    let name = '', bold = false, italic = false;
    if (ch.ocr) return fontKey('Helvetica', false, false); // the font of a scan can't be known
    try {
      const p = await getPdfjsPage(sources[page.src], page.srcPage);
      if (p.commonObjs.has(ch.fontName)) {
        const f = p.commonObjs.get(ch.fontName);
        name = String(f.name || ''); bold = !!f.bold; italic = !!f.italic;
      }
    } catch { /* font not loaded yet */ }
    bold = bold || /bold|black|heavy|semibold|demi/i.test(name);
    italic = italic || /italic|oblique/i.test(name);
    const sans = /sans|arial|helvet|verdana|tahoma|calibri|segoe|roboto|gothic|frutiger|univers|futura/i.test(name);
    const family = /courier|mono|consol|menlo|typewriter/i.test(name) || ch.family === 'monospace' ? 'Courier'
      : !sans && (/times|serif|georgia|garamond|roman|cambria|minion|book|palatino|baskerville|caslon/i.test(name) || (!name && ch.family === 'serif')) ? 'Times'
      : 'Helvetica';
    return fontKey(family, bold, italic);
  }

  // Background and ink colours of a chunk, read from the rendered page.
  function sampleColors(page, ch) {
    const fallback = { bg: '#ffffff', fg: '#000000' };
    const canvas = pageEl(page.id) && pageEl(page.id).querySelector('canvas.base');
    if (!canvas || !canvas.width) return fallback;
    const vp = viewportFor(page, zoom * DPR);
    const b = chunkBox(ch, 1);
    const pts = [[b.u0, b.v0], [b.u1, b.v0], [b.u0, b.v1], [b.u1, b.v1]]
      .map(([u, v]) => vp.convertToViewportPoint(...rotateVec(u, v, ch.rot)));
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))) - 3);
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))) - 3);
    const x1 = Math.min(canvas.width, Math.ceil(Math.max(...pts.map((p) => p[0]))) + 3);
    const y1 = Math.min(canvas.height, Math.ceil(Math.max(...pts.map((p) => p[1]))) + 3);
    const w = x1 - x0, h = y1 - y0;
    if (w < 3 || h < 3) return fallback;
    const d = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
    const px = (i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    // Background: the most common colour around the edge of the box.
    const counts = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x > 1 && x < w - 2 && y > 1 && y < h - 2) continue;
        const c = px(y * w + x);
        const key = (c[0] >> 3) + ',' + (c[1] >> 3) + ',' + (c[2] >> 3);
        const e = counts.get(key) || { n: 0, sum: [0, 0, 0] };
        e.n++; e.sum = e.sum.map((s, k) => s + c[k]);
        counts.set(key, e);
      }
    }
    const top = [...counts.values()].sort((p, q) => q.n - p.n)[0];
    const bg = top.sum.map((s) => Math.round(s / top.n));
    // Ink: the pixels that differ most from the background.
    let maxDist = 0;
    const dist = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const c = px(i);
      dist[i] = Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
      if (dist[i] > maxDist) maxDist = dist[i];
    }
    const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
    if (maxDist < 40) return { bg: hex(bg), fg: fallback.fg };
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (dist[i] >= maxDist * 0.85) { const c = px(i); sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; n++; }
    }
    return { bg: hex(bg), fg: hex(sum.map((s) => Math.round(s / n))) };
  }

  // On scans, recognised word boxes can be a little smaller than the ink, so
  // widen a chunk's box to the actual ink on the rendered page: move each
  // edge outwards until a clear strip of paper is reached. Returns the box
  // in the chunk's own (u, v) directions, or null if the page isn't drawn.
  // Width of a text in ems of the standard sans font (Chinese characters ≈ 1 em).
  function textEms(str) {
    let ems = 0;
    for (const c of str) {
      if (isCJKChar(c)) { ems += 1; continue; }
      try { ems += measureFonts.Helvetica.widthOfTextAtSize(c, 1); } catch { ems += 0.55; }
    }
    return ems;
  }

  // Recognised text: the height-based size counts the whole line (Chinese
  // characters make it taller). The width of the words is measured exactly,
  // so size the text to fill that width, within reason of the height-based size.
  function ocrSize(ch) {
    const ems = textEms(ch.str);
    return ems > 0 ? Math.max(ch.size * 0.5, Math.min(ch.size * 1.15, (ch.end - ch.u) / ems)) : ch.size;
  }

  // The typical stroke thickness of the text on a recognised page (the
  // median over its longer pieces of text), to spot bold words.
  const strokeCache = new Map();
  async function usualStroke(page, bg, fg) {
    const key = page.id + ':' + page.rotation;
    if (strokeCache.has(key)) return strokeCache.get(key);
    const sharp = await sharpRender(page);
    const sample = (await pageChunksAsync(page)).filter((c) => c.str.length >= 4).sort((a, b) => b.str.length - a.str.length).slice(0, 20);
    const strokes = sample.map((c) => { const box = inkBox(page, { ...c, size: ocrSize(c) }, bg, fg, sharp); return box ? box.stroke : 0; })
      .filter((v) => v > 0).sort((a, b) => a - b);
    const median = strokes.length >= 3 ? strokes[Math.floor(strokes.length / 2)] : 0;
    strokeCache.set(key, median);
    return median;
  }

  // A sharp (300 DPI) picture of the page as shown, for measuring ink. Kept
  // for the last page used, so editing several words there is quick.
  let sharpPage = null; // { key, canvas, scale }
  async function sharpRender(page) {
    const key = page.id + ':' + page.rotation;
    if (sharpPage && sharpPage.key === key) return sharpPage;
    const scale = 300 / 72;
    const canvas = document.createElement('canvas');
    const p = await getPdfjsPage(sources[page.src], page.srcPage);
    const vp = p.getViewport({ scale, rotation: page.rotation });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    sharpPage = { key, canvas, scale };
    return sharpPage;
  }

  function inkBox(page, ch, bg, fg, sharp) {
    const canvas = sharp.canvas;
    const vp = viewportFor(page, sharp.scale);
    const b = chunkBox(ch, 0);
    const corners = [[b.u0, b.v0], [b.u1, b.v0], [b.u0, b.v1], [b.u1, b.v1]].map(([u, v]) => vp.convertToViewportPoint(...rotateVec(u, v, ch.rot)));
    const px = sharp.scale * ch.size; // one em in pixels
    const X0 = Math.min(...corners.map((c) => c[0])), X1 = Math.max(...corners.map((c) => c[0]));
    const Y0 = Math.min(...corners.map((c) => c[1])), Y1 = Math.max(...corners.map((c) => c[1]));
    const left = Math.max(0, Math.floor(X0 - px)), top = Math.max(0, Math.floor(Y0 - px * 0.6));
    const W = Math.min(canvas.width, Math.ceil(X1 + px * 1.6)) - left, H = Math.min(canvas.height, Math.ceil(Y1 + px * 0.6)) - top;
    if (W < 4 || H < 4) return null;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(left, top, W, H).data;
    const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const B = hexRgb(bg), F = hexRgb(fg);
    const limit = Math.max(30, 0.4 * Math.hypot(F[0] - B[0], F[1] - B[1], F[2] - B[2]));
    const mask = new Uint8Array(W * H), faint = new Uint8Array(W * H);
    const faintLimit = Math.max(16, limit * 0.25);
    for (let j = 0, i = 0; j < mask.length; j++, i += 4) {
      const dist = Math.hypot(d[i] - B[0], d[i + 1] - B[1], d[i + 2] - B[2]);
      mask[j] = dist > limit ? 1 : 0;
      faint[j] = dist > faintLimit ? 1 : 0;
    }
    // Table rules and underlines: rows/columns that are mostly ink. They are
    // borders, not part of the words, so the search stops at them. Thin lines
    // on scans are drawn light grey, so they're found with a fainter test.
    const ruleRow = new Uint8Array(H), ruleCol = new Uint8Array(W);
    for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += faint[y * W + x]; ruleRow[y] = n > W * 0.55 ? 1 : 0; }
    for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) n += faint[y * W + x]; ruleCol[x] = n > H * 0.55 ? 1 : 0; }
    let x0 = Math.round(X0 - left), x1 = Math.round(X1 - left), y0 = Math.round(Y0 - top), y1 = Math.round(Y1 - top);
    // 'stop' at a rule; otherwise whether there is text ink in that column/row.
    const colInk = (x) => {
      if (ruleCol[x]) return 'stop';
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) if (!ruleRow[y] && mask[y * W + x]) return true;
      return false;
    };
    const rowInk = (y) => {
      if (ruleRow[y]) return 'stop';
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) if (!ruleCol[x] && mask[y * W + x]) return true;
      return false;
    };
    // Move an edge outwards while ink continues; stop at a rule or at a gap of `gap` pixels.
    const grow = (start, step, end, hasInk, gap) => {
      let last = start, run = 0;
      for (let k = start; k !== end; k += step) {
        const h = hasInk(k);
        if (h === 'stop') break;
        if (h) { last = k; run = 0; } else if (++run >= gap) break;
      }
      return last;
    };
    x1 = grow(x1, 1, Math.min(W, x1 + Math.round(px * 1.5)), colInk, Math.max(2, Math.round(px * 0.3))) + 1;
    x0 = grow(x0, -1, Math.max(-1, x0 - Math.round(px * 0.5)), colInk, Math.max(2, Math.round(px * 0.3)));
    y0 = grow(y0, -1, Math.max(-1, y0 - Math.round(px * 0.5)), rowInk, Math.max(2, Math.round(px * 0.12)));
    y1 = grow(y1, 1, Math.min(H, y1 + Math.round(px * 0.4)), rowInk, Math.max(2, Math.round(px * 0.12))) + 1;
    // The nearest table rules around the text: the patch must stay inside them.
    let rT = -1, rB = H, rL = -1, rR = W;
    for (let y = Math.min(H - 1, y0); y >= 0; y--) if (ruleRow[y]) { rT = y; break; }
    for (let y = Math.max(0, y1); y < H; y++) if (ruleRow[y]) { rB = y; break; }
    for (let x = Math.min(W - 1, x0); x >= 0; x--) if (ruleCol[x]) { rL = x; break; }
    for (let x = Math.max(0, x1); x < W; x++) if (ruleCol[x]) { rR = x; break; }
    // Back to the chunk's own directions.
    const local = (bx0, by0, bx1, by1) => {
      const pts = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]].map(([x, y]) => rotateVec(...vp.convertToPdfPoint(x + left, y + top), -ch.rot));
      return { u0: Math.min(...pts.map((p) => p[0])), u1: Math.max(...pts.map((p) => p[0])), v0: Math.min(...pts.map((p) => p[1])), v1: Math.max(...pts.map((p) => p[1])) };
    };
    const box = local(x0, y0, x1, y1);
    // Stroke thickness relative to the letter size (bold letters have
    // thicker strokes): the typical length of horizontal ink runs.
    let runs = 0, inkPx = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      if (ruleRow[y]) continue;
      for (let x = Math.max(0, x0), on = false; x < Math.min(W, x1); x++) {
        const m = mask[y * W + x] && !ruleCol[x];
        if (m) { inkPx++; if (!on) runs++; }
        on = m;
      }
    }
    box.stroke = runs ? inkPx / runs / px : 0;
    const inner = local(rL + 1.5, rT + 1.5, rR - 0.5, rB - 0.5);
    box.limits = {
      u0: rL >= 0 ? inner.u0 : -Infinity, u1: rR < W ? inner.u1 : Infinity,
      v0: rB < H ? inner.v0 : -Infinity, v1: rT >= 0 ? inner.v1 : Infinity,
    };
    return box;
  }

  async function startTextEdit(pageId, x, y) {
    const page = pageById(pageId);
    if (page.src == null) return status('This page has no original text. Use Add text to write on it.', 4000);
    // Real text: edit the whole paragraph in its own fonts.
    const para = paragraphAt((await pageParagraphs(page)).paragraphs, page, x, y);
    if (para) {
      hoverChunk = null;
      return openParaEditor(pageId, -1, newParaAnnot(page, para));
    }
    const ch = chunkAt(await pageChunksAsync(page), x, y);
    if (!ch) {
      if (isScanned(page)) {
        return status(HAS_OCR
          ? 'This page is scanned (the text is a picture). Click Recognize text first; then you can edit its text.'
          : 'This page is scanned (the text is a picture). Use Whiteout and Add text here; the full PDF Editor can recognize the text.', 6000);
      }
      return status('Click directly on a word or line of text to edit it.', 5000);
    }
    let size = ch.ocr ? ocrSize(ch) : ch.size;
    const { bg, fg } = sampleColors(page, ch);
    // On scans, cover the ink actually there (and size the text to it).
    // (Searched with the width-based size: the height-based one can be too
    // big on lines with Chinese, and would reach into the row above.)
    const ink = ch.ocr ? inkBox(page, { ...ch, size }, bg, fg, await sharpRender(page)) : null;
    let bold = false;
    if (ink) {
      const ems = textEms(ch.str);
      if (ems > 0) size = Math.max(size * 0.85, Math.min(size * 1.25, (ink.u1 - Math.min(ink.u0, ch.u)) / ems));
      // Bold: strokes clearly thicker than is usual on this page.
      const usual = await usualStroke(page, bg, fg);
      bold = usual > 0 && ink.stroke > usual * 1.25;
    }
    size = Math.round(size * 10) / 10;
    const pad = 0.6 + size * 0.04;
    const box = ink
      ? { u0: Math.min(ink.u0, ch.u) - pad, u1: Math.max(ink.u1, ch.end) + pad, v0: Math.min(ink.v0, ch.v - size * 0.3) - pad, v1: Math.max(ink.v1, ch.v + size) + pad }
      : { u0: ch.u - pad, u1: ch.end + pad, v0: ch.v - size * 0.3, v1: ch.v + size };
    if (ink) { // stay inside the table cell's lines
      const L = ink.limits;
      box.u0 = Math.max(box.u0, L.u0); box.u1 = Math.min(box.u1, L.u1);
      box.v0 = Math.max(box.v0, L.v0); box.v1 = Math.min(box.v1, L.v1);
    }
    const [cx, cy] = rotateVec(box.u0, box.v0, ch.rot);
    // The text box is placed so its first baseline sits on the original one.
    const [tx, ty] = rotateVec(ch.u, ch.v - size * 0.25, ch.rot);
    const draft = {
      type: 'replace', text: ch.str, font: ch.ocr ? fontKey('Helvetica', bold, false) : await matchFont(page, ch), size, color: fg, rot: ch.rot,
      x: tx, y: ty, w: 0, h: size * LINE_HEIGHT,
      cover: { x: cx, y: cy, w: box.u1 - box.u0, h: box.v1 - box.v0, rot: ch.rot, fill: bg },
    };
    layoutText(draft, false);
    draft.orig = draft.text; // unchanged text means nothing to save
    if (draft.text !== ch.str) status('Some characters here aren\'t in the built-in fonts and show as "?".', 5000);
    hoverChunk = null;
    openTextEditor(pageId, -1, 0, 0, draft);
  }

  // ---------- Editing paragraphs in the PDF's own fonts ----------
  // Clicking text with Edit text opens its whole paragraph. The new text
  // re-flows inside the paragraph's width and is written with the same
  // fonts, sizes and colours as the original (PdfText does the reading and
  // writing). Pages with edited paragraphs are shown from the edited file,
  // so what you see is what gets saved.

  // Look-alike fonts for letters a PDF's font doesn't contain.
  const FALLBACK_FILES = {
    sans: 'LiberationSans', serif: 'LiberationSerif', mono: 'LiberationMono', calibri: 'Carlito', cambria: 'Caladea',
  };
  const FALLBACK_CSS = {
    sans: '"PE Sans", Arial, Helvetica', serif: '"PE Serif", "Times New Roman", Times', mono: '"PE Mono", "Courier New", Courier',
    calibri: '"PE Calibri", Calibri, Carlito', cambria: '"PE Cambria", Cambria, Caladea',
  };
  const CJK_CSS = '"PE CJK", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
  function fallbackFamily(style) {
    const n = style.baseFont || '';
    if (/calibri|carlito/i.test(n)) return 'calibri';
    if (/cambria|caladea/i.test(n)) return 'cambria';
    if (style.mono) return 'mono';
    if (style.serif) return 'serif';
    return 'sans';
  }
  const variantOf = (style) => (style.bold && style.italic ? 'BoldItalic' : style.bold ? 'Bold' : style.italic ? 'Italic' : 'Regular');
  const styleSize = (st) => Math.hypot(st.m[2], st.m[3]);
  function cssColor(fill) {
    const v = (fill && fill.v) || [];
    const to = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
    if (fill && fill.op === 'g') return `rgb(${to(v[0])},${to(v[0])},${to(v[0])})`;
    if (fill && fill.op === 'rg') return `rgb(${to(v[0])},${to(v[1])},${to(v[2])})`;
    if (fill && fill.op === 'k') return `rgb(${to((1 - v[0]) * (1 - v[3]))},${to((1 - v[1]) * (1 - v[3]))},${to((1 - v[2]) * (1 - v[3]))})`;
    return '#000';
  }

  // Font files are loaded once, when first needed.
  const fontFiles = new Map(); // file -> Promise<Uint8Array|null>
  function fontFile(file) {
    if (!fontFiles.has(file)) {
      fontFiles.set(file, fetch('vendor/fonts/' + file)
        .then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null))
        .catch(() => null)); // e.g. opened straight from disk: the standard fonts are used instead
    }
    return fontFiles.get(file);
  }

  // Embeds the look-alike fonts a paragraph needs into `doc`, and returns the
  // functions PdfText.writeParagraph uses to write letters in them.
  async function fallbacksFor(doc, page, a, cache) {
    const wanted = new Set();
    PdfText.shape(doc, page, a, a.runs, (style, ch) => {
      const key = fallbackFamily(style) + '-' + variantOf(style);
      wanted.add(key);
      if (ch.codePointAt(0) > 0x24f) wanted.add('cjk');
      return { key, encode: () => ({ bytes: '\0', w: 0.5 }) };
    });
    for (const key of wanted) {
      if (cache.has(key)) continue;
      const file = key === 'cjk' ? 'NotoSansSC-Regular.ttf' : `${FALLBACK_FILES[key.split('-')[0]]}-${key.split('-')[1]}.ttf`;
      const bytes = await fontFile(file);
      let font = null;
      if (bytes && window.fontkit) {
        try {
          if (!doc._peFontkit) { doc.registerFontkit(window.fontkit); doc._peFontkit = true; }
          font = await doc.embedFont(bytes, { subset: true });
        } catch (err) { console.warn('Could not use font', file, err); }
      }
      if (!font && key !== 'cjk') { // no font files (opened from disk): the closest standard font
        const [fam, variant] = key.split('-');
        const family = fam === 'mono' ? 'Courier' : fam === 'serif' || fam === 'cambria' ? 'Times' : 'Helvetica';
        font = doc.embedStandardFont(StandardFonts[fontKey(family, /Bold/.test(variant), /Italic/.test(variant))]);
      }
      cache.set(key, font);
    }
    const has = (font, ch) => {
      if (!font) return false;
      const fk = font.embedder && font.embedder.font;
      if (fk && fk.hasGlyphForCodePoint) return fk.hasGlyphForCodePoint(ch.codePointAt(0));
      try { font.encodeText(ch); return true; } catch { return false; }
    };
    const encoder = (font) => (ch) => {
      const hex = font.encodeText(ch).toString().slice(1, -1);
      let bytes = '';
      for (let i = 0; i < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      return { bytes, w: font.widthOfTextAtSize(ch, 1) };
    };
    return {
      pick(style, ch) {
        const key = fallbackFamily(style) + '-' + variantOf(style);
        for (const k of [key, 'cjk']) if (has(cache.get(k), ch)) return { key: k, encode: encoder(cache.get(k)) };
        return null; // no font has this letter: it is left out
      },
      resource: (key) => cache.get(key).ref,
    };
  }

  // Where an edited paragraph's first line starts (page coordinates).
  const paraOrigin = (a) => fromLocal(a, a.dx, a.h - a.asc);

  // Writes the page's edited paragraphs (called while building the PDF).
  async function writeParagraphs(doc, p, page) {
    const cache = new Map();
    for (const a of page.annots) {
      if (a.type !== 'para' || !a.runs.length) continue;
      try {
        const fb = await fallbacksFor(doc, p, a, cache);
        const [x, y] = paraOrigin(a);
        const res = PdfText.writeParagraph(doc, p, { ...a, x, y }, fb.pick, fb.resource);
        a.laid = { lines: res.lines, width: res.width, fallback: res.usedFallback };
      } catch (err) {
        console.error('Could not write the edited paragraph', err);
      }
    }
  }

  // The box of an edited paragraph follows its laid-out text (top stays put).
  function fitParaBox(a) {
    if (!a.laid) return false;
    const lines = Math.max(1, a.laid.lines);
    const h = a.asc + (lines - 1) * a.lineGap + a.desc;
    const w = a.wrap ? a.dx + a.width : Math.max(a.dx + a.laid.width, 8);
    if (Math.abs(h - a.h) < 0.01 && Math.abs(w - a.w) < 0.01) return false;
    const [tx, ty] = fromLocal(a, 0, a.h);
    const [dx, dy] = rotateVec(0, -h, a.rot);
    a.x = tx + dx; a.y = ty + dy; a.h = h; a.w = w;
    return true;
  }

  // Pages with edited paragraphs are drawn from a preview of the edited page.
  const previews = new Map(); // page id -> { key, page: Promise<pdf.js page>, doc }
  const hasParas = (page) => page.annots.some((a) => a.type === 'para');
  function previewPage(page) {
    const key = JSON.stringify([page.srcPage, page.annots.filter((a) => a.type === 'para').map((a) => [a.runs, a.styles.length, a.x, a.y, a.rot, a.width, a.wrap, a.align])]);
    const old = previews.get(page.id);
    if (old && old.key === key) return old.page;
    const entry = { key, doc: null };
    entry.page = (async () => {
      const bytes = await buildPdf({ list: [page], textOnly: true });
      entry.doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      return entry.doc.getPage(1);
    })();
    previews.set(page.id, entry);
    if (old) old.page.then(() => old.doc && old.doc.destroy()).catch(() => {});
    return entry.page;
  }

  // Redraw a page (and its thumbnail) after its paragraphs changed.
  async function refreshPage(pageId) {
    const page = pageById(pageId);
    const el = pageEl(pageId);
    if (!page || !el) return;
    await renderBase(el, true);
    if (page.annots.some((a) => a.type === 'para' && fitParaBox(a))) { /* box follows the text */ }
    drawOverlay(pageId);
    refreshThumb(pageId);
  }

  // Paragraphs of an original page (cached).
  const paraCache = new Map(); // "src:page" -> Promise<{ paragraphs }>
  function pageParagraphs(page) {
    if (page.src == null || ocrLayers.has(page.id)) return Promise.resolve({ paragraphs: [] });
    const key = page.src + ':' + page.srcPage;
    if (!paraCache.has(key)) {
      paraCache.set(key, (async () => {
        const src = sources[page.src];
        if (!src.lib) src.lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
        return PdfText.paragraphs(src.lib, src.lib.getPage(page.srcPage));
      })().catch((err) => { console.warn('Paragraphs not readable', err); return { paragraphs: [] }; }));
    }
    return paraCache.get(key);
  }
  const paraSync = new Map(); // same, once loaded (for hovering)
  function paragraphsNow(page) {
    if (page.src == null || ocrLayers.has(page.id)) return [];
    const key = page.src + ':' + page.srcPage;
    if (paraSync.has(key)) return paraSync.get(key);
    pageParagraphs(page).then((r) => { paraSync.set(key, r.paragraphs); });
    return null;
  }
  const paraKey = (d) => d.areas.map((r) => `${r.x.toFixed(1)},${r.y.toFixed(1)}`).join(';');
  function paragraphAt(list, page, x, y) {
    const edited = new Set(page.annots.filter((a) => a.type === 'para').map((a) => a.key));
    for (const d of list) {
      if (edited.has(paraKey(d))) continue;
      if (d.areas.some((r) => inBox(r, x, y, 1))) return d;
    }
    return null;
  }

  // A new edited-paragraph item from a paragraph found on the page.
  function newParaAnnot(page, d) {
    const asc = d.size * 0.95, desc = d.size * 0.3;
    const left = Math.min(d.u0, d.u0 + d.indent);
    const dx = d.u0 - left;
    const h = asc + (d.lines - 1) * d.lineGap + desc;
    const [x, y] = rotateVec(left, d.vBottom - desc, d.rot);
    const { bg } = sampleColors(page, { u: left, end: left + d.width + dx, v: d.vBottom, size: d.size, rot: d.rot });
    return {
      type: 'para', key: paraKey(d), x, y, w: dx + d.width, h, rot: d.rot, dx, asc, desc,
      align: d.align, width: d.width, wrap: d.lines > 1, lineGap: d.lineGap, indent: d.indent, lines: d.lines,
      styles: d.styles, runs: d.runs, origRuns: JSON.stringify(d.runs), areas: d.areas, bg,
    };
  }

  // The paragraph editor: an editable box showing the text in look-alike
  // fonts (with each run's size, colour, bold and italic) over the original.
  function openParaEditor(pageId, index, draft) {
    closeTextEditor();
    const page = pageById(pageId);
    const a = index >= 0 ? page.annots[index] : draft;
    const vp = viewportFor(page, zoom);
    const [bx, by] = fromLocal(a, 0, a.h);
    const [sx, sy] = vp.convertToViewportPoint(bx, by);
    const screenRot = ((page.rotation - (a.rot || 0)) % 360 + 360) % 360;
    const size0 = styleSize(a.styles[a.runs.length ? a.runs[0].s : 0] || a.styles[0]);
    const lineGap = a.lines > 1 || a.wrap ? a.lineGap : size0 * 1.2;
    const div = document.createElement('div');
    div.className = 'para-editor';
    div.contentEditable = 'true';
    div.spellcheck = true;
    Object.assign(div.style, {
      left: sx + 'px', transformOrigin: '0 0', transform: screenRot ? `rotate(${screenRot}deg)` : '',
      lineHeight: lineGap * zoom + 'px', textAlign: a.align, background: a.bg || '#fff',
      paddingLeft: a.dx * zoom + 'px', textIndent: (a.indent || 0) * zoom + 'px',
      whiteSpace: a.wrap ? 'pre-wrap' : 'pre',
    });
    if (a.wrap) div.style.width = (a.dx + a.width) * zoom + 'px';
    else div.style.minWidth = a.w * zoom + 'px';
    // The first baseline sits on the original one: line box top + half the
    // extra line spacing + the font's ascent (about 0.9 em).
    div.style.top = sy + (a.asc - (lineGap - size0 * 1.15) / 2 - size0 * 0.92) * zoom + 'px';
    const styleCss = (st) => {
      const fam = fallbackFamily(st);
      return `font-family:${FALLBACK_CSS[fam]}, ${CJK_CSS};font-size:${styleSize(st) * zoom}px;color:${cssColor(st.fill)};`
        + `font-weight:${st.bold ? 700 : 400};font-style:${st.italic ? 'italic' : 'normal'}`;
    };
    for (const run of a.runs) {
      const span = document.createElement('span');
      span.dataset.s = run.s;
      span.style.cssText = styleCss(a.styles[run.s]);
      span.textContent = run.text;
      div.appendChild(span);
    }
    div.dataset.s0 = a.runs.length ? a.runs[0].s : 0;
    div.style.cssText += ';' + styleCss(a.styles[+div.dataset.s0]).replace(/color:[^;]*;/, '');
    div.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeTextEditor(); return; }
      if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
    });
    div.addEventListener('paste', (e) => { // plain text only
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n'));
    });
    div.addEventListener('blur', () => closeTextEditor());
    pageEl(pageId).appendChild(div);
    editing = { kind: 'para', pageId, index, annot: a, el: div };
    // Select all the text, ready to type over or edit.
    const range = document.createRange();
    range.selectNodeContents(div);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    div.focus();
    setTimeout(() => { if (editing && editing.el === div) div.focus(); }, 0);
    drawOverlay(pageId);
  }

  // Styled runs typed in the editor.
  function readRuns(div) {
    const runs = [];
    const push = (text, s) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && last.s === s) last.text += text; else runs.push({ s, text });
    };
    const walk = (node, s) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) push(child.data.replace(/ /g, ' '), s);
        else if (child.nodeName === 'BR') push('\n', s);
        else if (child.nodeType === 1) {
          const cs = child.dataset && child.dataset.s != null ? +child.dataset.s : s;
          if ((child.nodeName === 'DIV' || child.nodeName === 'P') && runs.length) push('\n', cs);
          walk(child, cs);
        }
      }
    };
    walk(div, +div.dataset.s0 || 0);
    // No trailing line breaks or spaces.
    while (runs.length) {
      const last = runs[runs.length - 1];
      last.text = last.text.replace(/[\s\n]+$/, '');
      if (last.text) break;
      runs.pop();
    }
    return runs;
  }

  function closeParaEditor(ed, commit) {
    const page = pageById(ed.pageId);
    if (!page) return;
    if (!commit) { drawOverlay(ed.pageId); return; }
    const runs = readRuns(ed.el);
    const a = ed.annot;
    if (JSON.stringify(runs) === JSON.stringify(a.runs) && ed.index >= 0) { drawOverlay(ed.pageId); return; }
    if (ed.index < 0 && JSON.stringify(runs) === a.origRuns) { drawOverlay(ed.pageId); return; }
    checkpoint();
    a.runs = runs;
    // Until the preview is laid out, estimate the lines from the editor.
    const shown = ed.el.getBoundingClientRect();
    const est = Math.max(1, Math.round((ed.el.scrollHeight || shown.height) / (parseFloat(ed.el.style.lineHeight) || 1)));
    a.laid = { lines: est, width: a.w - a.dx };
    fitParaBox(a);
    if (ed.index < 0) page.annots.push(a);
    selection = null;
    refreshPage(ed.pageId).then(() => {
      const notes = [];
      if (a.laid && a.laid.lines > a.lines) notes.push('The paragraph is now longer than before and may run into the text below: shorten it, or select it and drag its corner handle to make it wider.');
      if (a.laid && a.laid.fallback) notes.push('Some letters aren\'t in the PDF\'s font, so a look-alike font was used for them.');
      if (notes.length) status(notes.join(' '), 8000);
    });
  }

  // ---------- Images ----------
  async function addImage(file) {
    if (!file) return;
    if (!pages.length) newBlankDocument();
    const bytes = await readFile(file);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) return status('Please choose a PNG or JPG image');
    const id = await registerImage(bytes, isPng ? 'png' : 'jpg');
    const el = images.get(id).el;
    const page = pageById(currentPageId) || pages[0];
    const v = page.view;
    const pw = v[2] - v[0], ph = v[3] - v[1];
    const scale = Math.min(1, (pw * 0.5) / el.naturalWidth, (ph * 0.5) / el.naturalHeight);
    placeImage(page, id, el.naturalWidth * scale, el.naturalHeight * scale, v[0] + pw / 2, v[1] + ph / 2);
  }

  async function registerImage(bytes, kind) {
    const id = 'img' + nextId++;
    const el = new Image();
    el.src = URL.createObjectURL(new Blob([bytes], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }));
    await el.decode();
    images.set(id, { bytes, kind, el });
    return id;
  }

  // Put an image centred on (cx, cy), upright as the page is displayed.
  function placeImage(page, imageId, w, h, cx, cy, extra = {}) {
    const [ox, oy] = rotateVec(-w / 2, -h / 2, page.rotation);
    checkpoint();
    page.annots.push({ type: 'image', imageId, x: cx + ox, y: cy + oy, w, h, rot: page.rotation, ...extra });
    setTool('select');
    select(page.id, page.annots.length - 1);
    refreshThumb(page.id);
  }

  // ---------- Signatures ----------
  async function startSignature() {
    if (!pages.length) return status('Open a PDF first.');
    closeTextEditor();
    const url = await PdfSignature.choose();
    if (!url) return;
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const imageId = await registerImage(bytes, 'png');
    const el = images.get(imageId).el;
    // About 6 cm wide, but never taller than about 2.5 cm.
    let w = 170, h = (w * el.naturalHeight) / el.naturalWidth;
    if (h > 70) { h = 70; w = (h * el.naturalWidth) / el.naturalHeight; }
    setTool('stamp');
    pendingStamp = { imageId, w, h };
    status('Click on the page where the signature should go (Esc to cancel). You can move and resize it afterwards.', 8000);
  }

  // ---------- Property changes apply to the selected item ----------
  function applyProp(fn) {
    if (!selection) return;
    const a = pageById(selection.pageId).annots[selection.index];
    if (!a) return;
    checkpoint();
    fn(a);
    drawOverlay(selection.pageId);
    if (a.type === 'para') refreshPage(selection.pageId); else refreshThumb(selection.pageId);
  }

  colorInput.addEventListener('change', () => applyProp((a) => { if (a.color) a.color = colorInput.value; }));
  sizeInput.addEventListener('change', () => applyProp((a) => { if (isText(a)) { a.size = Math.max(4, +sizeInput.value || 14); layoutText(a); } }));
  fontInput.addEventListener('change', () => applyProp((a) => { if (isText(a)) { a.font = fontInput.value; layoutText(a); } }));
  widthInput.addEventListener('change', () => applyProp((a) => { if ('lineWidth' in a) a.lineWidth = Math.max(0.5, +widthInput.value || 2); }));

  // One click: put a faint diagonal "DRAFT" across the middle of every page.
  // Clicking again when every page already has one removes them.
  // Clicking again with the same text removes it; with different text, replaces it.
  function toggleWatermark() {
    if (!pages.length) return;
    closeTextEditor();
    const text = watermarkInput.value.trim() || WATERMARK.text;
    const has = (p) => p.annots.some((a) => a.watermark && a.wmText === text);
    checkpoint();
    selection = null;
    const removing = pages.every(has);
    pages.forEach((p) => { p.annots = p.annots.filter((a) => !a.watermark); });
    if (removing) {
      renderAll();
      return status('Watermark removed');
    }
    let unsupported = false;
    for (const page of pages) {
      const a = {
        type: 'text', watermark: true, wmText: text, text, size: WATERMARK.size, font: WATERMARK.font,
        color: WATERMARK.color, opacity: WATERMARK.opacity, rot: page.rotation + WATERMARK.angle, x: 0, y: 0,
      };
      layoutText(a, false);
      if (a.text !== text) unsupported = true;
      // Long text: shrink below 150 pt so the diagonal still fits on the page.
      const v = page.view;
      const room = 0.9 * Math.min(v[2] - v[0], v[3] - v[1]) * Math.SQRT2;
      if (a.w + a.h > room) {
        a.size = Math.max(10, Math.floor((a.size * room) / (a.w + a.h)));
        layoutText(a, false);
      }
      // Center the rotated text box on the page.
      const [dx, dy] = rotateVec(a.w / 2, a.h / 2, a.rot);
      a.x = (v[0] + v[2]) / 2 - dx;
      a.y = (v[1] + v[3]) / 2 - dy;
      page.annots.unshift(a); // underneath other edits, so it doesn't get in the way of selecting them
    }
    renderAll();
    status(unsupported
      ? 'Watermark added. Some characters are not supported by the built-in fonts and show as "?"'
      : `Watermark "${text}" added to every page`, unsupported ? 6000 : 2500);
  }

  function deleteSelection() {
    if (!selection) return;
    checkpoint();
    const [removed] = pageById(selection.pageId).annots.splice(selection.index, 1);
    const id = selection.pageId;
    selection = null;
    drawOverlay(id);
    if (removed && removed.type === 'para') refreshPage(id); else refreshThumb(id);
  }

  function nudgeSelection(dx, dy) {
    applyProp((a) => {
      if (a.type === 'pen') a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
      else { a.x += dx; a.y += dy; }
    });
  }

  // ---------- Saving ----------
  // `list` picks which pages to include (default: all, in order).
  // textOnly: only the deleted and edited text (for previews of edited pages).
  async function buildPdf({ skipWatermarks = false, list = pages, textOnly = false } = {}) {
    if (!textOnly) closeTextEditor();
    const out = await PDFDocument.create();
    // Copy each source's pages in one go so shared fonts/images are copied once.
    const copied = new Map(); // "src:page" -> PDFPage
    for (let s = 0; s < sources.length; s++) {
      const wanted = [...new Set(list.filter((p) => p.src === s).map((p) => p.srcPage))];
      if (!wanted.length) continue;
      const src = sources[s];
      if (!src.lib) src.lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
      const result = await out.copyPages(src.lib, wanted);
      wanted.forEach((n, k) => copied.set(s + ':' + n, result[k]));
    }

    const fonts = {};
    const getFont = async (name) => (fonts[name] ||= await out.embedFont(StandardFonts[name]));
    const embedded = {};
    const getImage = async (id) => {
      if (!embedded[id]) {
        const img = images.get(id);
        embedded[id] = img.kind === 'png' ? await out.embedPng(img.bytes) : await out.embedJpg(img.bytes);
      }
      return embedded[id];
    };

    for (const page of list) {
      let p;
      if (page.src == null) {
        p = out.addPage([page.view[2] - page.view[0], page.view[3] - page.view[1]]);
      } else {
        p = out.addPage(copied.get(page.src + ':' + page.srcPage));
      }
      p.setRotation(degrees(page.rotation));
      // Text replaced with Edit text or under a Whiteout box is deleted from
      // the page itself, so it can't be found or copied in the saved file.
      const removal = new Map(); // edit -> { removed, unsure, invisible }
      const targets = page.src == null ? [] : page.annots.filter((a) => (a.type === 'replace' && a.cover) || a.type === 'whiteout' || a.type === 'para');
      if (targets.length) {
        try {
          const res = PdfText.removeText(out, p, targets.map((a) => {
            const boxes = a.type === 'para' ? a.areas : [a.type === 'whiteout' ? a : a.cover];
            return (x, y) => boxes.some((box) => inBox(box, x, y, 0));
          }));
          targets.forEach((a, k) => removal.set(a, res[k]));
        } catch (err) {
          console.warn('Could not remove the original text', err);
        }
      }
      if (hasParas(page)) {
        await writeParagraphs(out, p, page);
        // Whiteout always wins: edited text under a white box is deleted too.
        const boxes = page.annots.filter((a) => a.type === 'whiteout');
        if (boxes.length) {
          try { PdfText.removeText(out, p, boxes.map((box) => (x, y) => inBox(box, x, y, 0))); } catch (err) { console.warn(err); }
        }
      }
      if (textOnly) continue;
      const layer = ocrLayers.get(page.id);
      if (layer) await addTextLayer(out, p, page, layer);

      for (const a of page.annots) {
        if (skipWatermarks && a.watermark) continue;
        const color = a.color ? rgb(...hexToRgb(a.color)) : undefined;
        const rotate = degrees(a.rot || 0);
        // The patch is only needed where the old words couldn't all be
        // deleted (scans, unusual fonts, hidden text over drawn letters).
        const gone = removal.get(a);
        if (a.cover && !(gone && gone.removed && !gone.unsure && !gone.invisible)) {
          const c = a.cover;
          p.drawRectangle({ x: c.x, y: c.y, width: c.w, height: c.h, rotate: degrees(c.rot || 0), color: rgb(...hexToRgb(c.fill)) });
        }
        if (isText(a)) {
          const font = await getFont(a.font);
          a.text.split('\n').forEach((line, i) => {
            if (!line) return;
            const [x, y] = fromLocal(a, 0, baselineY(a, i));
            p.drawText(line, { x, y, size: a.size, font, color, rotate, opacity: a.opacity ?? 1 });
          });
        } else if (a.type === 'pen') {
          const pts = a.points.length === 1 ? [a.points[0], [a.points[0][0] + 0.01, a.points[0][1]]] : a.points;
          for (let k = 0; k < pts.length - 1; k++) {
            p.drawLine({
              start: { x: pts[k][0], y: pts[k][1] }, end: { x: pts[k + 1][0], y: pts[k + 1][1] },
              thickness: a.lineWidth, color, lineCap: LineCapStyle.Round,
            });
          }
        } else if (a.type === 'image') {
          p.drawImage(await getImage(a.imageId), { x: a.x, y: a.y, width: a.w, height: a.h, rotate });
        } else if (a.type === 'highlight') {
          p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate, color, opacity: 0.35, blendMode: BlendMode.Multiply });
        } else if (a.type === 'whiteout') {
          p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate, color: rgb(1, 1, 1) });
        } else if (a.type === 'rect') {
          p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate, borderColor: color, borderWidth: a.lineWidth });
        }
      }
    }
    return out.save();
  }

  const mulMatrix = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const applyMatrix = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // Maps the recognised-text layer (lw × lh units) onto the page: scale it to
  // the page as shown, tilt it back by the straightening angle around the
  // centre, then turn "as shown" into the page's own coordinates.
  function ocrMatrix(page, layer, lw, lh) {
    const [x0, y0, x1, y1] = page.view;
    const W = x1 - x0, H = y1 - y0, R = layer.rotation;
    const dw = R % 180 ? H : W, dh = R % 180 ? W : H; // size as shown
    const toPage = { 0: [1, 0, 0, 1, x0, y0], 90: [0, 1, -1, 0, x0 + W, y0], 180: [-1, 0, 0, -1, x0 + W, y0 + H], 270: [0, -1, 1, 0, x0, y0 + H] }[R];
    const a = (-(layer.tilt || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); // undo the straightening
    const tiltBack = mulMatrix(mulMatrix([1, 0, 0, 1, dw / 2, dh / 2], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -dw / 2, -dh / 2]);
    return mulMatrix(mulMatrix(toPage, tiltBack), [dw / lw, 0, 0, dh / lh, 0, 0]);
  }

  // Place a recognised-text layer back onto the page. The layer was made for
  // the page as it was shown (rotated by layer.rotation) and straightened by
  // layer.tilt degrees, so: scale it to the page, tilt it back around the
  // centre, then turn it from "as shown" into the page's own coordinates.
  async function addTextLayer(out, p, page, layer) {
    const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
    // Words hidden under a Whiteout box or replaced with Edit text are taken
    // out of the layer, so searching the saved PDF doesn't find the old words.
    const covers = page.annots.map((a) => (a.type === 'whiteout' ? a : a.cover)).filter(Boolean);
    const pdf = covers.length
      ? await PdfOcr.removeWords(layer.pdf, (x, y, lw, lh) => {
        const [px, py] = applyMatrix(ocrMatrix(page, layer, lw, lh), x, y);
        return covers.some((c) => inBox(c, px, py, 0));
      })
      : layer.pdf;
    const emb = (await out.embedPdf(pdf, [0]))[0];
    const m = ocrMatrix(page, layer, emb.width, emb.height);
    const name = p.node.newXObject('OcrText', emb.ref); // pdf-lib writes the layer into the file when saving
    p.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(name), popGraphicsState());
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  const baseName = () => fileName.replace(/\.pdf$/i, '');
  // The desktop app asks where to save; the browser downloads straight away.
  const DONE = window.desktop ? 'Ready to save' : 'Downloaded';

  // Lock the file if a password is set.
  const protect = async (bytes) => (savePassword ? PdfSecurity.encrypt(bytes, savePassword) : bytes);

  async function save() {
    if (!pages.length) return;
    status('Building PDF…', 30000);
    try {
      const bytes = await protect(await buildPdf());
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), baseName() + '-edited.pdf');
      if (!window.desktop) dirty = false;
      status(DONE + ' ' + baseName() + '-edited.pdf' + (savePassword ? ' (password protected)' : ''));
    } catch (err) {
      console.error(err);
      status('Could not save: ' + (err.message || err), 6000);
    }
  }

  // ---------- Convert to Word / Excel / OpenDocument ----------
  // Only possible when the PDF has real text. Scanned PDFs (pictures of
  // text) and documents made only of blank pages have none.
  // A page needs OCR when it comes from a PDF but has no real text (a scan)
  // and hasn't been recognised yet.
  const isScanned = (p) => p.src != null && sources[p.src].textChecked && !sources[p.src].textPages.has(p.srcPage) && !ocrLayers.has(p.id);
  const hasText = () => pages.some((p) => (p.src != null && (sources[p.src].textPages.has(p.srcPage) || !sources[p.src].textChecked)) || ocrLayers.has(p.id));
  const needsOcr = (p) => HAS_OCR && isScanned(p);
  const NO_TEXT = HAS_OCR
    ? 'Converting needs a PDF with text. This one has none: if it is scanned, click Recognize text first.'
    : 'Converting needs a PDF with text. This one has none (it may be scanned): PDF Editor Lite can\'t read scanned pages; the full PDF Editor can.';

  function updateConvertButton() {
    const btn = $('convertBtn');
    const scanned = pages.filter(needsOcr).length;
    btn.disabled = !hasText() && !scanned;
    btn.title = !pages.length || hasText() || scanned ? 'Convert to Word, Excel or OpenDocument' : NO_TEXT;
    const ocr = $('ocrBtn');
    ocr.style.display = HAS_OCR ? '' : 'none';
    ocr.disabled = !scanned;
    ocr.textContent = scanned || !pages.some((p) => ocrLayers.has(p.id)) ? 'Recognize text' : '✓ Text recognized';
    ocr.classList.toggle('attention', scanned > 0 && !hasText());
  }

  function openConvertDialog() {
    if (!pages.length) return;
    // Scanned pages are recognised first, then the Convert dialog opens.
    if (pages.some(needsOcr)) return openOcrDialog(openConvertDialog, 'This PDF is scanned, so its text needs to be recognized before converting.');
    if (!hasText()) return status(NO_TEXT, 6000);
    closeTextEditor();
    $('convertError').textContent = '';
    $('convertDialog').showModal();
  }

  function syncConvertDialog() {
    const format = $('convertDialog').querySelector('input[name=convertFormat]:checked').value;
    $('convertImagesRow').hidden = !(format === 'docx' || format === 'odt');
  }

  async function runConvert() {
    const dlg = $('convertDialog');
    const format = dlg.querySelector('input[name=convertFormat]:checked').value;
    let list = pages;
    try {
      if (dlg.querySelector('input[name=convertPages]:checked').value === 'some') {
        list = parseRanges($('convertRanges').value, pages.length).map((i) => pages[i]);
      }
    } catch (err) {
      $('convertError').textContent = err.message;
      return;
    }
    dlg.close();
    await convertTo(format, list, $('convertImages').checked);
  }

  // Converts the document as edited: added text is included; watermarks and
  // text hidden under Whiteout or an edit patch are left out.
  async function convertTo(format, list = pages, images = true) {
    if (!hasText()) return status(NO_TEXT, 6000);
    status('Converting…', 120000);
    try {
      const bytes = await buildPdf({ skipWatermarks: true, list });
      const hidden = (i, x, y, str) => {
        const annots = list[i].annots;
        const covered = annots.some((a) => {
          const box = a.type === 'whiteout' ? a : a.cover;
          return box ? inBox(box, x, y, 0) : false;
        });
        if (!covered) return false;
        const piece = str.trim();
        return !annots.some((t) => isText(t) && !t.watermark && t.text && t.text.includes(piece) && inBox(t, x, y, t.size * 0.5));
      };
      const blob = await PdfConvert.convert(bytes, {
        format, images, skip: hidden,
        onProgress: (done, total) => status(done < total ? `Converting page ${done + 1} of ${total}…` : 'Writing the file…', 120000),
      });
      const name = baseName() + '.' + format;
      downloadBlob(blob, name);
      status(DONE + ' ' + name, 4000);
    } catch (err) {
      console.error(err);
      status(err.code === 'no-text' ? NO_TEXT : 'Could not convert: ' + (err.message || err), 6000);
    }
  }

  // Kept for scripts and tests: convert all pages straight away.
  const exportAs = (format) => convertTo(format);

  // ---------- Recognize text (OCR) ----------
  const OCR_LANGS_KEY = 'pdfEditor.ocrLanguages';
  let afterOcr = null;

  function openOcrDialog(then = null, note = '') {
    const todo = pages.filter(needsOcr);
    if (!todo.length) return then ? then() : status('There are no scanned pages to recognize.');
    closeTextEditor();
    afterOcr = then;
    let chosen;
    try { chosen = JSON.parse(localStorage.getItem(OCR_LANGS_KEY) || 'null'); } catch { chosen = null; }
    if (!Array.isArray(chosen) || !chosen.length) chosen = ['eng', 'msa'];
    $('ocrLangs').innerHTML = PdfOcr.LANGUAGES.map((l) =>
      `<label class="check"><input type="checkbox" name="ocrLang" value="${l.code}"${chosen.includes(l.code) ? ' checked' : ''}> ${l.label}</label>`).join('');
    $('ocrInfo').textContent = (note ? note + ' ' : '') +
      `${todo.length} scanned page${todo.length === 1 ? '' : 's'} to recognize. The text is added invisibly behind the scan, so the PDF becomes searchable and can be converted to Word or Excel.`;
    $('ocrError').textContent = '';
    $('ocrDialog').showModal();
  }

  async function runOcr() {
    const langs = [...$('ocrDialog').querySelectorAll('input[name=ocrLang]:checked')].map((c) => c.value);
    if (!langs.length) { $('ocrError').textContent = 'Choose at least one language.'; return; }
    try { localStorage.setItem(OCR_LANGS_KEY, JSON.stringify(langs)); } catch {}
    $('ocrDialog').close();
    const todo = pages.filter(needsOcr);
    let stop = false, done = 0, lowConfidence = 0;
    const progress = showProgress('Recognizing text', () => { stop = true; });
    try {
      for (const page of todo) {
        if (stop) break;
        const label = `Page ${pages.indexOf(page) + 1} (${done + 1} of ${todo.length})`;
        progress(done / todo.length, label + ': preparing…');
        const canvas = await renderForOcr(page);
        const res = await PdfOcr.recognize(canvas, {
          langs,
          onProgress: (p) => progress((done + p) / todo.length, `${label}: ${Math.round(p * 100)}%`),
        });
        ocrLayers.set(page.id, { pdf: res.pdf, rotation: page.rotation, tilt: res.tilt, langs });
        if (res.confidence < 60) lowConfidence++;
        done++;
      }
    } catch (err) {
      console.error(err);
      closeProgress();
      return status('Text recognition failed: ' + (err.message || err), 8000);
    } finally {
      PdfOcr.release();
    }
    closeProgress();
    if (done) dirty = true;
    updateButtons();
    const msg = stop
      ? `Stopped after ${done} of ${todo.length} pages. Click Recognize text to continue.`
      : `Text recognized on ${done} page${done === 1 ? '' : 's'}. ${window.desktop ? 'Save' : 'Download'} it to get a searchable PDF, or Convert it to Word or Excel.` +
        (lowConfidence ? ` ${lowConfidence} page${lowConfidence === 1 ? ' was' : 's were'} hard to read, so check the result.` : '');
    status(msg, 8000);
    const then = afterOcr;
    afterOcr = null;
    if (then && !stop && done) then();
  }

  // The page as shown (with its rotation), at about 300 DPI.
  async function renderForOcr(page) {
    const p = await getPdfjsPage(sources[page.src], page.srcPage);
    let scale = PdfOcr.DPI / 72;
    const base = p.getViewport({ scale: 1, rotation: page.rotation });
    scale = Math.min(scale, PdfOcr.MAX_SIDE / Math.max(base.width, base.height));
    const vp = p.getViewport({ scale, rotation: page.rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  // A progress window; returns update(fraction, text). onStop is called by the Stop button.
  function showProgress(title, onStop, stopping = 'Stopping after this page…') {
    $('progressTitle').textContent = title;
    $('progressBar').value = 0;
    $('progressText').textContent = '';
    $('progressStop').disabled = false;
    $('progressStop').onclick = () => { $('progressStop').disabled = true; $('progressText').textContent = stopping; onStop(); };
    if (!$('progressDialog').open) $('progressDialog').showModal();
    return (fraction, text) => {
      $('progressBar').value = Math.max(0, Math.min(1, fraction));
      if (!$('progressStop').disabled) $('progressText').textContent = text;
    };
  }
  const closeProgress = () => { if ($('progressDialog').open) $('progressDialog').close(); };

  // ---------- Split / extract pages ----------
  // "1-3, 5, 8-" -> [0, 1, 2, 4, 7, …]; throws a readable message if invalid.
  function parseRanges(text, count) {
    const out = [];
    const parts = text.replace(/\s*-\s*/g, '-').split(/[,;\s]+/).filter(Boolean);
    if (!parts.length) throw new Error('Type the pages to save, for example 1-3, 5.');
    for (const part of parts) {
      const m = part.match(/^(\d*)-?(\d*)$/);
      if (!m || (!m[1] && !m[2])) throw new Error(`"${part}" isn't a page or range. Use numbers like 2 or 4-7.`);
      const range = part.includes('-');
      const a = m[1] ? +m[1] : 1;
      const b = range ? (m[2] ? +m[2] : count) : a;
      if (a < 1 || b < 1 || a > count || b > count) throw new Error(`Page ${Math.max(a, b) > count ? Math.max(a, b) : 0} doesn't exist: this document has pages 1 to ${count}.`);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!out.includes(i - 1)) out.push(i - 1);
    }
    return out;
  }

  function openSplitDialog() {
    if (!pages.length) return;
    closeTextEditor();
    $('splitCount').textContent = pages.length + (pages.length === 1 ? ' page' : ' pages');
    const current = pages.findIndex((p) => p.id === currentPageId) + 1 || 1;
    $('splitRanges').value = String(current);
    $('splitError').textContent = '';
    $('splitDialog').showModal();
    $('splitRanges').select();
  }

  async function runSplit() {
    const mode = $('splitDialog').querySelector('input[name=splitMode]:checked').value;
    const base = baseName();
    try {
      if (mode === 'extract') {
        const idx = parseRanges($('splitRanges').value, pages.length);
        $('splitDialog').close();
        status('Creating PDF…', 30000);
        const label = $('splitRanges').value.replace(/\s+/g, '').replace(/[^\d,-]/g, '').replace(/,/g, '_').slice(0, 40);
        const bytes = await protect(await buildPdf({ list: idx.map((i) => pages[i]) }));
        const name = `${base}-pages-${label}.pdf`;
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
        status(`${DONE} ${name} (${idx.length} page${idx.length === 1 ? '' : 's'})`);
      } else {
        const every = Math.floor(+$('splitEvery').value);
        if (!(every >= 1)) throw new Error('Enter how many pages each file should have (1 or more).');
        $('splitDialog').close();
        const groups = [];
        for (let i = 0; i < pages.length; i += every) groups.push(pages.slice(i, i + every));
        const digits = String(pages.length).length;
        const files = {};
        for (let g = 0; g < groups.length; g++) {
          status(`Creating file ${g + 1} of ${groups.length}…`, 30000);
          const first = g * every + 1, last = first + groups[g].length - 1;
          const pad = (n) => String(n).padStart(digits, '0');
          const name = first === last ? `${base}-page-${pad(first)}.pdf` : `${base}-pages-${pad(first)}-${pad(last)}.pdf`;
          files[name] = await protect(await buildPdf({ list: groups[g] }));
        }
        const names = Object.keys(files);
        if (names.length === 1) {
          downloadBlob(new Blob([files[names[0]]], { type: 'application/pdf' }), names[0]);
          status(DONE + ' ' + names[0]);
        } else {
          downloadBlob(PdfConvert.zip(files), `${base}-split.zip`);
          status(`${DONE} ${names.length} PDFs in ${base}-split.zip`);
        }
      }
    } catch (err) {
      if ($('splitDialog').open) { $('splitError').textContent = err.message; return; }
      console.error(err);
      status('Could not split: ' + (err.message || err), 6000);
    }
  }

  // ---------- Compress (make smaller) ----------
  const COMPRESS_KEY = 'pdfEditor.compressLevel';
  const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
  const smaller = (before, after) => Math.max(0, Math.round((1 - after / before) * 100));

  function openCompressDialog() {
    closeTextEditor();
    let level = 'balanced';
    try { level = localStorage.getItem(COMPRESS_KEY) || level; } catch {}
    const radio = $('compressDialog').querySelector(`input[name=compressLevel][value="${level}"]`);
    if (radio) radio.checked = true;
    // With no document open, only "Choose PDF files" makes sense.
    $('compressDocBtn').hidden = !pages.length;
    $('compressFilesBtn').classList.toggle('primary', !pages.length);
    $('compressError').textContent = '';
    $('compressDialog').showModal();
  }

  function compressLevel() {
    const level = $('compressDialog').querySelector('input[name=compressLevel]:checked').value;
    try { localStorage.setItem(COMPRESS_KEY, level); } catch {}
    return level;
  }

  // The open document, with its edits.
  async function compressDocument() {
    if (!pages.length) return;
    const preset = compressLevel();
    $('compressDialog').close();
    let stopped = false;
    const progress = showProgress('Making the PDF smaller…', () => { stopped = true; }, 'Stopping…');
    try {
      progress(0, 'Preparing the document…');
      const built = await buildPdf();
      const r = await PdfCompress.compress(built, { preset, onProgress: (f, t) => progress(0.05 + f * 0.95, t[0].toUpperCase() + t.slice(1)), shouldStop: () => stopped });
      const bytes = await protect(r.bytes);
      closeProgress();
      // Compare with the file that was opened, when there is one.
      const before = sources.length === 1 && sources[0].bytes ? Math.max(sources[0].bytes.length, 1) : r.before;
      const name = baseName() + '-compressed.pdf';
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
      const pct = smaller(before, bytes.length);
      status(pct >= 3
        ? `${DONE} ${name}: ${fmtSize(before)} → ${fmtSize(bytes.length)} (${pct}% smaller)`
        : `${DONE} ${name} (${fmtSize(bytes.length)}): this PDF was already compact, so it couldn't be made much smaller.`, 9000);
    } catch (err) {
      closeProgress();
      if (err.code === 'stopped') { status('Compressing stopped.'); return; }
      console.error(err);
      status('Could not compress: ' + (err.message || err), 6000);
    }
  }

  // One or more PDF files from the computer (they don't need to be open).
  async function compressFiles(files) {
    files = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!files.length) { $('compressError').textContent = 'Choose PDF files.'; return; }
    const preset = compressLevel();
    $('compressDialog').close();
    const n = files.length;
    let stopped = false;
    const progress = showProgress(n === 1 ? 'Making the PDF smaller…' : `Making ${n} PDFs smaller…`, () => { stopped = true; }, n === 1 ? 'Stopping…' : 'Stopping after this file…');
    const results = [];
    const out = {};
    for (let i = 0; i < n && !stopped; i++) {
      const file = files[i];
      const label = n === 1 ? file.name : `${file.name} (${i + 1} of ${n})`;
      progress(i / n, label);
      let bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
        const r = await PdfCompress.compress(bytes, { preset, onProgress: (f, t) => progress((i + f) / n, `${label}: ${t}`), shouldStop: () => stopped });
        let name = file.name.replace(/\.pdf$/i, '') + '-compressed.pdf';
        for (let k = 2; out[name]; k++) name = file.name.replace(/\.pdf$/i, '') + `-compressed (${k}).pdf`;
        out[name] = r.bytes;
        results.push({ name: file.name, before: bytes.length, after: r.after });
      } catch (err) {
        if (err.code === 'stopped') break;
        console.warn('Could not compress', file.name, err);
        results.push({
          name: file.name, before: bytes ? bytes.length : file.size,
          error: err.code === 'encrypted' ? 'Password protected: open it here with its password, then use Compress.' : "Couldn't read this file (it may be damaged).",
        });
      }
    }
    closeProgress();
    const names = Object.keys(out);
    if (!names.length) {
      if (stopped) { status('Compressing stopped.'); return; }
      showCompressResults(results, '');
      return;
    }
    let where;
    if (names.length === 1) {
      downloadBlob(new Blob([out[names[0]]], { type: 'application/pdf' }), names[0]);
      where = `${DONE} ${names[0]}.`;
    } else if (window.desktop && window.desktop.saveFiles) {
      // Desktop app: save them side by side in a folder of the user's choice.
      const saved = await window.desktop.saveFiles(out);
      where = saved ? `Saved ${saved.count} PDFs in ${saved.folder}.` : 'Not saved (no folder chosen).';
    } else {
      downloadBlob(PdfConvert.zip(out), 'compressed-pdfs.zip');
      where = `${DONE} ${names.length} PDFs in compressed-pdfs.zip.`;
    }
    if (stopped) where += ` Stopped after ${results.length} of ${n} files.`;
    showCompressResults(results, where);
  }

  function showCompressResults(results, where) {
    const ok = results.filter((r) => !r.error);
    const before = ok.reduce((s, r) => s + r.before, 0), after = ok.reduce((s, r) => s + r.after, 0);
    const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let rows = '<tr><th>File</th><th>Before</th><th>After</th><th>Smaller by</th></tr>';
    for (const r of results) {
      rows += r.error
        ? `<tr><td>${esc(r.name)}</td><td>${fmtSize(r.before)}</td><td colspan="2" class="note">${esc(r.error)}</td></tr>`
        : `<tr><td>${esc(r.name)}</td><td>${fmtSize(r.before)}</td><td>${fmtSize(r.after)}</td><td class="saved">${smaller(r.before, r.after) >= 1 ? smaller(r.before, r.after) + '%' : '<span class="note">already compact</span>'}</td></tr>`;
    }
    if (ok.length > 1) rows += `<tr><th>Total</th><th>${fmtSize(before)}</th><th>${fmtSize(after)}</th><th class="saved">${smaller(before, after)}%</th></tr>`;
    $('compressTable').innerHTML = rows;
    $('compressSummary').textContent = ok.length
      ? `${where} ${fmtSize(before)} → ${fmtSize(after)} (${smaller(before, after)}% smaller).`
      : 'No files could be compressed.';
    $('compressResults').showModal();
  }

  // ---------- Password for downloads ----------
  function updatePasswordButton() {
    const btn = $('passwordBtn');
    btn.classList.toggle('locked', !!savePassword);
    btn.textContent = savePassword ? '🔒 Password on' : 'Password';
    btn.title = savePassword ? 'Downloads are password protected. Click to change or remove the password.' : 'Protect the downloaded PDF with a password';
  }

  function openPasswordDialog() {
    if (!pages.length) return;
    $('pwInput').value = savePassword;
    $('pwConfirm').value = savePassword;
    $('pwError').textContent = '';
    $('pwShow').checked = false;
    $('pwInput').type = $('pwConfirm').type = 'password';
    $('pwRemove').hidden = !savePassword;
    $('passwordDialog').showModal();
    $('pwInput').focus();
  }

  function setPasswordFromDialog() {
    const pw = $('pwInput').value;
    if (pw.length < 4) { $('pwError').textContent = 'Use at least 4 characters.'; return; }
    if (pw !== $('pwConfirm').value) { $('pwError').textContent = "The two passwords don't match."; return; }
    savePassword = pw;
    $('passwordDialog').close();
    updatePasswordButton();
    status('Password set: downloaded PDFs will ask for it before opening.', 4000);
  }

  // ---------- Tools, zoom, keyboard ----------
  function setTool(name) {
    closeTextEditor();
    if (name !== 'stamp') pendingStamp = null;
    if (hoverChunk) { const id = hoverChunk.pageId; hoverChunk = null; drawOverlay(id); }
    tool = name;
    viewer.dataset.tool = name;
    document.querySelectorAll('#tools .tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    $('signBtn').classList.toggle('active', name === 'stamp');
    if (name !== 'select' && selection) { const id = selection.pageId; selection = null; drawOverlay(id); }
  }

  // Resizes the pages in place: the visible ones are redrawn sharp, the rest
  // when they scroll into view. Thumbnails don't change.
  function setZoom(z) {
    closeTextEditor(true);
    const anchor = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
    zoom = Math.max(0.25, Math.min(4, Math.round(z * 100) / 100));
    for (const page of pages) {
      const el = pageEl(page.id);
      if (!el) continue;
      const vp = viewportFor(page, zoom);
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      if (el.querySelector('canvas.overlay').width) sizeOverlay(el);
    }
    viewer.scrollTop = anchor * viewer.scrollHeight;
    // Observing again reports which pages are (nearly) visible now.
    renderObserver.disconnect();
    viewer.querySelectorAll('.page').forEach((el) => renderObserver.observe(el));
    $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  }

  document.querySelectorAll('#tools .tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('openInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('openInput2').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('mergeInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!pages.length) openFile(files.shift()).then(() => mergeFiles(files));
    else mergeFiles(files);
  });
  $('imageInput').addEventListener('change', (e) => { addImage(e.target.files[0]); e.target.value = ''; });
  $('newBlankBtn').addEventListener('click', newBlankDocument);
  $('watermarkBtn').addEventListener('click', toggleWatermark);
  // Remember the watermark text between visits (if the browser allows it).
  const WM_KEY = 'pdfEditor.watermarkText';
  try { watermarkInput.value = localStorage.getItem(WM_KEY) || WATERMARK.text; } catch { watermarkInput.value = WATERMARK.text; }
  watermarkInput.addEventListener('change', () => {
    if (!watermarkInput.value.trim()) watermarkInput.value = WATERMARK.text;
    try { localStorage.setItem(WM_KEY, watermarkInput.value.trim()); } catch {}
  });
  watermarkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); toggleWatermark(); } });
  $('convertBtn').addEventListener('click', openConvertDialog);
  $('ocrBtn').addEventListener('click', () => openOcrDialog());
  $('ocrDialog').querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); runOcr(); });
  $('ocrDialog').addEventListener('close', () => { if (!$('progressDialog').open) setTimeout(() => { if (!$('progressDialog').open) afterOcr = null; }, 0); });
  $('progressDialog').addEventListener('cancel', (e) => e.preventDefault()); // Esc doesn't hide a running job
  $('convertDialog').querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); runConvert(); });
  $('convertDialog').querySelectorAll('input[name=convertFormat]').forEach((r) => r.addEventListener('change', syncConvertDialog));
  $('convertRanges').addEventListener('focus', () => { $('convertDialog').querySelector('input[name=convertPages][value=some]').checked = true; });
  $('openConvertInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    await openFile(file);
    if (pages.length) openConvertDialog();
  });
  $('saveBtn').addEventListener('click', save);
  $('signBtn').addEventListener('click', startSignature);
  $('splitBtn').addEventListener('click', openSplitDialog);
  $('splitDialog').querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); runSplit(); });
  $('splitRanges').addEventListener('focus', () => { $('splitDialog').querySelector('input[value=extract]').checked = true; });
  $('splitEvery').addEventListener('focus', () => { $('splitDialog').querySelector('input[value=every]').checked = true; });
  $('compressBtn').addEventListener('click', openCompressDialog);
  $('compressStartBtn').addEventListener('click', openCompressDialog);
  $('compressDialog').querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); compressDocument(); });
  $('compressInput').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; compressFiles(files); });
  $('passwordBtn').addEventListener('click', openPasswordDialog);
  $('passwordDialog').querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); setPasswordFromDialog(); });
  $('pwShow').addEventListener('change', (e) => { $('pwInput').type = $('pwConfirm').type = e.target.checked ? 'text' : 'password'; });
  $('pwRemove').addEventListener('click', () => {
    savePassword = '';
    $('passwordDialog').close();
    updatePasswordButton();
    status('Password removed: downloads will open without a password.');
  });
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 1.25));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 1.25));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (arrows[e.key] && selection) {
      e.preventDefault();
      // Arrow keys follow the screen, so undo the page rotation.
      const rot = pageById(selection.pageId).rotation;
      nudgeSelection(...rotateVec(...arrows[e.key], rot));
      return;
    }
    if (e.key === 'Escape' && tool === 'stamp') { setTool('select'); status('Signature not placed'); return; }
    const keys = { v: 'select', e: 'edittext', t: 'text', p: 'pen', h: 'highlight', r: 'rect', w: 'whiteout' };
    if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
    if (e.key.toLowerCase() === 's') startSignature();
    if (e.key === 'Escape' && selection) { const id = selection.pageId; selection = null; drawOverlay(id); }
  });

  // Drop a PDF to open it (or add it to the open document), or an image to insert it.
  viewer.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    viewer.classList.add('dragging');
  });
  viewer.addEventListener('dragleave', (e) => { if (e.target === viewer) viewer.classList.remove('dragging'); });
  viewer.addEventListener('drop', (e) => {
    viewer.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => /^image\/(png|jpeg)$/.test(f.type));
    if (pdfs.length && !pages.length) openFile(pdfs.shift()).then(() => mergeFiles(pdfs));
    else if (pdfs.length) mergeFiles(pdfs);
    imgs.forEach((f) => addImage(f));
  });

  // Track which page is in view so new images land there.
  viewer.addEventListener('scroll', () => {
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    for (const el of viewer.querySelectorAll('.page')) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) {
        if (currentPageId !== el.dataset.id) {
          currentPageId = el.dataset.id;
          sidebar.querySelectorAll('.thumb').forEach((x) => x.classList.toggle('current', x.dataset.id === currentPageId));
        }
        break;
      }
    }
  }, { passive: true });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  loadMeasureFonts();

  // Open a PDF passed in the address, e.g. editor/?pdf=/api/pdf/123&name=page.pdf
  // (used by the Web to PDF tool). Only files from the same site are accepted.
  (async () => {
    const params = new URLSearchParams(location.search);
    if (!params.get('pdf')) return;
    try {
      const src = new URL(params.get('pdf'), location.href);
      if (src.origin !== location.origin) return;
      const res = await fetch(src);
      if (!res.ok) throw new Error(res.status === 404 ? 'it has expired, please create it again' : 'HTTP ' + res.status);
      const name = params.get('name') || 'page.pdf';
      await openFile(new File([await res.blob()], name, { type: 'application/pdf' }));
    } catch (err) {
      status('Could not open the PDF: ' + (err.message || err), 6000);
    }
  })();
  updateButtons();

  // ---------- Desktop app ----------
  // In the desktop app (Electron), files opened from the system ("Open with",
  // double-click, File > Open) and menu commands arrive here.
  if (window.desktop) {
    document.body.classList.add('desktop');
    $('saveBtn').textContent = 'Save as…';
    $('saveBtn').title = 'Save the edited PDF (Ctrl+S)';
    const asFile = (f) => new File([f.data], f.name, { type: 'application/pdf' });
    window.desktop.onOpenFile((f) => openFile(asFile(f)));
    window.desktop.onMergeFiles((list) => {
      const files = list.map(asFile);
      if (!pages.length) openFile(files.shift()).then(() => mergeFiles(files));
      else mergeFiles(files);
    });
    window.desktop.onSaved((path) => {
      if (/\.pdf$/i.test(path)) dirty = false;
      status('Saved: ' + path, 5000);
    });
    const commands = {
      save, undo, redo,
      convert: openConvertDialog,
      ocr: () => openOcrDialog(),
      split: openSplitDialog,
      compress: openCompressDialog,
      password: openPasswordDialog,
      sign: startSignature,
      watermark: toggleWatermark,
      zoomIn: () => pages.length && setZoom(zoom * 1.25),
      zoomOut: () => pages.length && setZoom(zoom / 1.25),
      newBlank: newBlankDocument,
    };
    window.desktop.onMenu((cmd) => { if (commands[cmd]) commands[cmd](); });
    window.desktop.ready(); // the app may now send a file it was opened with
  }

  // Exposed for automated tests.
  window.pdfEditor = { buildPdf, exportAs, openFile, getState: () => ({ pages, zoom, tool, selection, savePassword, ocrPages: [...ocrLayers.keys()] }) };
})();
