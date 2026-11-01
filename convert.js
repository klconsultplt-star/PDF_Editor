/* PDF → Word (.docx), OpenDocument Text (.odt), Excel (.xlsx),
 * OpenDocument Spreadsheet (.ods) and CSV, entirely in the browser.
 *
 * A PDF only knows where each piece of text and each picture is drawn, so
 * the document structure has to be rebuilt:
 *
 *   1. Read     every text piece (position, font, bold/italic, size, colour)
 *               and every picture on each page.
 *   2. Layout   pieces → lines → paragraphs, tables, lists and headings,
 *               with alignment, indents, spacing and background shading.
 *   3. Write    the chosen format (all of them are zip files of XML).
 *
 *   const blob = await PdfConvert.convert(pdfBytes, { format: 'docx' });
 */
(() => {
  'use strict';

  // ======================================================================
  // 1. Reading pages
  // ======================================================================

  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const hex = (c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const RENDER_SCALE = 2; // page picture used to read colours
  // Chinese/Japanese characters and full-width punctuation: written without spaces.
  const CJK = '\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef';
  const isCJK = (ch) => !!ch && new RegExp(`[${CJK}]`).test(ch);
  const CJK_SPACES = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');
  const CJK_FONT = 'Microsoft YaHei';

  // Font family, bold and italic from the embedded font's name,
  // e.g. "ABCDEF+TimesNewRomanPS-BoldItalicMT" → Times New Roman, bold, italic.
  function fontInfo(page, fontName, style, cache) {
    if (cache.has(fontName)) return cache.get(fontName);
    let f = null;
    try { if (page.commonObjs.has(fontName)) f = page.commonObjs.get(fontName); } catch { /* not loaded */ }
    const raw = String((f && f.name) || '').replace(/^[A-Z]{6}\+/, '');
    const [fam = '', styleWord = ''] = raw.split(/[-,]/);
    let family = fam.replace(/(PSMT|PS|MT)$/, '')
      .replace(/(Bold|Italic|Oblique|Regular|Roman|Black|Heavy|Semibold|SemiBold|Light|Medium|Book)+$/, (m) => (m === 'Roman' && /Times/.test(fam) ? m : ''))
      .replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    const generic = (f && f.isMonospace) || (style && style.fontFamily === 'monospace') ? 'mono'
      : (f && f.isSerifFont) || (style && style.fontFamily === 'serif') ? 'serif' : 'sans';
    if (!family || /^(g_|Type3|T3)/.test(family)) family = { mono: 'Courier New', serif: 'Times New Roman', sans: 'Arial' }[generic];
    if (family === 'Times') family = 'Times New Roman';
    if (family === 'Helvetica') family = 'Arial';
    if (family === 'Courier') family = 'Courier New';
    const styleText = styleWord + ' ' + raw;
    const info = {
      family,
      bold: !!(f && (f.bold || f.black)) || /bold|black|heavy|semibold|demi/i.test(styleText),
      italic: !!(f && f.italic) || /italic|oblique/i.test(styleText),
    };
    cache.set(fontName, info);
    return info;
  }

  // Ink and background colours inside a box of the rendered page.
  function sampleColors(px, cw, ch, x0, y0, x1, y1) {
    const S = RENDER_SCALE;
    let a = Math.max(0, Math.floor(x0 * S) - 2), b = Math.max(0, Math.floor(y0 * S) - 2);
    let c = Math.min(cw, Math.ceil(x1 * S) + 2), d = Math.min(ch, Math.ceil(y1 * S) + 2);
    if (c - a < 3 || d - b < 3) return { fg: '000000', bg: 'FFFFFF' };
    const step = Math.max(1, Math.floor(Math.sqrt(((c - a) * (d - b)) / 6000)));
    const at = (x, y) => { const i = (y * cw + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const counts = new Map();
    const add = (x, y) => {
      const p = at(x, y);
      const k = (p[0] >> 4) * 256 + (p[1] >> 4) * 16 + (p[2] >> 4);
      const e = counts.get(k) || { n: 0, s: [0, 0, 0] };
      e.n++; e.s[0] += p[0]; e.s[1] += p[1]; e.s[2] += p[2];
      counts.set(k, e);
    };
    // Background: the most common colour in and around the box. (Only the
    // edge isn't enough: in ruled tables it lands on the grid lines.)
    for (let y = b; y < d; y += step) for (let x = a; x < c; x += step) add(x, y);
    const top = [...counts.values()].sort((p, q) => q.n - p.n)[0];
    const bg = top.s.map((s) => s / top.n);
    let max = 0;
    const found = [];
    for (let y = b + 2; y < d - 2; y += step) {
      for (let x = a + 2; x < c - 2; x += step) {
        const p = at(x, y);
        const dist = Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);
        if (dist > max) max = dist;
        found.push([dist, p]);
      }
    }
    if (max < 40) return { fg: '000000', bg: hex(bg) };
    const sum = [0, 0, 0];
    let n = 0;
    for (const [dist, p] of found) if (dist >= max * 0.85) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; n++; }
    return { fg: hex(sum.map((s) => s / n)), bg: hex(bg) };
  }

  // Pictures drawn on the page, as PNG/JPEG bytes with their position.
  async function readImages(page, vp, opList) {
    const OPS = pdfjsLib.OPS;
    const out = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const getObj = (id) => new Promise((resolve) => {
      const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
      try { objs.get(id, resolve); } catch { resolve(null); }
      setTimeout(() => resolve(null), 3000);
    });
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args[0]) ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
        const obj = typeof args[0] === 'string' ? await getObj(args[0]) : args[0];
        if (!obj) continue;
        const m = mul(vp.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(m, x, y));
        const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
        const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
        if ((x1 - x0) * (y1 - y0) < 150) continue; // tiny decorations
        const pic = await imageBytes(obj);
        if (pic) out.push({ type: 'image', x0, x1, top: y0, bottom: y1, w: x1 - x0, h: y1 - y0, ...pic });
      }
    }
    return out;
  }

  async function imageBytes(obj) {
    const bitmap = obj.bitmap || (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap ? obj : null);
    const w = obj.width || (bitmap && bitmap.width), h = obj.height || (bitmap && bitmap.height);
    if (!w || !h) return null;
    const scale = Math.min(1, 2000 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    let alpha = false;
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } else if (obj.data) {
      const src = document.createElement('canvas');
      src.width = w; src.height = h;
      const img = src.getContext('2d').createImageData(w, h);
      const d = img.data, s = obj.data;
      const K = pdfjsLib.ImageKind;
      if (obj.kind === K.RGBA_32BPP) { d.set(s.subarray(0, d.length)); alpha = true; }
      else if (obj.kind === K.RGB_24BPP) { for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; d[j + 3] = 255; } }
      else if (obj.kind === K.GRAYSCALE_1BPP) {
        const rowBytes = (w + 7) >> 3;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const v = (s[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          const j = (y * w + x) * 4; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
        }
      } else return null;
      src.getContext('2d').putImageData(img, 0, 0);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    } else return null;
    if (!alpha && bitmap) {
      // Check for transparency so it isn't lost when saving as JPEG.
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) { alpha = true; break; }
    }
    const kind = alpha ? 'png' : 'jpeg';
    const blob = await new Promise((r) => canvas.toBlob(r, kind === 'png' ? 'image/png' : 'image/jpeg', 0.9));
    return { kind, bytes: new Uint8Array(await blob.arrayBuffer()), pxW: canvas.width, pxH: canvas.height };
  }

  async function readPage(page, pageIndex, opts) {
    const vp = page.getViewport({ scale: 1 });
    const [opList, tc] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width * RENDER_SCALE);
    canvas.height = Math.ceil(vp.height * RENDER_SCALE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: RENDER_SCALE }) }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const fonts = new Map();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue; // spaces are re-detected from gaps
      const [a, b, , , e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      if (opts.skip) {
        const mx = e + (a / len) * it.width / 2, my = f + (b / len) * it.width / 2;
        if (opts.skip(pageIndex, mx, my, it.str)) continue;
      }
      const m = mul(vp.transform, it.transform);
      if (Math.abs(m[1]) > Math.abs(m[0]) * 0.2) continue; // sideways text
      const size = Math.hypot(m[2], m[3]);
      if (size < 1) continue;
      const w = (it.width * Math.hypot(m[0], m[1])) / len;
      const x = m[4], y = m[5];
      let font = fontInfo(page, it.fontName, tc.styles[it.fontName], fonts);
      if (/glyph\s*less/i.test(font.family)) font = { ...font, family: [...it.str].some(isCJK) ? CJK_FONT : 'Arial' };
      const col = sampleColors(px, canvas.width, canvas.height, x, y - size * 0.8, x + w, y + size * 0.2);
      items.push({ str: it.str, x, y, w, size, ...font, color: col.fg, bg: col.bg });
    }
    const images = opts.images === false ? [] : await readImages(page, vp, opList);
    const result = { width: vp.width, height: vp.height, items, images, px, cw: canvas.width, ch: canvas.height };
    page.cleanup();
    return result;
  }

  // ======================================================================
  // 2. Layout: lines, paragraphs, tables
  // ======================================================================

  const sameStyle = (p, q) => p.family === q.family && p.bold === q.bold && p.italic === q.italic &&
    Math.abs(p.size - q.size) < 0.6 && p.color === q.color;
  const isWhite = (bg) => !bg || parseInt(bg.slice(0, 2), 16) + parseInt(bg.slice(2, 4), 16) + parseInt(bg.slice(4, 6), 16) > 735;
  const colorDistance = (a, b) => Math.hypot(...[0, 2, 4].map((k) => parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)));
  const plain = (runs) => runs.map((r) => r.text).join('');

  function buildLines(items) {
    items.sort((p, q) => p.y - q.y || p.x - q.x);
    const lines = [];
    for (const it of items) {
      // Same line: baselines close together (relative to the smaller font).
      let line = null;
      for (let k = lines.length - 1; k >= Math.max(0, lines.length - 4); k--) {
        if (Math.abs(lines[k].y - it.y) < Math.min(lines[k].size, it.size) * 0.45) { line = lines[k]; break; }
      }
      if (line) { line.items.push(it); line.size = Math.max(line.size, it.size); }
      else lines.push({ y: it.y, size: it.size, items: [it] });
    }
    for (const line of lines) {
      line.items.sort((p, q) => p.x - q.x);
      line.cells = [];
      let cell = null, prev = null;
      for (const it of line.items) {
        const gap = prev ? it.x - (prev.x + prev.w) : 0;
        if (!cell || gap > Math.max(line.size * 1.2, 9)) {
          cell = { x0: it.x, x1: it.x + it.w, runs: [] };
          line.cells.push(cell);
        } else if (gap > Math.min(prev.size, it.size) * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str) && !(isCJK(prev.str.slice(-1)) && isCJK(it.str[0]))) {
          addText(cell.runs, ' ', prev);
        }
        addText(cell.runs, it.str, it);
        cell.x1 = Math.max(cell.x1, it.x + it.w);
        prev = it;
      }
      for (const c of line.cells) {
        c.runs = c.runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ').replace(CJK_SPACES, '$1') }));
        if (c.runs.length) { c.runs[0].text = c.runs[0].text.replace(/^ /, ''); const l = c.runs[c.runs.length - 1]; l.text = l.text.replace(/ $/, ''); }
        c.runs = c.runs.filter((r) => r.text);
        c.bg = line.items.find((it) => it.x >= c.x0 - 0.5)?.bg;
      }
      line.cells = line.cells.filter((c) => c.runs.length);
      line.x0 = line.cells.length ? line.cells[0].x0 : 0;
      line.x1 = line.cells.length ? line.cells[line.cells.length - 1].x1 : 0;
      line.top = line.y - line.size * 0.9;
      line.bottom = line.y + line.size * 0.25;
      const bgs = line.items.map((it) => it.bg);
      line.bg = bgs.every((b) => b === bgs[0]) ? bgs[0] : null;
    }
    return lines.filter((l) => l.cells.length);
  }

  function addText(runs, text, style) {
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else runs.push({ text, family: style.family, bold: style.bold, italic: style.italic, size: style.size, color: style.color });
  }

  // Merge overlapping x-ranges into column ranges.
  function columnsOf(cells) {
    const spans = cells.map((c) => [c.x0, c.x1]).sort((p, q) => p[0] - q[0]);
    const cols = [];
    for (const [a, b] of spans) {
      const last = cols[cols.length - 1];
      if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b); else cols.push([a, b]);
    }
    return cols;
  }

  // Columns of a table. When most rows have the same number of cells, the
  // n-th cell of each row is column n (so left-aligned headings and
  // right-aligned numbers in the same column stay together).
  function tableColumns(rows) {
    const multi = rows.filter((r) => r.cells.length >= 2);
    const n = Math.max(...multi.map((r) => r.cells.length));
    const full = multi.filter((r) => r.cells.length === n);
    if (full.length >= 2 && full.length >= multi.length * 0.6) {
      const cols = Array.from({ length: n }, (_, k) => [Math.min(...full.map((r) => r.cells[k].x0)), Math.max(...full.map((r) => r.cells[k].x1))]);
      if (cols.every((c, k) => k === 0 || c[0] > cols[k - 1][0])) return cols;
    }
    return columnsOf(multi.flatMap((r) => r.cells));
  }

  // Which column a cell belongs to: the one it overlaps most, else the nearest.
  function columnIndex(cols, c) {
    let best = 0, score = -Infinity;
    cols.forEach(([a, b], k) => {
      const overlap = Math.min(b, c.x1) - Math.max(a, c.x0);
      const s = overlap > 0 ? overlap : -Math.min(Math.abs(c.x0 - b), Math.abs(a - c.x1));
      if (s > score) { score = s; best = k; }
    });
    return best;
  }

  function findTables(lines) {
    const used = new Set();
    const tables = [];
    const isRow = (l) => l.cells.length >= 2 && !listMarker(l);
    let i = 0;
    while (i < lines.length) {
      if (!isRow(lines[i])) { i++; continue; }
      let j = i;
      while (j + 1 < lines.length) {
        const next = lines[j + 1], cur = lines[j];
        const gap = next.y - cur.y;
        if (gap > Math.max(cur.size, next.size) * 3) break;
        if (isRow(next)) { j++; continue; }
        if (Math.abs(next.size - cur.size) > cur.size * 0.15) break; // e.g. a heading
        // A row with one filled cell can still belong to the table, if it
        // lines up with a column of the next row.
        const after = lines[j + 2];
        if (next.cells.length === 1 && !listMarker(next) && after && isRow(after) && after.y - next.y < next.size * 3 &&
          after.cells.some((c) => Math.abs(c.x0 - next.cells[0].x0) < 3)) { j++; continue; }
        break;
      }
      const rows = lines.slice(i, j + 1);
      const multi = rows.filter((r) => r.cells.length >= 2).length;
      const cols = tableColumns(rows);
      const longCells = rows.flatMap((r) => r.cells).filter((c) => plain(c.runs).length > 80).length;
      if (multi >= 2 && cols.length >= 2 && longCells < rows.length) {
        tables.push({ start: i, end: j, rows, cols });
        for (let k = i; k <= j; k++) used.add(k);
      }
      i = j + 1;
    }
    return { tables, used };
  }

  function pageBackground(pg) {
    const counts = new Map();
    const step = Math.max(4, Math.floor(Math.sqrt((pg.cw * pg.ch) / 20000)));
    for (let y = 0; y < pg.ch; y += step) for (let x = 0; x < pg.cw; x += step) {
      const i = (y * pg.cw + x) * 4;
      const k = (pg.px[i] >> 3) + ',' + (pg.px[i + 1] >> 3) + ',' + (pg.px[i + 2] >> 3);
      const e = counts.get(k) || { n: 0, s: [0, 0, 0] };
      e.n++; e.s[0] += pg.px[i]; e.s[1] += pg.px[i + 1]; e.s[2] += pg.px[i + 2];
      counts.set(k, e);
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    const total = [...counts.values()].reduce((s, e) => s + e.n, 0);
    // Only a real background if it covers most of the page.
    return top && top.n / total > 0.5 ? hex(top.s.map((v) => v / top.n)) : 'FFFFFF';
  }

  function layoutPage(pg) {
    const lines = buildLines(pg.items);
    const pageBg = pageBackground(pg);
    const textLeft = lines.length ? Math.min(...lines.map((l) => l.x0)) : 72;
    const textRight = lines.length ? Math.max(...lines.map((l) => l.x1)) : pg.width - 72;
    const { tables, used } = findTables(lines);
    const blocks = [];

    for (const t of tables) {
      const rows = t.rows.map((line) => {
        const cells = t.cols.map(() => null);
        const direct = line.cells.length === t.cols.length;
        line.cells.forEach((c, idx) => {
          const k = direct ? idx : columnIndex(t.cols, c);
          if (cells[k]) { cells[k].runs.push({ ...cells[k].runs[cells[k].runs.length - 1], text: ' ' }, ...c.runs); }
          else cells[k] = { runs: c.runs.slice(), bg: c.bg, x0: c.x0, x1: c.x1 };
        });
        return { cells, size: line.size, top: line.top, bottom: line.bottom };
      });
      rows.forEach((r, k) => {
        const next = t.rows[k + 1], prev = t.rows[k - 1];
        r.height = next ? next.y - t.rows[k].y : prev ? t.rows[k].y - prev.y : t.rows[k].size * 1.2;
      });
      const top = t.rows[0].top, bottom = t.rows[t.rows.length - 1].bottom;
      blocks.push({ type: 'table', top, bottom, rows, cols: t.cols, x0: t.cols[0][0], x1: t.cols[t.cols.length - 1][1],
        borders: hasGrid(pg, t, top, bottom, pageBg) });
    }

    // Paragraphs from the remaining lines.
    let para = null;
    const finish = () => { if (para) blocks.push(para); para = null; };
    lines.forEach((line, idx) => {
      if (used.has(idx)) { finish(); return; }
      const bullet = listMarker(line);
      const prev = para && para.lines[para.lines.length - 1];
      const continues = prev && !bullet && !para.bullet === !bullet &&
        line.y - prev.y < Math.max(prev.size, line.size) * 1.75 &&
        Math.abs(line.size - prev.size) < prev.size * 0.15 &&
        line.cells.length === 1 && prev.cells.length === 1 &&
        Math.abs(line.x0 - (para.lines.length > 1 ? para.lines[1].x0 : prev.x0)) < prev.size * 1.6 &&
        prev.x1 > para.maxX1 - prev.size * 6 && // previous line ran (nearly) to the right edge
        line.bg === prev.bg;
      if (continues) {
        para.lines.push(line);
        para.maxX1 = Math.max(para.maxX1, line.x1);
        para.bottom = line.bottom;
        return;
      }
      if (!bullet && para && para.bullet && line.cells.length === 1 && Math.abs(line.x0 - para.textX) < line.size && line.y - prev.y < line.size * 1.75) {
        // Wrapped second line of a list item (starts under the item's text).
        para.lines.push(line); para.bottom = line.bottom; return;
      }
      finish();
      para = { type: 'p', lines: [line], top: line.top, bottom: line.bottom, maxX1: Math.max(line.x1, textRight - line.size * 4), bullet, textX: bullet ? bullet.textX : line.x0 };
    });
    finish();
    // Fix continuation of list items: lines starting at the text column belong to the item.
    for (const p of blocks) if (p.type === 'p') finishParagraph(p, textLeft, textRight);

    for (const im of pg.images) {
      const area = (im.w * im.h) / (pg.width * pg.height);
      if (area > 0.85 && lines.length) continue; // full-page background (e.g. scanned page under text)
      blocks.push(im);
    }
    blocks.sort((p, q) => p.top - q.top);
    // paper: the page's actual background (e.g. slightly grey on scans); bg: only if it's a real colour.
    return { width: pg.width, height: pg.height, blocks, textLeft, textRight, lines, paper: pageBg, bg: isWhite(pageBg) ? null : pageBg };
  }

  // Bullets drawn with Symbol/Wingdings fonts use private character codes.
  const SYMBOL_BULLETS = { '\uf0b7': '•', '\uf0a7': '▪', '\uf0a8': '▪', '\uf06e': '■', '\uf076': '❖', '\uf0d8': '➢', '\uf0fc': '✓', '\uf0e0': '•', '\uf02d': '–' };
  const BULLET_RE = /^([•●○◦▪▫■□‣⁃–\-*·❖➢✓\uf0b7\uf0a7\uf0a8\uf06e\uf076\uf0d8\uf0fc\uf0e0\uf02d]|\d{1,3}[.)]|[a-zA-Z][.)]|\(\w{1,3}\))$/;

  // Text recognition (OCR) often reads a round bullet as one of these letters.
  const MISREAD_BULLET = /^[eoO°©®«*]$/;

  // "•  Text", "1.  Text", "a)  Text" → a list item.
  function listMarker(line) {
    const first = plain(line.cells[0].runs).trim();
    if (line.cells.length === 2 && MISREAD_BULLET.test(first) && /^\p{L}/u.test(plain(line.cells[1].runs).trim()) &&
      line.cells[1].x0 - line.cells[0].x1 < line.size * 4) {
      return { marker: '•', markerX: line.cells[0].x0, textX: line.cells[1].x0 };
    }
    if (line.cells.length >= 2 && BULLET_RE.test(first) && line.cells[1].x0 - line.cells[0].x1 < line.size * 4) {
      return { marker: SYMBOL_BULLETS[first] || first, markerX: line.cells[0].x0, textX: line.cells[1].x0 };
    }
    const m = first.match(/^([•●○◦▪■‣·\uf0b7\uf0a7])\s+/);
    if (m) return { marker: SYMBOL_BULLETS[m[1]] || m[1], markerX: line.x0, textX: line.x0 + line.size * 1.2, inline: true };
    return null;
  }

  function finishParagraph(p, textLeft, textRight) {
    const L = p.lines;
    const first = L[0];
    p.size = Math.max(...L.map((l) => l.size));
    // Runs of the whole paragraph; lines are joined with a space (or a
    // removed hyphen when a word was split across lines).
    const runs = [];
    L.forEach((line, i) => {
      let cells = line.cells;
      if (i === 0 && p.bullet && !p.bullet.inline) cells = cells.slice(1);
      cells.forEach((c, k) => {
        let cr = c.runs.map((r) => ({ ...r }));
        if (i === 0 && k === 0 && p.bullet && p.bullet.inline) cr[0].text = cr[0].text.replace(/^\S\s+/, '');
        cr.forEach((r) => { r.text = r.text.replace(/[\uf0b7\uf0a7\uf0a8\uf06e\uf076\uf0d8\uf0fc\uf0e0]/g, (ch) => SYMBOL_BULLETS[ch]); });
        if (k > 0) runs.push({ ...cr[0], text: '\t' });
        if (i > 0 && k === 0 && runs.length) {
          const last = runs[runs.length - 1];
          if (/[a-z]-$/.test(last.text) && /^[a-z]/.test(cr[0].text)) last.text = last.text.slice(0, -1);
          else if (isCJK(last.text.slice(-1)) && isCJK(cr[0].text[0])) { /* Chinese lines join without a space */ }
          else if (!/\s$/.test(last.text)) last.text += ' ';
        }
        for (const r of cr) { const last = runs[runs.length - 1]; if (last && sameStyle(last, r)) last.text += r.text; else runs.push(r); }
      });
    });
    p.runs = runs.filter((r) => r.text);
    // Alignment.
    const width = textRight - textLeft;
    const center = (textLeft + textRight) / 2;
    const centered = L.every((l) => Math.abs((l.x0 + l.x1) / 2 - center) < width * 0.03) && first.x0 > textLeft + first.size * 2;
    const right = !centered && L.every((l) => Math.abs(l.x1 - textRight) < 3) && first.x0 > textLeft + width * 0.3;
    const justified = L.length > 2 && L.slice(0, -1).every((l) => Math.abs(l.x1 - p.maxX1) < 2.5);
    p.align = centered ? 'center' : right ? 'right' : justified ? 'both' : 'left';
    // Indents (relative to the page's text margin).
    const bodyX = L.length > 1 ? L[1].x0 : first.x0;
    if (p.bullet) {
      p.indent = Math.max(0, p.bullet.textX - textLeft);
      p.hanging = p.bullet.textX - p.bullet.markerX;
    } else if (p.align === 'left' || p.align === 'both') {
      p.indent = Math.max(0, bodyX - textLeft);
      p.firstLine = L.length > 1 ? first.x0 - bodyX : 0;
    } else {
      p.indent = 0; p.firstLine = 0;
    }
    // Line spacing as a multiple of the font size.
    if (L.length > 1) {
      const gaps = L.slice(1).map((l, i) => l.y - L[i].y);
      const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      p.lineSpacing = Math.max(1, Math.min(2.5, avg / (p.size * 1.17)));
    } else p.lineSpacing = 1;
    p.bg = L.every((l) => l.bg && l.bg === first.bg) && !isWhite(first.bg) ? first.bg : null;
  }

  // Ruled tables: look for a drawn vertical line anywhere in the gap
  // between the first two columns, running the height of the table.
  function hasGrid(pg, t, top, bottom, pageBg) {
    const S = RENDER_SCALE;
    const bg = [0, 2, 4].map((k) => parseInt(pageBg.slice(k, k + 2), 16));
    const x0 = Math.max(0, Math.floor(t.cols[0][1] * S) + 1), x1 = Math.min(pg.cw - 1, Math.ceil(t.cols[1][0] * S) - 1);
    const y0 = Math.max(0, Math.round(top * S)), y1 = Math.min(pg.ch - 1, Math.round(bottom * S));
    if (x1 <= x0 || y1 - y0 < 4) return false;
    for (let x = x0; x <= x1; x++) {
      let dark = 0, total = 0;
      for (let y = y0; y < y1; y += 2) {
        const i = (y * pg.cw + x) * 4;
        // A line pixel stands out from the page background (light or dark pages).
        if (Math.hypot(pg.px[i] - bg[0], pg.px[i + 1] - bg[1], pg.px[i + 2] - bg[2]) > 90) dark++;
        total++;
      }
      if (dark / total > 0.85) return true;
    }
    return false;
  }

  // Body text size: the size used by most characters.
  function bodySize(pages) {
    const counts = new Map();
    for (const p of pages) for (const l of p.lines) for (const c of l.cells) for (const r of c.runs) {
      const k = Math.round(r.size * 2) / 2;
      counts.set(k, (counts.get(k) || 0) + r.text.length);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
  }

  function bodyFont(pages) {
    const counts = new Map();
    for (const p of pages) for (const l of p.lines) for (const c of l.cells) for (const r of c.runs) counts.set(r.family, (counts.get(r.family) || 0) + r.text.length);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Arial';
  }

  function headingLevel(p, body) {
    if (p.type !== 'p' || p.bullet || p.lines.length > 3) return 0;
    const text = plain(p.runs);
    if (text.length > 160) return 0;
    const r = p.size / body;
    if (r >= 1.75) return 1;
    if (r >= 1.3) return 2;
    if (r >= 1.08 && p.runs.every((x) => x.bold)) return 3;
    return 0;
  }

  // ======================================================================
  // 3a. Numbers for spreadsheets
  // ======================================================================

  // "$1,250.00" → { value: 1250, fmt: currency $ 2 decimals }; "-3.1%" → percent.
  function parseNumber(text) {
    let t = text.trim();
    if (!t || t.length > 24) return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
    if (/^[-−–]/.test(t)) { neg = !neg; t = t.slice(1).trim(); }
    let symbol = null;
    const sym = t.match(/^([$€£¥])\s?/) || t.match(/\s?([$€£¥])$/);
    if (sym) { symbol = sym[1]; t = t.replace(sym[0], ''); }
    if (/^[-−–]/.test(t)) { neg = !neg; t = t.slice(1); }
    let percent = false;
    if (/%$/.test(t)) { percent = true; t = t.slice(0, -1).trim(); }
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return null;
    if (/^0\d/.test(t) && !symbol && !percent) return null; // codes like 007 stay text
    const grouping = t.includes(',');
    const decimals = (t.split('.')[1] || '').length;
    let value = parseFloat(t.replace(/,/g, ''));
    if (!isFinite(value) || t.replace(/\D/g, '').length > 15) return null;
    if (neg) value = -value;
    if (percent) value = value / 100;
    return { value, kind: symbol ? 'currency' : percent ? 'percent' : 'number', symbol, decimals, grouping };
  }

  // Spreadsheet rows for one page: tables keep their columns, other text
  // goes in column A, one paragraph per row.
  function sheetRows(page) {
    const rows = [];
    let lastBottom = null;
    for (const b of page.blocks) {
      if (b.type === 'image') continue;
      if (lastBottom != null && b.top - lastBottom > 14 && rows.length) rows.push([]);
      if (b.type === 'table') {
        for (const r of b.rows) {
          const row = [];
          r.cells.forEach((c, k) => { if (c) row[k] = cellOf(c.runs, c.bg, page.paper); });
          rows.push(row);
        }
      } else {
        rows.push([cellOf(b.runs.map((r) => ({ ...r, text: r.text.replace(/\t/g, '  ') })), b.bg, page.paper)]);
      }
      lastBottom = b.bottom;
    }
    return rows;
  }

  function cellOf(runs, bg, paper) {
    const text = plain(runs).trim();
    const num = parseNumber(text);
    const main = runs.reduce((m, r) => (r.text.length > (m ? m.text.length : -1) ? r : m), null) || {};
    return {
      text, num,
      bold: runs.length > 0 && runs.every((r) => r.bold || !r.text.trim()),
      italic: runs.length > 0 && runs.every((r) => r.italic || !r.text.trim()),
      color: main.color && main.color !== '000000' && !/^(0[0-9A-F]){3}$/.test(main.color) ? main.color : null,
      bg: shade(bg, paper),
    };
  }

  // ======================================================================
  // 3b. Writers
  // ======================================================================

  const xml = (s) => String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const twips = (pt) => Math.round(pt * 20);
  const emu = (pt) => Math.round(pt * 12700);
  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  function pageGeometry(page) {
    const left = Math.max(18, Math.min(144, page.textLeft - 2));
    const right = Math.max(18, Math.min(144, page.width - page.textRight - 2));
    const firstTop = page.blocks.length ? page.blocks[0].top : 72;
    const top = Math.max(18, Math.min(144, firstTop - 4));
    return { width: page.width, height: page.height, left, right, top, bottom: 54, textWidth: page.width - left - right };
  }

  // Shading for a paragraph or cell, unless it's just the page colour.
  // Shading for a paragraph or cell, unless it's (nearly) the page's own colour.
  const shade = (bg, paper) => (bg && !isWhite(bg) && (!paper || colorDistance(bg, paper) > 24) ? bg : null);

  // ---------- Word (.docx) ----------
  function toDocx(doc) {
    const media = [];
    const body = [];
    const g = pageGeometry(doc.pages[0]);
    // Word has one page colour per document: use it when all pages agree.
    const docBg = doc.pages.every((p) => p.bg && p.bg === doc.pages[0].bg) ? doc.pages[0].bg : null;
    const rPr = (r) => `<w:rPr><w:rFonts w:ascii="${xml(r.family)}" w:hAnsi="${xml(r.family)}" w:cs="${xml(r.family)}" w:eastAsia="${xml([...r.text].some(isCJK) ? (r.family === 'Arial' ? CJK_FONT : r.family) : CJK_FONT)}"/>` +
      (r.bold ? '<w:b/>' : '') + (r.italic ? '<w:i/>' : '') +
      (r.color && r.color !== '000000' ? `<w:color w:val="${r.color}"/>` : '') +
      `<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/></w:rPr>`;
    const runXml = (r) => r.text.split('\t').map((part, i) =>
      (i ? `<w:r>${rPr(r)}<w:tab/></w:r>` : '') + (part ? `<w:r>${rPr(r)}<w:t xml:space="preserve">${xml(part)}</w:t></w:r>` : '')).join('');
    const pXml = ({ runs, align = 'left', indent = 0, firstLine = 0, hanging = 0, before = 0, line = 1, bg = null, pageBreak = false, outline = 0, tab = null, inner = '' }) =>
      '<w:p><w:pPr>' + (pageBreak ? '<w:pageBreakBefore/>' : '') +
      (bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>` : '') +
      (tab ? `<w:tabs><w:tab w:val="left" w:pos="${twips(tab)}"/></w:tabs>` : '') +
      `<w:spacing w:before="${twips(before)}" w:after="0" w:line="${Math.round(240 * line)}" w:lineRule="auto"/>` +
      (indent || firstLine || hanging ? `<w:ind w:left="${twips(indent)}"${hanging ? ` w:hanging="${twips(hanging)}"` : firstLine > 0 ? ` w:firstLine="${twips(firstLine)}"` : firstLine < 0 ? ` w:hanging="${twips(-firstLine)}"` : ''}/>` : '') +
      (align !== 'left' ? `<w:jc w:val="${align}"/>` : '') +
      (outline ? `<w:outlineLvl w:val="${outline - 1}"/>` : '') +
      '</w:pPr>' + inner + (runs || []).map(runXml).join('') + '</w:p>';

    doc.pages.forEach((page, pi) => {
      const geo = pageGeometry(page);
      let prevBottom = geo.top;
      page.blocks.forEach((b, bi) => {
        const pageBreak = pi > 0 && bi === 0;
        const before = Math.max(0, Math.min(72, b.top - prevBottom - (b.type === 'p' ? b.size * 0.2 : 0)));
        if (b.type === 'p') {
          const lvl = headingLevel(b, doc.body);
          let runs = b.runs;
          if (b.bullet) runs = [{ ...b.runs[0], text: b.bullet.marker + '\t' }, ...b.runs];
          body.push(pXml({ runs, align: b.align, indent: b.indent, firstLine: b.firstLine, hanging: b.hanging, before: pageBreak ? 0 : before,
            line: b.lineSpacing, bg: docBg ? shade(b.bg, docBg) : shade(b.bg, page.paper), pageBreak, outline: lvl, tab: b.bullet ? b.indent : null }));
        } else if (b.type === 'image') {
          media.push(b);
          const n = media.length;
          const maxW = geo.textWidth;
          const k = Math.min(1, maxW / b.w);
          const w = b.w * k, h = b.h * k;
          const centered = Math.abs((b.x0 + b.x1) / 2 - geo.width / 2) < geo.width * 0.05 && b.x0 > geo.left + 10;
          const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:docPr id="${n}" name="Picture ${n}"/>` +
            '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
            '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
            `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${b.kind === 'png' ? 'png' : 'jpeg'}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
            '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
          body.push(pXml({ align: centered ? 'center' : 'left', indent: centered ? 0 : Math.max(0, b.x0 - geo.left), before: pageBreak ? 0 : before, pageBreak, inner: drawing }));
        } else if (b.type === 'table') {
          if (pageBreak || before > 2) body.push(pXml({ runs: [], before: pageBreak ? 0 : Math.max(0, before - 12), pageBreak, line: 0.5 }));
          body.push(tableDocx(b, geo, runXml, pXml, docBg || page.paper));
        }
        prevBottom = b.bottom;
      });
    });
    body.push('<w:p/>'); // a document must not end with a table

    const sect = `<w:sectPr><w:pgSz w:w="${twips(g.width)}" w:h="${twips(g.height)}"${g.width > g.height ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${twips(g.top)}" w:right="${twips(g.right)}" w:bottom="${twips(g.bottom)}" w:left="${twips(g.left)}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;
    const document = XML_HEAD +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      (docBg ? `<w:background w:color="${docBg}"/>` : '') + '<w:body>' + body.join('') + sect + '</w:body></w:document>';
    const styles = XML_HEAD + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xml(doc.font)}" w:hAnsi="${xml(doc.font)}" w:cs="${xml(doc.font)}" w:eastAsia="${xml(doc.font)}"/><w:sz w:val="${Math.round(doc.body * 2)}"/><w:szCs w:val="${Math.round(doc.body * 2)}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
      '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '</w:styles>';
    const files = {
      '[Content_Types].xml': XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
      '_rels/.rels': XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': document,
      'word/styles.xml': styles,
      // Show the page colour (Word hides it unless asked).
      'word/settings.xml': XML_HEAD + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + (docBg ? '<w:displayBackgroundShape/>' : '') + '</w:settings>',
      'word/_rels/document.xml.rels': XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
        media.map((m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${m.kind === 'png' ? 'png' : 'jpeg'}"/>`).join('') +
        '</Relationships>',
    };
    media.forEach((m, i) => { files[`word/media/image${i + 1}.${m.kind === 'png' ? 'png' : 'jpeg'}`] = m.bytes; });
    return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // Table column widths (points), scaled to fit between the margins.
  function tableWidths(b, geo) {
    const widths = b.cols.map(([a], k) => (k + 1 < b.cols.length ? b.cols[k + 1][0] - a : b.cols[k][1] - a + 12));
    const total = widths.reduce((s, w) => s + w, 0);
    const room = geo.textWidth - Math.max(0, b.x0 - geo.left - 6);
    const k = total > room ? room / total : 1;
    return widths.map((w) => w * k);
  }

  function tableDocx(b, geo, runXml, pXml, pageBg) {
    const widths = tableWidths(b, geo);
    const border = b.borders ? '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('') + '</w:tblBorders>' : '';
    const indent = Math.max(0, b.x0 - geo.left - 6);
    return '<w:tbl><w:tblPr>' + `<w:tblW w:w="${twips(widths.reduce((s, w) => s + w, 0))}" w:type="dxa"/>` +
      (indent ? `<w:tblInd w:w="${twips(indent)}" w:type="dxa"/>` : '') + border + '<w:tblLayout w:type="fixed"/>' +
      '<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
      '<w:tblGrid>' + widths.map((w) => `<w:gridCol w:w="${twips(w)}"/>`).join('') + '</w:tblGrid>' +
      b.rows.map((r) => `<w:tr><w:trPr><w:trHeight w:val="${twips(r.height)}" w:hRule="atLeast"/></w:trPr>` + r.cells.map((c, k) => {
        const bg = c ? shade(c.bg, pageBg) : null;
        const right = c && parseNumber(plain(c.runs)) && c.x1 > b.cols[k][1] - 2 && c.x0 > b.cols[k][0] + 2;
        return `<w:tc><w:tcPr><w:tcW w:w="${twips(widths[k])}" w:type="dxa"/>` + (bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>` : '') + '</w:tcPr>' +
          pXml({ runs: c ? c.runs : [], align: right ? 'right' : 'left' }) + '</w:tc>';
      }).join('') + '</w:tr>').join('') + '</w:tbl>';
  }

  // ---------- OpenDocument Text (.odt) ----------
  const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
    'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"';

  // Collects automatic styles, reusing identical ones.
  class StyleBook {
    constructor() { this.map = new Map(); this.list = []; this.fonts = new Set(); }
    get(prefix, family, body, attrs = '') {
      const key = family + '|' + attrs + '|' + body;
      if (!this.map.has(key)) {
        const name = prefix + (this.list.filter((s) => s.prefix === prefix).length + 1);
        this.map.set(key, name);
        this.list.push({ prefix, name, xml: `<style:style style:name="${name}" style:family="${family}"${attrs}>${body}</style:style>` });
      }
      return this.map.get(key);
    }
    textProps(r) {
      this.fonts.add(r.family);
      const asian = [...r.text].some(isCJK) ? r.family : CJK_FONT;
      this.fonts.add(asian);
      return `<style:text-properties style:font-name="${xml(r.family)}" style:font-name-asian="${xml(asian)}" style:font-size-asian="${+r.size.toFixed(1)}pt" fo:font-size="${+r.size.toFixed(1)}pt"` +
        (r.bold ? ' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"' : '') +
        (r.italic ? ' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"' : '') +
        (r.color && r.color !== '000000' ? ` fo:color="#${r.color}"` : '') + '/>';
    }
    fontDecls() {
      return '<office:font-face-decls>' + [...this.fonts].map((f) => `<style:font-face style:name="${xml(f)}" svg:font-family="${xml(/\s/.test(f) ? `'${f}'` : f)}"/>`).join('') + '</office:font-face-decls>';
    }
    xml() { return this.list.map((s) => s.xml).join(''); }
  }

  function odtText(text) {
    // Tabs and runs of spaces need their own elements in ODF.
    return text.split('\t').map((part) => xml(part).replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`)).join('<text:tab/>');
  }

  function toOdt(doc) {
    const st = new StyleBook();
    st.fonts.add(doc.font);
    const media = [];
    const out = [];
    const spans = (runs) => runs.map((r) => `<text:span text:style-name="${st.get('T', 'text', st.textProps(r))}">${odtText(r.text)}</text:span>`).join('');
    // Page colours: each distinct colour gets its own master page.
    const masters = new Map(); // colour ('' = white) -> master page name
    const masterFor = (page) => {
      const key = page.bg || '';
      if (!masters.has(key)) masters.set(key, masters.size ? 'Page' + (masters.size + 1) : 'Standard');
      return masters.get(key);
    };
    const pStyle = ({ align = 'left', indent = 0, firstLine = 0, hanging = 0, before = 0, line = 1, bg = null, pageBreak = false, tab = null, master = null }) => st.get('P', 'paragraph',
      `<style:paragraph-properties fo:text-align="${align === 'both' ? 'justify' : align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}"` +
      ` fo:margin-left="${(indent).toFixed(1)}pt" fo:text-indent="${(hanging ? -hanging : firstLine).toFixed(1)}pt"` +
      ` fo:margin-top="${before.toFixed(1)}pt" fo:margin-bottom="0pt" fo:line-height="${Math.round(line * 100)}%"` +
      (bg ? ` fo:background-color="#${bg}"` : '') + (pageBreak ? ' fo:break-before="page"' : '') + '>' +
      (tab ? `<style:tab-stops><style:tab-stop style:position="${tab.toFixed(1)}pt"/></style:tab-stops>` : '') + '</style:paragraph-properties>',
      master ? ` style:master-page-name="${master}"` : '');

    doc.pages.forEach((page, pi) => {
      const geo = pageGeometry(page);
      let prevBottom = geo.top;
      page.blocks.forEach((b, bi) => {
        // A page starts with its master page (which also starts a new page).
        const master = bi === 0 ? masterFor(page) : null;
        const pageBreak = false;
        const before = bi === 0 ? 0 : Math.max(0, Math.min(72, b.top - prevBottom - (b.type === 'p' ? b.size * 0.2 : 0)));
        if (b.type === 'p') {
          const lvl = headingLevel(b, doc.body);
          let runs = b.runs;
          if (b.bullet) runs = [{ ...b.runs[0], text: b.bullet.marker + '\t' }, ...b.runs];
          const ps = pStyle({ align: b.align, indent: b.indent, firstLine: b.firstLine, hanging: b.hanging, before, line: b.lineSpacing, bg: shade(b.bg, page.paper), master, tab: b.bullet ? 0 : null });
          out.push(lvl ? `<text:h text:style-name="${ps}" text:outline-level="${lvl}">${spans(runs)}</text:h>` : `<text:p text:style-name="${ps}">${spans(runs)}</text:p>`);
        } else if (b.type === 'image') {
          media.push(b);
          const k = Math.min(1, geo.textWidth / b.w);
          const centered = Math.abs((b.x0 + b.x1) / 2 - geo.width / 2) < geo.width * 0.05 && b.x0 > geo.left + 10;
          const ps = pStyle({ align: centered ? 'center' : 'left', indent: centered ? 0 : Math.max(0, b.x0 - geo.left), before, master });
          const fr = st.get('fr', 'graphic', '<style:graphic-properties style:wrap="none" style:vertical-pos="top" style:vertical-rel="baseline" fo:border="none"/>');
          out.push(`<text:p text:style-name="${ps}"><draw:frame draw:style-name="${fr}" draw:name="Image${media.length}" text:anchor-type="as-char" svg:width="${(b.w * k).toFixed(2)}pt" svg:height="${(b.h * k).toFixed(2)}pt" draw:z-index="0">` +
            `<draw:image xlink:href="Pictures/image${media.length}.${b.kind === 'png' ? 'png' : 'jpg'}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`);
        } else if (b.type === 'table') {
          if (master || before > 2) out.push(`<text:p text:style-name="${pStyle({ before: master ? 0 : Math.max(0, before - 12), master, line: 0.5 })}"/>`);
          const widths = tableWidths(b, geo);
          const tName = 'Table' + (out.filter((x) => x.startsWith('<table:table ')).length + 1);
          const ts = st.get('Tbl', 'table', `<style:table-properties style:width="${widths.reduce((s, w) => s + w, 0).toFixed(1)}pt" fo:margin-left="${Math.max(0, b.x0 - geo.left - 6).toFixed(1)}pt" table:align="left"/>`);
          const cols = widths.map((w) => `<table:table-column table:style-name="${st.get('Col', 'table-column', `<style:table-column-properties style:column-width="${w.toFixed(1)}pt"/>`)}"/>`).join('');
          const rows = b.rows.map((r) => `<table:table-row table:style-name="${st.get('Row', 'table-row', `<style:table-row-properties style:min-row-height="${r.height.toFixed(1)}pt"/>`)}">` + r.cells.map((c, k) => {
            const bg = c ? shade(c.bg, page.paper) : null;
            const right = c && parseNumber(plain(c.runs)) && c.x1 > b.cols[k][1] - 2 && c.x0 > b.cols[k][0] + 2;
            const cs = st.get('Cell', 'table-cell', `<style:table-cell-properties fo:padding-top="0.5pt" fo:padding-bottom="0.5pt" fo:padding-left="4pt" fo:padding-right="4pt" fo:border="${b.borders ? '0.5pt solid #000000' : 'none'}"${bg ? ` fo:background-color="#${bg}"` : ''}/>`);
            const ps = pStyle({ align: right ? 'right' : 'left' });
            return `<table:table-cell table:style-name="${cs}" office:value-type="string"><text:p text:style-name="${ps}">${c ? spans(c.runs) : ''}</text:p></table:table-cell>`;
          }).join('') + '</table:table-row>').join('');
          out.push(`<table:table table:name="${tName}" table:style-name="${ts}">${cols}${rows}</table:table>`);
        }
        prevBottom = b.bottom;
      });
    });

    const g = pageGeometry(doc.pages[0]);
    const content = XML_HEAD + `<office:document-content ${ODF_NS}>` + st.fontDecls() +
      `<office:automatic-styles>${st.xml()}</office:automatic-styles><office:body><office:text>${out.join('')}</office:text></office:body></office:document-content>`;
    const styles = XML_HEAD + `<office:document-styles ${ODF_NS}>` + st.fontDecls() +
      '<office:styles><style:default-style style:family="paragraph">' +
      `<style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt"/><style:text-properties style:font-name="${xml(doc.font)}" fo:font-size="${doc.body}pt" fo:language="en" fo:country="US"/></style:default-style>` +
      '<style:style style:name="Standard" style:family="paragraph" style:class="text"/></office:styles>' +
      '<office:automatic-styles>' + [...masters.keys()].map((bg, i) =>
        `<style:page-layout style:name="pm${i + 1}"><style:page-layout-properties fo:page-width="${g.width.toFixed(1)}pt" fo:page-height="${g.height.toFixed(1)}pt"` +
        ` style:print-orientation="${g.width > g.height ? 'landscape' : 'portrait'}" fo:margin-top="${g.top.toFixed(1)}pt" fo:margin-bottom="${g.bottom.toFixed(1)}pt" fo:margin-left="${g.left.toFixed(1)}pt" fo:margin-right="${g.right.toFixed(1)}pt"` +
        (bg ? ` fo:background-color="#${bg}"` : '') + '/></style:page-layout>').join('') + '</office:automatic-styles>' +
      '<office:master-styles>' + [...masters.entries()].map(([, name], i) => `<style:master-page style:name="${name}" style:page-layout-name="pm${i + 1}"/>`).join('') +
      (masters.has('') ? '' : '<style:master-page style:name="Standard" style:page-layout-name="pm1"/>') + '</office:master-styles></office:document-styles>';
    const files = { mimetype: 'application/vnd.oasis.opendocument.text' };
    files['content.xml'] = content;
    files['styles.xml'] = styles;
    files['meta.xml'] = XML_HEAD + `<office:document-meta ${ODF_NS}><office:meta><meta:generator>PDF Editor</meta:generator></office:meta></office:document-meta>`;
    media.forEach((m, i) => { files[`Pictures/image${i + 1}.${m.kind === 'png' ? 'png' : 'jpg'}`] = m.bytes; });
    files['META-INF/manifest.xml'] = XML_HEAD + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
      '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
      '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
      media.map((m, i) => `<manifest:file-entry manifest:full-path="Pictures/image${i + 1}.${m.kind === 'png' ? 'png' : 'jpg'}" manifest:media-type="image/${m.kind === 'png' ? 'png' : 'jpeg'}"/>`).join('') +
      '</manifest:manifest>';
    return new Blob([zip(files)], { type: 'application/vnd.oasis.opendocument.text' });
  }

  // ---------- Spreadsheets ----------
  function numberFormatCode(n) {
    const dec = n.decimals ? '.' + '0'.repeat(n.decimals) : '';
    if (n.kind === 'percent') return '0' + dec + '%';
    const base = (n.grouping || n.kind === 'currency' ? '#,##0' : '0') + dec;
    return n.kind === 'currency' ? `"${n.symbol}"${base}` : base;
  }

  function sheetsOf(doc) {
    return doc.pages.map((page, i) => ({ name: doc.pages.length > 1 ? `Page ${i + 1}` : 'Sheet1', rows: sheetRows(page) }));
  }

  function colWidths(rows) {
    const n = Math.max(1, ...rows.map((r) => r.length));
    return Array.from({ length: n }, (_, c) => Math.min(60, Math.max(8, ...rows.map((r) => (r[c] && r[c].text ? Math.min(r[c].text.length, 60) + 2 : 0)))));
  }

  function colName(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  function toXlsx(doc) {
    const sheets = sheetsOf(doc);
    const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
    const fontIds = new Map([['', 0]]);
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const fillIds = new Map([['', 0]]);
    const numFmts = [];
    const fmtIds = new Map([['', 0]]);
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const xfIds = new Map([['0|0|0|0', 0]]);
    const styleOf = (c) => {
      const fkey = (c.bold ? 'b' : '') + (c.italic ? 'i' : '') + (c.color || '');
      if (!fontIds.has(fkey)) { fontIds.set(fkey, fonts.length); fonts.push('<font>' + (c.bold ? '<b/>' : '') + (c.italic ? '<i/>' : '') + `<sz val="11"/>${c.color ? `<color rgb="FF${c.color}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`); }
      const fill = c.bg || '';
      if (!fillIds.has(fill)) { fillIds.set(fill, fills.length); fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`); }
      const code = c.num ? numberFormatCode(c.num) : '';
      if (!fmtIds.has(code)) { fmtIds.set(code, 164 + numFmts.length); numFmts.push(`<numFmt numFmtId="${164 + numFmts.length}" formatCode="${xml(code)}"/>`); }
      const wrap = !c.num && c.text.length > 60 ? 1 : 0;
      const key = `${fontIds.get(fkey)}|${fmtIds.get(code)}|${fillIds.get(fill)}|${wrap}`;
      if (!xfIds.has(key)) {
        xfIds.set(key, xfs.length);
        xfs.push(`<xf numFmtId="${fmtIds.get(code)}" fontId="${fontIds.get(fkey)}" fillId="${fillIds.get(fill)}" borderId="0" xfId="0"` +
          `${fmtIds.get(code) ? ' applyNumberFormat="1"' : ''}${fontIds.get(fkey) ? ' applyFont="1"' : ''}${fillIds.get(fill) ? ' applyFill="1"' : ''}` +
          (wrap ? ' applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' : '/>'));
      }
      return xfIds.get(key);
    };
    const sheetXml = sheets.map((sh) => {
      const widths = colWidths(sh.rows);
      const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => {
        if (!c || !c.text) return '';
        const ref = colName(ci) + (ri + 1), s = styleOf(c);
        return c.num ? `<c r="${ref}" s="${s}"><v>${c.num.value}</v></c>`
          : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(c.text)}</t></is></c>`;
      }).join('') + '</row>').join('');
      return XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows}</sheetData></worksheet>`;
    });
    const styles = XML_HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '') +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const files = {
      '[Content_Types].xml': XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
      '_rels/.rels': XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'xl/styles.xml': styles,
    };
    sheetXml.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = s; });
    return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function toOds(doc) {
    const sheets = sheetsOf(doc);
    const st = new StyleBook();
    const dataStyles = new Map();
    const dataStyleXml = [];
    const dataStyle = (n) => {
      const key = numberFormatCode(n);
      if (!dataStyles.has(key)) {
        const name = 'N' + (dataStyles.size + 1);
        dataStyles.set(key, name);
        const num = `<number:number number:decimal-places="${n.decimals}" number:min-decimal-places="${n.decimals}" number:min-integer-digits="1"${n.grouping || n.kind === 'currency' ? ' number:grouping="true"' : ''}/>`;
        dataStyleXml.push(n.kind === 'currency'
          ? `<number:currency-style style:name="${name}"><number:currency-symbol>${xml(n.symbol)}</number:currency-symbol>${num}</number:currency-style>`
          : n.kind === 'percent'
            ? `<number:percentage-style style:name="${name}">${num}<number:text>%</number:text></number:percentage-style>`
            : `<number:number-style style:name="${name}">${num}</number:number-style>`);
      }
      return dataStyles.get(key);
    };
    const cellStyle = (c) => {
      const props = (c.bold || c.italic || c.color ? `<style:text-properties${c.bold ? ' fo:font-weight="bold"' : ''}${c.italic ? ' fo:font-style="italic"' : ''}${c.color ? ` fo:color="#${c.color}"` : ''}/>` : '') +
        (c.bg ? `<style:table-cell-properties fo:background-color="#${c.bg}"/>` : '') +
        (!c.num && c.text.length > 60 ? '<style:table-cell-properties fo:wrap-option="wrap"/>' : '');
      const ds = c.num ? dataStyle(c.num) : null;
      if (!props && !ds) return null;
      const key = (ds || '') + props;
      if (!st.map.has('cell|' + key)) {
        const name = 'ce' + (st.list.filter((s) => s.prefix === 'ce').length + 1);
        st.map.set('cell|' + key, name);
        st.list.push({ prefix: 'ce', name, xml: `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${ds ? ` style:data-style-name="${ds}"` : ''}>${props}</style:style>` });
      }
      return st.map.get('cell|' + key);
    };
    const tables = sheets.map((sh) => {
      const widths = colWidths(sh.rows);
      const cols = widths.map((w) => `<table:table-column table:style-name="${st.get('co', 'table-column', `<style:table-column-properties style:column-width="${(w * 0.075).toFixed(3)}in"/>`)}"/>`).join('');
      const rows = sh.rows.map((r) => '<table:table-row>' + (r.length ? Array.from({ length: r.length }, (_, ci) => {
        const c = r[ci];
        if (!c || !c.text) return '<table:table-cell/>';
        const s = cellStyle(c);
        const sAttr = s ? ` table:style-name="${s}"` : '';
        if (c.num) {
          const n = c.num;
          const type = n.kind === 'currency' ? `office:value-type="currency" office:currency="${{ $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' }[n.symbol]}"` : n.kind === 'percent' ? 'office:value-type="percentage"' : 'office:value-type="float"';
          return `<table:table-cell${sAttr} ${type} office:value="${n.value}"><text:p>${xml(c.text)}</text:p></table:table-cell>`;
        }
        return `<table:table-cell${sAttr} office:value-type="string"><text:p>${xml(c.text)}</text:p></table:table-cell>`;
      }).join('') : '<table:table-cell/>') + '</table:table-row>').join('');
      return `<table:table table:name="${xml(sh.name)}">${cols}${rows}</table:table>`;
    });
    const content = XML_HEAD + `<office:document-content ${ODF_NS}><office:automatic-styles>${dataStyleXml.join('')}${st.xml()}</office:automatic-styles>` +
      `<office:body><office:spreadsheet>${tables.join('')}</office:spreadsheet></office:body></office:document-content>`;
    const files = {
      mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
      'content.xml': content,
      'styles.xml': XML_HEAD + `<office:document-styles ${ODF_NS}><office:styles><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`,
      'meta.xml': XML_HEAD + `<office:document-meta ${ODF_NS}><office:meta><meta:generator>PDF Editor</meta:generator></office:meta></office:document-meta>`,
      'META-INF/manifest.xml': XML_HEAD + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
        '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    };
    return new Blob([zip(files)], { type: 'application/vnd.oasis.opendocument.spreadsheet' });
  }

  function toCsv(doc) {
    const esc = (v) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const out = [];
    sheetsOf(doc).forEach((sh, i) => {
      if (i > 0) out.push('');
      for (const r of sh.rows) out.push(Array.from({ length: r.length }, (_, k) => esc((r[k] && r[k].text) || '')).join(','));
    });
    return new Blob(['﻿' + out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  }

  // ======================================================================
  // Zip writer (no compression; Office and ODF accept it). Files are
  // written in the given order, so ODF's "mimetype" goes first as required.
  // ======================================================================
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const nameBytes = enc.encode(name);
      const data = typeof content === 'string' ? enc.encode(content) : content;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cenSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
  }

  // ======================================================================
  // Entry point
  // ======================================================================
  const WRITERS = { docx: toDocx, odt: toOdt, xlsx: toXlsx, ods: toOds, csv: toCsv };

  // options: format, images (true), skip(pageIndex, x, y, text), onProgress(done, total)
  async function convert(pdfBytes, options = {}) {
    const { format = 'docx', onProgress = () => {} } = options;
    const writer = WRITERS[format];
    if (!writer) throw new Error('Unknown format: ' + format);
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    try {
      const pages = [];
      const wantImages = options.images !== false && (format === 'docx' || format === 'odt');
      for (let n = 1; n <= pdf.numPages; n++) {
        onProgress(n - 1, pdf.numPages);
        const raw = await readPage(await pdf.getPage(n), n - 1, { skip: options.skip, images: wantImages });
        const page = layoutPage(raw);
        delete raw.px; // free the page picture
        pages.push(page);
      }
      onProgress(pdf.numPages, pdf.numPages);
      const doc = { pages, body: bodySize(pages), font: bodyFont(pages) };
      if (!pages.some((p) => p.lines.length)) {
        const err = new Error('No text found. This looks like a scanned PDF (pictures of text).');
        err.code = 'no-text';
        throw err;
      }
      return writer(doc);
    } finally {
      pdf.destroy();
    }
  }

  window.PdfConvert = { convert, zip, FORMATS: Object.keys(WRITERS), _internal: { parseNumber, layoutPage } };
})();
