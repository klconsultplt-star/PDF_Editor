/* Make PDFs smaller.
 *
 * Most of a PDF's size is usually pictures (photos, scans, screenshots), so:
 *   1. Find how large each picture is actually shown on the page, by
 *      following the page's drawing instructions.
 *   2. Pictures with more detail than the chosen quality needs are shrunk
 *      to that resolution and saved again (JPEG for photos and scans, or
 *      lossless compression when that is smaller); a picture is only
 *      replaced when the result is clearly smaller.
 *   3. Leftovers are removed (page thumbnails, private editing data of
 *      other programs, unused objects) and the file is repacked with qpdf
 *      using the strongest lossless compression.
 * The result is never larger than the original.
 *
 *   const r = await PdfCompress.compress(bytes, { preset: 'balanced' });
 *   // r.bytes, r.before, r.after, r.pictures = { total, changed }
 */
(() => {
  'use strict';

  const PRESETS = {
    high: { label: 'High quality', dpi: 300, quality: 0.85 },
    balanced: { label: 'Balanced', dpi: 150, quality: 0.75 },
    small: { label: 'Smallest', dpi: 96, quality: 0.6 },
  };
  const MIN_PIXELS = 40000; // tiny pictures (icons, logos) aren't worth it

  // ---------------------------------------------------------------------
  // 1. How big is each picture shown? (follow the drawing instructions)
  // ---------------------------------------------------------------------
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

  // Splits a content stream into operands and operators. Strings, arrays,
  // dictionaries and inline pictures are skipped over (not needed here).
  function* tokens(s) {
    const n = s.length;
    let i = 0;
    const isSpace = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }
      if (c === 37) { while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; continue; } // % comment
      if (c === 40) { // (string), with nesting and escapes
        let depth = 1; i++;
        while (i < n && depth) { const d = s.charCodeAt(i); if (d === 92) i++; else if (d === 40) depth++; else if (d === 41) depth--; i++; }
        yield { t: 'other' }; continue;
      }
      if (c === 60 && s.charCodeAt(i + 1) === 60) { i += 2; yield { t: 'dict<' }; continue; }
      if (c === 62 && s.charCodeAt(i + 1) === 62) { i += 2; yield { t: 'dict>' }; continue; }
      if (c === 60) { const j = s.indexOf('>', i); i = j < 0 ? n : j + 1; yield { t: 'other' }; continue; } // <hex>
      if (c === 91 || c === 93 || c === 123 || c === 125) { i++; yield { t: c === 91 ? 'arr<' : c === 93 ? 'arr>' : 'other' }; continue; }
      if (c === 47) { let j = i + 1; while (j < n && !isSpace(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++; yield { t: 'name', v: s.slice(i + 1, j) }; i = j; continue; }
      let j = i; while (j < n && !isSpace(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
      if (j === i) { i++; continue; }
      const word = s.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { t: 'num', v: parseFloat(word) }; continue; }
      if (word === 'ID') { // inline picture data: skip to "EI"
        const m = /\sEI(?=[\s/[<(]|$)/g; m.lastIndex = i; const r = m.exec(s); i = r ? r.index + 3 : n; yield { t: 'op', v: 'EI' }; continue;
      }
      yield { t: 'op', v: word };
    }
  }

  // Map "picture object" -> largest size (points) it is drawn at.
  function measureImages(doc) {
    const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
    const shown = new Map(); // ref string -> { w, h }
    const ctx = doc.context;
    const streamText = (obj) => {
      try { return new TextDecoder('latin1').decode(decodePDFRawStream(obj).decode()); } catch { return ''; }
    };
    const walk = (content, resources, start, depth) => {
      if (depth > 8) return;
      const xobjects = resources && ctx.lookup(resources.get(PDFName.of('XObject')));
      let ctm = start.slice();
      const stack = [];
      let ops = [];
      for (const tok of tokens(content)) {
        if (tok.t === 'num' || tok.t === 'name') { ops.push(tok); continue; }
        if (tok.t !== 'op') { if (tok.t !== 'other') ops = []; continue; }
        const op = tok.v;
        if (op === 'q') stack.push(ctm);
        else if (op === 'Q') ctm = stack.pop() || ctm;
        else if (op === 'cm' && ops.length >= 6) ctm = mul(ctm, ops.slice(-6).map((o) => o.v));
        else if (op === 'Do' && ops.length && ops[ops.length - 1].t === 'name' && xobjects instanceof PDFDict) {
          const ref = xobjects.get(PDFName.of(ops[ops.length - 1].v));
          const obj = ctx.lookup(ref);
          if (obj instanceof PDFRawStream) {
            const sub = obj.dict.get(PDFName.of('Subtype'));
            if (sub && sub.toString() === '/Image') {
              const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
              const key = ref.toString();
              const prev = shown.get(key);
              if (!prev || w * h > prev.w * prev.h) shown.set(key, { w, h });
            } else if (sub && sub.toString() === '/Form') {
              const mArr = obj.dict.get(PDFName.of('Matrix'));
              const m = mArr instanceof PDFArray ? mArr.asArray().map((x) => x.asNumber()) : [1, 0, 0, 1, 0, 0];
              const res = ctx.lookup(obj.dict.get(PDFName.of('Resources'))) || resources;
              walk(streamText(obj), res, mul(ctm, m), depth + 1);
            }
          }
        }
        ops = [];
      }
    };
    for (const page of doc.getPages()) {
      const node = page.node;
      const contents = ctx.lookup(node.get(PDFName.of('Contents')));
      const parts = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
      const text = parts.filter((p) => p instanceof PDFRawStream).map(streamText).join('\n');
      walk(text, node.Resources(), [1, 0, 0, 1, 0, 0], 0);
    }
    return shown;
  }

  // ---------------------------------------------------------------------
  // 2. Read a picture's pixels
  // ---------------------------------------------------------------------
  const nameOf = (o) => (o && o.toString ? o.toString() : '');

  // Undo the "PNG predictor" (a way of storing pixels as differences).
  function unpredict(data, columns, colors, predictor) {
    if (predictor < 10) return predictor === 1 ? data : null; // TIFF predictor: not supported
    const row = columns * colors;
    const rows = Math.floor(data.length / (row + 1));
    const out = new Uint8Array(rows * row);
    for (let y = 0; y < rows; y++) {
      const type = data[y * (row + 1)];
      const src = y * (row + 1) + 1, dst = y * row;
      for (let x = 0; x < row; x++) {
        const raw = data[src + x];
        const a = x >= colors ? out[dst + x - colors] : 0;
        const b = y ? out[dst - row + x] : 0;
        const c = y && x >= colors ? out[dst - row + x - colors] : 0;
        let v;
        if (type === 0) v = raw;
        else if (type === 1) v = raw + a;
        else if (type === 2) v = raw + b;
        else if (type === 3) v = raw + ((a + b) >> 1);
        else if (type === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        else return null;
        out[dst + x] = v & 255;
      }
    }
    return out;
  }

  // Returns { canvas, gray } or null when this kind of picture is left alone.
  async function readPixels(doc, stream) {
    const { PDFName, PDFArray, PDFDict, decodePDFRawStream } = PDFLib;
    const d = stream.dict;
    const ctx = doc.context;
    const W = d.get(PDFName.of('Width')), H = d.get(PDFName.of('Height'));
    const w = W && W.asNumber(), h = H && H.asNumber();
    if (!w || !h || w * h < MIN_PIXELS) return null;
    if (d.get(PDFName.of('ImageMask')) || d.get(PDFName.of('Decode')) || d.get(PDFName.of('Mask'))) return null;
    let filters = d.get(PDFName.of('Filter'));
    filters = filters instanceof PDFArray ? filters.asArray().map(nameOf) : filters ? [nameOf(filters)] : [];
    const bpc = d.get(PDFName.of('BitsPerComponent'));
    let cs = ctx.lookup(d.get(PDFName.of('ColorSpace')));
    // Colour space → number of channels (and a palette for "Indexed").
    let channels = 0, palette = null, gray = false;
    const fromSpace = (space) => {
      const nm = nameOf(space);
      if (nm === '/DeviceRGB' || nm === '/CalRGB') return 3;
      if (nm === '/DeviceGray' || nm === '/CalGray') return 1;
      if (space instanceof PDFArray) {
        const kind = nameOf(space.get(0));
        if (kind === '/ICCBased') { const icc = ctx.lookup(space.get(1)); const N = icc && icc.dict.get(PDFName.of('N')); const n = N ? N.asNumber() : 0; return n === 1 || n === 3 ? n : 0; }
        if (kind === '/CalRGB') return 3;
        if (kind === '/CalGray') return 1;
      }
      return 0;
    };
    if (cs instanceof PDFArray && nameOf(cs.get(0)) === '/Indexed') {
      const base = fromSpace(ctx.lookup(cs.get(1)));
      if (base !== 3 && base !== 1) return null;
      const lookup = ctx.lookup(cs.get(3));
      const table = lookup && lookup.contents ? (lookup.dict ? decodePDFRawStream(lookup).decode() : lookup.contents) : lookup && lookup.asBytes ? lookup.asBytes() : null;
      if (!table) return null;
      palette = { base, table };
      channels = 1;
    } else {
      channels = fromSpace(cs);
      if (!channels) return null; // CMYK, Lab, spot colours: leave alone
    }
    gray = !palette && channels === 1;

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    if (filters.length === 1 && filters[0] === '/DCTDecode') {
      if (palette) return null;
      try {
        const bmp = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
        g.drawImage(bmp, 0, 0, w, h);
        bmp.close();
      } catch { return null; }
      return { canvas, gray };
    }
    if (filters.some((f) => !['/FlateDecode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode'].includes(f))) return null; // JBIG2, JPEG 2000, fax…
    if (!bpc || bpc.asNumber() !== 8) return null;
    let raw;
    try { raw = decodePDFRawStream(stream).decode(); } catch { return null; }
    const parms = ctx.lookup(d.get(PDFName.of('DecodeParms')));
    const pd = parms instanceof PDFArray ? ctx.lookup(parms.get(parms.size() - 1)) : parms;
    if (pd instanceof PDFDict && pd.get(PDFName.of('Predictor'))) {
      const P = pd.get(PDFName.of('Predictor')).asNumber();
      const Cols = pd.get(PDFName.of('Columns')) ? pd.get(PDFName.of('Columns')).asNumber() : w;
      const Col = pd.get(PDFName.of('Colors')) ? pd.get(PDFName.of('Colors')).asNumber() : channels;
      raw = unpredict(raw, Cols, Col, P);
      if (!raw) return null;
    }
    if (raw.length < w * h * channels) return null;
    const img = g.createImageData(w, h);
    const px = img.data;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      if (palette) {
        const k = raw[i] * palette.base;
        if (palette.base === 3) { px[j] = palette.table[k]; px[j + 1] = palette.table[k + 1]; px[j + 2] = palette.table[k + 2]; }
        else px[j] = px[j + 1] = px[j + 2] = palette.table[k];
      } else if (channels === 3) { px[j] = raw[i * 3]; px[j + 1] = raw[i * 3 + 1]; px[j + 2] = raw[i * 3 + 2]; }
      else px[j] = px[j + 1] = px[j + 2] = raw[i];
      px[j + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return { canvas, gray };
  }

  // ---------------------------------------------------------------------
  // 3. Shrink and re-save a picture
  // ---------------------------------------------------------------------
  // High-quality downscaling: halve repeatedly, then the final step.
  function resize(src, w, h) {
    let cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      const half = document.createElement('canvas');
      half.width = Math.round(cur.width / 2); half.height = Math.round(cur.height / 2);
      const g = half.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    if (cur.width === w && cur.height === h) return cur;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, w, h);
    return out;
  }

  async function deflate(bytes) {
    const cs = new CompressionStream('deflate'); // zlib format, as PDF expects
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  }

  // Candidate encodings; returns the smallest { bytes, filter, gray }.
  async function encode(canvas, gray, quality) {
    const jpegBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    const candidates = [{ bytes: new Uint8Array(await jpegBlob.arrayBuffer()), filter: 'DCTDecode', gray: false }];
    // Lossless is better for screenshots, diagrams and grey pictures with few tones.
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const n = canvas.width * canvas.height;
    let isGray = true;
    for (let i = 0; i < data.length; i += 16) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) { isGray = false; break; }
    const ch = isGray ? 1 : 3;
    const raw = new Uint8Array(n * ch);
    for (let i = 0, j = 0; i < n; i++, j += 4) { if (ch === 1) raw[i] = data[j]; else { raw[i * 3] = data[j]; raw[i * 3 + 1] = data[j + 1]; raw[i * 3 + 2] = data[j + 2]; } }
    candidates.push({ bytes: await deflate(raw), filter: 'FlateDecode', gray: isGray });
    return candidates.sort((a, b) => a.bytes.length - b.bytes.length)[0];
  }

  // ---------------------------------------------------------------------
  // 4. Whole file
  // ---------------------------------------------------------------------
  function dropLeftovers(doc) {
    const { PDFName } = PDFLib;
    let removed = 0;
    for (const page of doc.getPages()) {
      for (const key of ['Thumb', 'PieceInfo']) if (page.node.has(PDFName.of(key))) { page.node.delete(PDFName.of(key)); removed++; }
    }
    if (doc.catalog.has(PDFName.of('PieceInfo'))) { doc.catalog.delete(PDFName.of('PieceInfo')); removed++; }
    return removed;
  }

  async function compress(input, { preset = 'balanced', onProgress = () => {}, shouldStop = () => false } = {}) {
    const { PDFDocument, PDFName, PDFRawStream, PDFNumber } = PDFLib;
    const opts = PRESETS[preset] || PRESETS.balanced;
    const before = input.length;
    let doc;
    try {
      doc = await PDFDocument.load(input, { updateMetadata: false });
    } catch (err) {
      if (/encrypt/i.test(String(err && err.message))) err.code = 'encrypted';
      throw err;
    }
    const stop = () => { if (shouldStop()) { const e = new Error('Stopped'); e.code = 'stopped'; throw e; } };
    const shown = measureImages(doc);
    const images = [];
    const masks = new Set(); // transparency masks stay exact (JPEG would blur their edges)
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && nameOf(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
        images.push([ref, obj]);
        const sm = obj.dict.get(PDFName.of('SMask'));
        if (sm) masks.add(sm.toString());
      }
    }
    let changed = 0;
    for (let k = 0; k < images.length; k++) {
      stop();
      onProgress(k / Math.max(1, images.length), `picture ${k + 1} of ${images.length}`);
      const [ref, stream] = images[k];
      if (masks.has(ref.toString())) continue;
      const pic = await readPixels(doc, stream);
      if (!pic) continue;
      const { canvas } = pic;
      // Resolution needed: the picture's pixels per inch as shown on the page.
      let scale = 1;
      const size = shown.get(ref.toString());
      if (size && size.w > 0 && size.h > 0) {
        const dpi = Math.min(canvas.width / (size.w / 72), canvas.height / (size.h / 72));
        if (dpi > opts.dpi * 1.2) scale = opts.dpi / dpi;
      }
      const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
      const small = scale < 1 ? resize(canvas, w, h) : canvas;
      const enc = await encode(small, pic.gray, opts.quality);
      if (enc.bytes.length > stream.contents.length * 0.9) continue; // not worth it
      const old = stream.dict;
      const dict = doc.context.obj({
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8,
        ColorSpace: enc.gray ? 'DeviceGray' : 'DeviceRGB', Filter: enc.filter,
      });
      for (const key of ['SMask', 'Intent', 'Interpolate', 'Metadata', 'OC', 'Alternates']) {
        const v = old.get(PDFName.of(key));
        if (v) dict.set(PDFName.of(key), v);
      }
      dict.set(PDFName.of('Length'), PDFNumber.of(enc.bytes.length));
      doc.context.assign(ref, PDFRawStream.of(dict, enc.bytes));
      changed++;
    }
    stop();
    dropLeftovers(doc);
    onProgress(1, 'packing the file');
    let out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    // Lossless repack: strongest compression, unused objects dropped.
    try {
      out = await PdfSecurity.run(['/in.pdf', '--object-streams=generate', '--recompress-flate', '--compression-level=9', '--remove-unreferenced-resources=yes', '/out.pdf'], out);
    } catch (err) { console.warn('Repack skipped:', err.message); }
    if (out.length >= before) out = input; // never make it bigger
    return { bytes: out, before, after: out.length, pictures: { total: images.length, changed } };
  }

  window.PdfCompress = { PRESETS, compress };
})();
