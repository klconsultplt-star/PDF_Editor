/* Remove original text from a page: the letters really leave the file.
 *
 * Used by Edit text (the old words are deleted, not just covered) and by
 * Whiteout (text under a white box is deleted too, so it can't be copied
 * out of the saved PDF).
 *
 * How: the page's drawing instructions are read, and for every letter the
 * position on the page is worked out (following the text matrices, font
 * size, character and word spacing and the letter widths from the font).
 * Letters whose centre falls inside an area are deleted from the text
 * instruction and replaced by an equal-width gap, so everything else on the
 * line stays exactly where it was. Text inside reusable drawings ("form
 * XObjects") is handled by writing a changed copy for this page only.
 *
 *   const result = PdfRedact.removeText(doc, page, [ (x, y) => inside?, … ]);
 *   // result[i] = { removed, unsure, invisible } for each area
 *   // unsure: some text there couldn't be measured (unusual font encoding)
 *   //         and was left in place; invisible: hidden text was removed
 *   //         (e.g. the text layer of a scan made by another program).
 */
(() => {
  'use strict';

  // Matrix product: apply m first, then n. A point (x, y) maps to
  // (a x + c y + e, b x + d y + f).
  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const ID = [1, 0, 0, 1, 0, 0];

  // ---------------------------------------------------------------------
  // Reading the drawing instructions
  // ---------------------------------------------------------------------
  const SPACE = new Uint8Array(256);
  for (const c of [0, 9, 10, 12, 13, 32]) SPACE[c] = 1;
  const DELIM = new Uint8Array(256);
  for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

  // Tokens: { t: 'num'|'name'|'str'|'op'|'['|']'|'dict', v, s (start), e (end) }.
  // Strings are returned as "binary strings" (one char per byte).
  function tokenize(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (SPACE[c]) { i++; continue; }
      const s = i;
      if (c === 37) { while (i < n && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) i++; continue; } // % comment
      if (c === 40) { // (literal string)
        let depth = 1, str = '';
        i++;
        while (i < n) {
          let d = src.charCodeAt(i);
          if (d === 92) { // backslash escape
            i++;
            d = src.charCodeAt(i);
            const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
            if (map[d] !== undefined) { str += String.fromCharCode(map[d]); i++; }
            else if (d >= 48 && d <= 55) {
              let k = 0, v = 0;
              while (k < 3 && i < n && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 55) { v = v * 8 + src.charCodeAt(i) - 48; i++; k++; }
              str += String.fromCharCode(v & 255);
            } else if (d === 13) { i++; if (src.charCodeAt(i) === 10) i++; } // line continuation
            else if (d === 10) i++;
            else { str += src[i]; i++; }
            continue;
          }
          if (d === 40) depth++;
          else if (d === 41 && --depth === 0) { i++; break; }
          str += src[i];
          i++;
        }
        out.push({ t: 'str', v: str, s, e: i });
        continue;
      }
      if (c === 60 && src.charCodeAt(i + 1) === 60) { // << dictionary >>: skipped as one token
        let depth = 0;
        while (i < n) {
          if (src.charCodeAt(i) === 60 && src.charCodeAt(i + 1) === 60) { depth++; i += 2; continue; }
          if (src.charCodeAt(i) === 62 && src.charCodeAt(i + 1) === 62) { depth--; i += 2; if (!depth) break; continue; }
          if (src.charCodeAt(i) === 40) { // skip strings inside (they may contain >>)
            let d = 1; i++;
            while (i < n && d) { const x = src.charCodeAt(i); if (x === 92) i++; else if (x === 40) d++; else if (x === 41) d--; i++; }
            continue;
          }
          i++;
        }
        out.push({ t: 'dict', s, e: i });
        continue;
      }
      if (c === 60) { // <hex string>
        const j = src.indexOf('>', i);
        const end = j < 0 ? n : j;
        let hex = src.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
        if (hex.length % 2) hex += '0';
        let str = '';
        for (let k = 0; k < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
        i = end + 1;
        out.push({ t: 'str', v: str, s, e: i });
        continue;
      }
      if (c === 91 || c === 93) { out.push({ t: src[i], s, e: i + 1 }); i++; continue; }
      if (c === 123 || c === 125 || c === 62 || c === 41) { i++; continue; }
      if (c === 47) { // /Name
        i++;
        while (i < n && !SPACE[src.charCodeAt(i)] && !DELIM[src.charCodeAt(i)]) i++;
        out.push({ t: 'name', v: src.slice(s + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), s, e: i });
        continue;
      }
      while (i < n && !SPACE[src.charCodeAt(i)] && !DELIM[src.charCodeAt(i)]) i++;
      const word = src.slice(s, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { out.push({ t: 'num', v: parseFloat(word), s, e: i }); continue; }
      if (word === 'BI') { // inline image: skip to EI, as one instruction
        const m = /\sEI(?=[\s/[<(%]|$)/g;
        const id = src.indexOf('ID', i);
        m.lastIndex = id < 0 ? i : id + 3;
        const r = m.exec(src);
        i = r ? r.index + 3 : n;
        out.push({ t: 'op', v: 'BI', s, e: i });
        continue;
      }
      out.push({ t: 'op', v: word, s, e: i });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Fonts: how to split a string into letters, and each letter's width
  // ---------------------------------------------------------------------
  const STANDARD = {
    Helvetica: 'Helvetica', 'Helvetica-Bold': 'Helvetica-Bold', 'Helvetica-Oblique': 'Helvetica-Oblique', 'Helvetica-BoldOblique': 'Helvetica-BoldOblique',
    'Times-Roman': 'Times-Roman', 'Times-Bold': 'Times-Bold', 'Times-Italic': 'Times-Italic', 'Times-BoldItalic': 'Times-BoldItalic',
    Courier: 'Courier', 'Courier-Bold': 'Courier-Bold', 'Courier-Oblique': 'Courier-Oblique', 'Courier-BoldOblique': 'Courier-BoldOblique',
    Symbol: 'Symbol', ZapfDingbats: 'ZapfDingbats',
  };
  // Common names for the same fonts (used only when a font lists no widths).
  function standardName(base) {
    let b = base.replace(/^[A-Z]{6}\+/, '');
    if (STANDARD[b]) return b;
    const bold = /bold|black|heavy/i.test(b), italic = /italic|oblique/i.test(b);
    let family = 'Helvetica';
    if (/times|roman|serif|georgia|garamond/i.test(b) && !/sans/i.test(b)) family = 'Times';
    else if (/courier|mono/i.test(b)) family = 'Courier';
    else if (/symbol/i.test(b)) return 'Symbol';
    else if (/dingbat/i.test(b)) return 'ZapfDingbats';
    if (family === 'Times') return 'Times-' + (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Roman');
    const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
    return family + suffix;
  }

  // code -> glyph name, from pdf-lib's built-in encodings.
  const encodingCache = {};
  function builtinEncoding(name) {
    if (encodingCache[name]) return encodingCache[name];
    const fontFor = name === 'Symbol' ? 'Symbol' : name === 'ZapfDingbats' ? 'ZapfDingbats' : 'Helvetica';
    const enc = PDFLib.StandardFontEmbedder.for(fontFor).encoding; // WinAnsi, Symbol or ZapfDingbats
    const table = [];
    for (const m of Object.values(enc.unicodeMappings)) { // [code, glyph name]
      const [code, glyph] = Array.isArray(m) ? m : [m.code, m.name];
      if (table[code] === undefined) table[code] = glyph;
    }
    if (name === 'StandardEncoding') { table[0x27] = 'quoteright'; table[0x60] = 'quoteleft'; }
    return (encodingCache[name] = table);
  }

  function parseCidWidths(ctx, W) {
    const widths = new Map();
    if (!(W instanceof PDFLib.PDFArray)) return widths;
    const a = W.asArray().map((x) => ctx.lookup(x));
    for (let i = 0; i < a.length;) {
      const first = a[i].asNumber ? a[i].asNumber() : NaN;
      const next = a[i + 1];
      if (next instanceof PDFLib.PDFArray) {
        next.asArray().forEach((w, k) => widths.set(first + k, ctx.lookup(w).asNumber()));
        i += 2;
      } else {
        const last = next.asNumber(), w = ctx.lookup(a[i + 2]).asNumber();
        for (let c = first; c <= last; c++) widths.set(c, w);
        i += 3;
      }
    }
    return widths;
  }

  // An embedded CMap: code lengths (codespace ranges) and code -> CID.
  function parseCMap(text) {
    const hex = (h) => parseInt(h, 16);
    const spaces = [];
    for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) spaces.push({ len: m[1].length / 2, lo: hex(m[1]), hi: hex(m[2]) });
    }
    const ranges = [];
    for (const block of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) ranges.push([hex(m[1]), hex(m[2]), +m[3]]);
    }
    const singles = new Map();
    for (const block of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) singles.set(hex(m[1]), +m[2]);
    }
    if (!spaces.length) return null;
    return {
      spaces,
      cid(code) {
        if (singles.has(code)) return singles.get(code);
        for (const [lo, hi, start] of ranges) if (code >= lo && code <= hi) return start + code - lo;
        return 0;
      },
    };
  }

  // A PDF name or string as plain text ('/Identity-H' -> 'Identity-H').
  const name = (o) => (o instanceof PDFLib.PDFName ? o.decodeText() : o && o.decodeText ? o.decodeText() : o ? String(o).replace(/^\//, '') : '');

  // Returns { split(str) -> [{ bytes, w, space }], ok, vertical }.
  // w is the advance in text space for a font size of 1.
  function fontInfo(ctx, fontDict) {
    const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, decodePDFRawStream } = PDFLib;
    const get = (d, k) => (d ? ctx.lookup(d.get(PDFName.of(k))) : undefined);
    const num = (o, dflt) => (o instanceof PDFNumber ? o.asNumber() : dflt);
    const sub = name(get(fontDict, 'Subtype'));
    if (sub === 'Type0') {
      const encObj = get(fontDict, 'Encoding');
      const encName = encObj instanceof PDFRawStream ? '' : name(encObj);
      let cmap = null, vertical = false;
      if (encName === 'Identity-H' || encName === 'Identity-V') {
        vertical = encName === 'Identity-V';
        cmap = { spaces: [{ len: 2, lo: 0, hi: 0xffff }], cid: (c) => c };
      } else if (encObj instanceof PDFRawStream) {
        try {
          const text = new TextDecoder('latin1').decode(decodePDFRawStream(encObj).decode());
          if (/usecmap/.test(text)) return { ok: false };
          cmap = parseCMap(text);
          vertical = num(get(encObj.dict, 'WMode'), 0) === 1 || /\/WMode\s+1/.test(text);
        } catch { cmap = null; }
      }
      if (!cmap) return { ok: false }; // predefined CJK CMaps: not supported here
      const desc = get(fontDict, 'DescendantFonts');
      const cid = desc instanceof PDFArray ? ctx.lookup(desc.get(0)) : null;
      if (!(cid instanceof PDFDict)) return { ok: false };
      const widths = parseCidWidths(ctx, get(cid, 'W'));
      const dw = num(get(cid, 'DW'), 1000);
      return {
        ok: true,
        vertical,
        split(str) {
          const out = [];
          for (let i = 0; i < str.length;) {
            let len = 0, code = 0;
            for (let l = 1; l <= 4 && i + l <= str.length; l++) {
              let c = 0;
              for (let k = 0; k < l; k++) c = c * 256 + str.charCodeAt(i + k);
              if (cmap.spaces.some((s) => s.len === l && c >= s.lo && c <= s.hi)) { len = l; code = c; break; }
            }
            if (!len) { len = Math.min(cmap.spaces[0].len, str.length - i); for (let k = 0; k < len; k++) code = code * 256 + str.charCodeAt(i + k); }
            const id = cmap.cid(code);
            out.push({ bytes: str.substr(i, len), w: (widths.has(id) ? widths.get(id) : dw) / 1000, space: len === 1 && code === 32 });
            i += len;
          }
          return out;
        },
      };
    }
    // Simple fonts: one byte per letter.
    const first = num(get(fontDict, 'FirstChar'), 0);
    const W = get(fontDict, 'Widths');
    let scale = 1 / 1000;
    if (sub === 'Type3') {
      const fm = get(fontDict, 'FontMatrix');
      scale = fm instanceof PDFArray ? num(ctx.lookup(fm.get(0)), 0.001) : 0.001;
    }
    const descriptor = get(fontDict, 'FontDescriptor');
    const missing = num(get(descriptor, 'MissingWidth'), 0);
    let widthOf;
    if (W instanceof PDFArray) {
      const list = W.asArray().map((x) => num(ctx.lookup(x), 0));
      widthOf = (code) => (code >= first && code < first + list.length ? list[code - first] : missing);
    } else if (sub !== 'Type3') {
      // The 14 standard fonts may list no widths: use the standard metrics.
      const std = standardName(name(get(fontDict, 'BaseFont')));
      const metrics = PDFLib.StandardFontEmbedder.for(std).font;
      const encObj = get(fontDict, 'Encoding');
      const baseName = encObj instanceof PDFDict ? name(get(encObj, 'BaseEncoding')) : name(encObj);
      const table = builtinEncoding(std === 'Symbol' || std === 'ZapfDingbats' ? std : baseName || 'StandardEncoding').slice();
      const diffs = encObj instanceof PDFDict ? get(encObj, 'Differences') : null;
      if (diffs instanceof PDFArray) {
        let code = 0;
        for (const item of diffs.asArray().map((x) => ctx.lookup(x))) {
          if (item instanceof PDFNumber) code = item.asNumber();
          else table[code++] = name(item);
        }
      }
      widthOf = (code) => {
        const g = table[code];
        let w = 0;
        try { w = g ? metrics.getWidthOfGlyph(g) : 0; } catch { w = 0; }
        return w || missing;
      };
    } else {
      return { ok: false };
    }
    return {
      ok: true,
      vertical: false,
      split(str) {
        const out = [];
        for (let i = 0; i < str.length; i++) {
          const code = str.charCodeAt(i);
          out.push({ bytes: str[i], w: widthOf(code) * scale, space: code === 32 });
        }
        return out;
      },
    };
  }

  // ---------------------------------------------------------------------
  // Following the instructions and rewriting the text ones
  // ---------------------------------------------------------------------
  const fmt = (v) => {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? '0' : String(r);
  };
  const hexOf = (str) => {
    let h = '<';
    for (let i = 0; i < str.length; i++) h += str.charCodeAt(i).toString(16).padStart(2, '0');
    return h + '>';
  };

  function streamText(stream) {
    return new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(stream).decode());
  }
  const toBytes = (str) => {
    const b = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 255;
    return b;
  };

  function removeText(doc, page, areas) {
    const { PDFName, PDFArray, PDFDict, PDFRawStream } = PDFLib;
    const ctx = doc.context;
    const results = areas.map(() => ({ removed: 0, unsure: false, invisible: false }));
    if (!areas.length) return results;
    const fonts = new Map(); // font dict -> info
    let formCount = 0;

    const lookup = (dict, key) => (dict instanceof PDFDict ? ctx.lookup(dict.get(PDFName.of(key))) : undefined);
    const fontFor = (resources, fontName) => {
      const dict = lookup(lookup(resources, 'Font'), fontName);
      if (!(dict instanceof PDFDict)) return { ok: false };
      if (!fonts.has(dict)) {
        let info;
        try { info = fontInfo(ctx, dict); } catch (err) { console.warn('Font not readable', err); info = { ok: false }; }
        fonts.set(dict, info);
      }
      return fonts.get(dict);
    };

    // Returns { text, xobjects: Map(newName -> ref) } when something changed, else null.
    function process(src, resources, ctm0, gs0, depth) {
      const toks = tokenize(src);
      let gs = { ...gs0, ctm: ctm0 };
      const stack = [];
      let tm = ID, tlm = ID;
      const edits = []; // { s, e, text }
      const newXObjects = new Map();
      let operands = [];
      let arr = null; // collecting an array operand

      // Show one string (or a TJ array); returns replacement TJ elements if something was removed.
      const show = (items) => {
        const font = gs.font ? fontFor(resources, gs.font) : { ok: false };
        const fs = gs.fs, th = gs.th;
        const elements = []; // kept strings and gaps
        let changed = false;
        const pushStr = (bytes) => {
          const last = elements[elements.length - 1];
          if (typeof last === 'string') elements[elements.length - 1] = last + bytes; else elements.push(bytes);
        };
        const pushGap = (n) => {
          if (Math.abs(n) < 1e-9) return;
          const last = elements[elements.length - 1];
          if (typeof last === 'number') elements[elements.length - 1] = last + n; else elements.push(n);
        };
        for (const item of items) {
          if (typeof item === 'number') {
            pushGap(item);
            tm = mul([1, 0, 0, 1, (-item / 1000) * fs * th, 0], tm);
            continue;
          }
          if (!font.ok || font.vertical) {
            // Can't measure: note any area this text seems to fall in, keep it.
            const trm = mul(mul([fs * th, 0, 0, fs, 0, gs.rise], tm), gs.ctm);
            const [x, y] = apply(trm, 0.25, 0.3);
            areas.forEach((inside, k) => { if (inside(x, y)) results[k].unsure = true; });
            pushStr(item);
            tm = mul([1, 0, 0, 1, item.length * 0.5 * fs * th, 0], tm); // rough guess
            continue;
          }
          for (const g of font.split(item)) {
            const trm = mul(mul([fs * th, 0, 0, fs, 0, gs.rise], tm), gs.ctm);
            const [x, y] = apply(trm, g.w / 2, 0.3);
            const advance = (g.w * fs + gs.tc + (g.space ? gs.tw : 0)) * th;
            const hit = areas.findIndex((inside) => inside(x, y));
            if (hit >= 0 && fs) {
              results[hit].removed++;
              if (gs.tr === 3 || gs.tr === 7) results[hit].invisible = true;
              pushGap((-advance / th / fs) * 1000);
              changed = true;
            } else {
              pushStr(g.bytes);
            }
            tm = mul([1, 0, 0, 1, advance, 0], tm);
          }
        }
        return changed ? elements : null;
      };
      const tjText = (elements) => '[' + elements.map((e) => (typeof e === 'number' ? fmt(e) : hexOf(e))).join(' ') + '] TJ';

      let opStart = 0; // where the current instruction's operands begin
      for (let t = 0; t < toks.length; t++) {
        const tok = toks[t];
        if (operands.length === 0 && !arr) opStart = tok.s;
        if (tok.t === '[') { arr = []; continue; }
        if (tok.t === ']') { operands.push({ t: 'arr', v: arr || [] }); arr = null; continue; }
        if (arr) { if (tok.t === 'num') arr.push(tok.v); else if (tok.t === 'str') arr.push(tok.v); continue; }
        if (tok.t !== 'op') { operands.push(tok); continue; }
        const op = tok.v;
        const nums = operands.filter((o) => o.t === 'num').map((o) => o.v);
        const lastStr = [...operands].reverse().find((o) => o.t === 'str');
        switch (op) {
          case 'q': stack.push(gs); gs = { ...gs }; break;
          case 'Q': gs = stack.pop() || gs; break;
          case 'cm': if (nums.length >= 6) gs.ctm = mul(nums.slice(-6), gs.ctm); break;
          case 'BT': tm = tlm = ID; break;
          case 'Tm': if (nums.length >= 6) tm = tlm = nums.slice(-6); break;
          case 'Td': if (nums.length >= 2) tm = tlm = mul([1, 0, 0, 1, nums[0], nums[1]], tlm); break;
          case 'TD': if (nums.length >= 2) { gs.tl = -nums[1]; tm = tlm = mul([1, 0, 0, 1, nums[0], nums[1]], tlm); } break;
          case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); break;
          case 'Tc': if (nums.length) gs.tc = nums[0]; break;
          case 'Tw': if (nums.length) gs.tw = nums[0]; break;
          case 'Tz': if (nums.length) gs.th = nums[0] / 100; break;
          case 'TL': if (nums.length) gs.tl = nums[0]; break;
          case 'Ts': if (nums.length) gs.rise = nums[0]; break;
          case 'Tr': if (nums.length) gs.tr = nums[0]; break;
          case 'Tf': {
            const n = operands.find((o) => o.t === 'name');
            if (n) gs.font = n.v;
            if (nums.length) gs.fs = nums[nums.length - 1];
            break;
          }
          case 'Tj': case "'": case '"': {
            if (!lastStr) break;
            let prefix = '';
            if (op === "'") { tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); prefix = 'T* '; }
            if (op === '"' && nums.length >= 2) {
              gs.tw = nums[0]; gs.tc = nums[1];
              tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
              prefix = `${fmt(nums[0])} Tw ${fmt(nums[1])} Tc T* `;
            }
            const elements = show([lastStr.v]);
            if (elements) edits.push({ s: opStart, e: tok.e, text: prefix + tjText(elements) });
            break;
          }
          case 'TJ': {
            const a = operands.find((o) => o.t === 'arr');
            if (!a) break;
            const elements = show(a.v);
            if (elements) edits.push({ s: opStart, e: tok.e, text: tjText(elements) });
            break;
          }
          case 'Do': {
            const n = operands.find((o) => o.t === 'name');
            if (!n || depth > 10) break;
            const xobjects = lookup(resources, 'XObject');
            const ref = xobjects instanceof PDFDict ? xobjects.get(PDFName.of(n.v)) : undefined;
            const form = ctx.lookup(ref);
            if (!(form instanceof PDFRawStream) || name(form.dict.get(PDFName.of('Subtype'))) !== 'Form') break;
            const mArr = lookup(form.dict, 'Matrix');
            const m = mArr instanceof PDFArray ? mArr.asArray().map((x) => ctx.lookup(x).asNumber()) : ID;
            const formRes = lookup(form.dict, 'Resources') || resources;
            let text;
            try { text = streamText(form); } catch { break; }
            const r = process(text, formRes, mul(m, gs.ctm), gs, depth + 1);
            if (!r) break;
            // A changed copy of the drawing, for this place only.
            const copy = ctx.flateStream(toBytes(r.text));
            for (const [k, v] of form.dict.entries()) {
              if (!['Filter', 'DecodeParms', 'Length', 'DL', 'Resources'].includes(name(k))) copy.dict.set(k, v);
            }
            copy.dict.set(PDFName.of('Resources'), withXObjects(formRes, r.xobjects));
            const newName = `${n.v}_e${++formCount}`;
            newXObjects.set(newName, ctx.register(copy));
            edits.push({ s: n.s, e: tok.e, text: `/${newName} Do` });
            break;
          }
          default: break;
        }
        operands = [];
      }
      if (!edits.length) return null;
      let text = '', pos = 0;
      for (const e of edits.sort((a, b) => a.s - b.s)) { text += src.slice(pos, e.s) + e.text; pos = e.e; }
      text += src.slice(pos);
      return { text, xobjects: newXObjects };
    }

    // A copy of a resources dictionary with extra drawings added.
    function withXObjects(resources, extra) {
      const res = resources instanceof PDFDict ? resources.clone(ctx) : ctx.obj({});
      if (extra.size) {
        const old = lookup(res, 'XObject');
        const xo = old instanceof PDFDict ? old.clone(ctx) : ctx.obj({});
        for (const [k, ref] of extra) xo.set(PDFName.of(k), ref);
        res.set(PDFName.of('XObject'), xo);
      }
      return res;
    }

    const node = page.node;
    const contents = ctx.lookup(node.get(PDFName.of('Contents')));
    if (!contents) return results;
    const parts = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
    let src;
    try { src = parts.filter((p) => p instanceof PDFRawStream).map(streamText).join('\n'); } catch (err) { console.warn('Page contents not readable', err); return results; }
    const gs = { ctm: ID, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0, font: null, fs: 0 };
    const r = process(src, node.Resources(), ID, gs, 0);
    if (r) {
      const stream = ctx.flateStream(toBytes(r.text));
      node.set(PDFName.of('Contents'), ctx.register(stream));
      if (r.xobjects.size) node.set(PDFName.of('Resources'), withXObjects(node.Resources(), r.xobjects));
    }
    return results;
  }

  window.PdfRedact = { removeText, tokenize };
})();
