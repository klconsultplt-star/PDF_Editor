/* The text inside a PDF page: read it, delete it, and write new text in the
 * page's own fonts.
 *
 * A PDF page is a list of drawing instructions. For text they say "use font
 * F1 at size 12, move to (72, 700), show these character codes". This file
 * follows those instructions (text position, font size, character and word
 * spacing, scaling, colour, and the letter widths stored in each font), so
 * it knows where every letter is, what it says and how it is styled.
 *
 * With that it can:
 *   - removeText(): delete the letters inside some areas, leaving an equal
 *     gap so nothing else moves (used by Edit text and Whiteout);
 *   - paragraphs(): find the page's lines and paragraphs, with alignment,
 *     line spacing and styled runs (font, size, colour);
 *   - writeParagraph(): lay out edited text inside the paragraph's width
 *     (re-flowing the lines) and write it using the same fonts as the
 *     original. Letters a font doesn't contain (PDFs usually include only
 *     the letters they use) are written in a look-alike font instead.
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
  const rotate = (x, y, deg) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [x * c - y * s, x * s + y * c];
  };
  const isCJK = (ch) => !!ch && /[⺀-⿟　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(ch);

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
  // Fonts: splitting strings into letters, widths, and what each letter says
  // ---------------------------------------------------------------------
  const STANDARD = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
    'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
    'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats']);
  // The closest of the 14 standard fonts (used only when a font lists no widths).
  function standardName(base) {
    const b = base.replace(/^[A-Z]{6}\+/, '');
    if (STANDARD.has(b)) return b;
    const bold = /bold|black|heavy/i.test(b), italic = /italic|oblique/i.test(b);
    if (/symbol/i.test(b)) return 'Symbol';
    if (/dingbat/i.test(b)) return 'ZapfDingbats';
    if (/times|roman|georgia|garamond/i.test(b) || (/serif/i.test(b) && !/sans/i.test(b))) return 'Times-' + (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Roman');
    const family = /courier|mono/i.test(b) ? 'Courier' : 'Helvetica';
    return family + (bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '');
  }

  // code -> glyph name, and glyph name -> character, from pdf-lib's built-in encodings.
  const encodingCache = {};
  let glyphChars = null;
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
  function charOfGlyph(glyph) {
    if (!glyph) return '';
    if (!glyphChars) {
      glyphChars = new Map();
      for (const font of ['Helvetica', 'Symbol']) {
        const enc = PDFLib.StandardFontEmbedder.for(font).encoding;
        for (const [uni, m] of Object.entries(enc.unicodeMappings)) {
          const g = Array.isArray(m) ? m[1] : m.name;
          if (!glyphChars.has(g)) glyphChars.set(g, String.fromCodePoint(+uni));
        }
      }
    }
    if (glyphChars.has(glyph)) return glyphChars.get(glyph);
    let m = /^uni([0-9A-Fa-f]{4,})$/.exec(glyph) || /^u([0-9A-Fa-f]{4,6})$/.exec(glyph);
    if (m) { try { return String.fromCodePoint(parseInt(m[1].slice(0, 6), 16)); } catch { return ''; } }
    if (/^[A-Za-z0-9]$/.test(glyph)) return glyph;
    m = /^([A-Za-z]+)\.\w+$/.exec(glyph); // e.g. "a.sc"
    if (m && glyphChars.has(m[1])) return glyphChars.get(m[1]);
    return '';
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
      } else if (next && a[i + 2]) {
        const last = next.asNumber(), w = a[i + 2].asNumber();
        for (let c = first; c <= last && c - first < 70000; c++) widths.set(c, w);
        i += 3;
      } else break;
    }
    return widths;
  }

  const hexNum = (h) => parseInt(h, 16);
  const utf16 = (hex) => {
    let s = '';
    for (let i = 0; i + 3 < hex.length + 0; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
    return s;
  };

  // An embedded CMap: code lengths (codespace ranges) and code -> CID.
  function parseCMap(text) {
    const spaces = [];
    for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) spaces.push({ len: m[1].length / 2, lo: hexNum(m[1]), hi: hexNum(m[2]) });
    }
    const ranges = [];
    for (const block of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) ranges.push([hexNum(m[1]), hexNum(m[2]), +m[3]]);
    }
    const singles = new Map();
    for (const block of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) singles.set(hexNum(m[1]), +m[2]);
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

  // ToUnicode CMap: code -> text.
  function parseToUnicode(text) {
    const map = new Map();
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hexNum(m[1]), utf16(m[2]));
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
        const lo = hexNum(m[1]), hi = hexNum(m[2]);
        if (hi - lo > 70000) continue;
        if (m[3][0] === '[') {
          const list = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
          for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
        } else {
          const hex = m[3].slice(1, -1);
          const base = utf16(hex);
          if (!base) continue;
          // The last character counts up through the range.
          const head = base.slice(0, -1), last = base.charCodeAt(base.length - 1);
          for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
        }
      }
    }
    return map;
  }

  // A PDF name or string as plain text ('/Identity-H' -> 'Identity-H').
  const name = (o) => (o instanceof PDFLib.PDFName ? o.decodeText() : o && o.decodeText ? o.decodeText() : o ? String(o).replace(/^\//, '') : '');

  // Everything needed about one font:
  //   ok        letters can be measured
  //   split(s)  -> [{ bytes, code, w, space }] (w: advance for a font size of 1)
  //   text(code) what a letter says ('' if unknown)
  //   encode(ch) -> { bytes, w } to write a character in this font, or null
  //   baseFont, bold, italic, serif, mono: for choosing a look-alike font
  function fontInfo(ctx, fontDict) {
    const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, decodePDFRawStream } = PDFLib;
    const get = (d, k) => (d ? ctx.lookup(d.get(PDFName.of(k))) : undefined);
    const num = (o, dflt) => (o instanceof PDFNumber ? o.asNumber() : dflt);
    const sub = name(get(fontDict, 'Subtype'));
    const baseFont = name(get(fontDict, 'BaseFont'));
    let descriptor = get(fontDict, 'FontDescriptor');
    let toUnicode = null;
    const tu = get(fontDict, 'ToUnicode');
    if (tu instanceof PDFRawStream) {
      try { toUnicode = parseToUnicode(new TextDecoder('latin1').decode(decodePDFRawStream(tu).decode())); } catch { toUnicode = null; }
    }
    let info;
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
          if (!/usecmap/.test(text)) {
            cmap = parseCMap(text);
            vertical = num(get(encObj.dict, 'WMode'), 0) === 1 || /\/WMode\s+1/.test(text);
          }
        } catch { cmap = null; }
      }
      const desc = get(fontDict, 'DescendantFonts');
      const cid = desc instanceof PDFArray ? ctx.lookup(desc.get(0)) : null;
      if (!cmap || !(cid instanceof PDFDict)) return { ok: false, baseFont }; // predefined CJK CMaps: not supported here
      descriptor = get(cid, 'FontDescriptor') || descriptor;
      const widths = parseCidWidths(ctx, get(cid, 'W'));
      const dw = num(get(cid, 'DW'), 1000);
      const lenOf = (code) => {
        for (const s of cmap.spaces) if (code >= s.lo && code <= s.hi) return s.len;
        return cmap.spaces[0].len;
      };
      const widthOf = (code) => { const id = cmap.cid(code); return (widths.has(id) ? widths.get(id) : dw) / 1000; };
      info = {
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
            out.push({ bytes: str.substr(i, len), code, w: widthOf(code), space: len === 1 && code === 32 });
            i += len;
          }
          return out;
        },
        text: (code) => (toUnicode && toUnicode.get(code)) || '',
        bytesOf(code) { const len = lenOf(code); let s = ''; for (let k = len - 1; k >= 0; k--) s += String.fromCharCode((code >> (8 * k)) & 255); return s; },
        widthOf,
      };
    } else {
      // Simple fonts: one byte per letter.
      const first = num(get(fontDict, 'FirstChar'), 0);
      const W = get(fontDict, 'Widths');
      let scale = 1 / 1000;
      if (sub === 'Type3') {
        const fm = get(fontDict, 'FontMatrix');
        scale = fm instanceof PDFArray ? num(ctx.lookup(fm.get(0)), 0.001) : 0.001;
      }
      const missing = num(get(descriptor, 'MissingWidth'), 0);
      // Glyph names per code: the font's encoding with its differences.
      const encObj = get(fontDict, 'Encoding');
      const std = standardName(baseFont);
      const baseName = encObj instanceof PDFDict ? name(get(encObj, 'BaseEncoding')) : name(encObj);
      const builtin = std === 'Symbol' || std === 'ZapfDingbats' ? std : baseName || (W ? 'WinAnsiEncoding' : 'StandardEncoding');
      const table = builtinEncoding(builtin).slice();
      const diffs = encObj instanceof PDFDict ? get(encObj, 'Differences') : null;
      if (diffs instanceof PDFArray) {
        let code = 0;
        for (const item of diffs.asArray().map((x) => ctx.lookup(x))) {
          if (item instanceof PDFNumber) code = item.asNumber();
          else table[code++] = name(item);
        }
      }
      let widthOf;
      if (W instanceof PDFArray) {
        const list = W.asArray().map((x) => num(ctx.lookup(x), 0));
        widthOf = (code) => (code >= first && code < first + list.length ? list[code - first] : missing) * scale;
      } else if (sub !== 'Type3') {
        // The 14 standard fonts may list no widths: use the standard metrics.
        const metrics = PDFLib.StandardFontEmbedder.for(std).font;
        widthOf = (code) => {
          let w = 0;
          try { w = table[code] ? metrics.getWidthOfGlyph(table[code]) : 0; } catch { w = 0; }
          return (w || missing) / 1000;
        };
      } else {
        return { ok: false, baseFont };
      }
      // Symbolic TrueType fonts often have no meaningful encoding: only trust ToUnicode there.
      const flags = num(get(descriptor, 'Flags'), 0);
      const symbolic = (flags & 4) && !encObj;
      info = {
        ok: true,
        vertical: false,
        split(str) {
          const out = [];
          for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            out.push({ bytes: str[i], code, w: widthOf(code), space: code === 32 });
          }
          return out;
        },
        text: (code) => (toUnicode && toUnicode.get(code)) || (symbolic ? '' : charOfGlyph(table[code])),
        bytesOf: (code) => String.fromCharCode(code & 255),
        widthOf,
      };
      info.codeCount = 256;
    }
    // Style hints from the font's name and descriptor.
    const flags = num(get(descriptor, 'Flags'), 0);
    const weight = num(get(descriptor, 'FontWeight'), 0);
    const plain = baseFont.replace(/^[A-Z]{6}\+/, '');
    info.baseFont = plain;
    info.bold = weight >= 600 || !!(flags & 0x40000) || /bold|black|heavy|semibold|demi/i.test(plain);
    info.italic = !!(flags & 0x40) || /italic|oblique/i.test(plain) || num(get(descriptor, 'ItalicAngle'), 0) !== 0;
    info.mono = !!(flags & 1) || /courier|mono|consol|menlo/i.test(plain);
    info.serif = (!!(flags & 2) && !/sans|arial|helvet|calibri|carlito|arimo|verdana|tahoma/i.test(plain))
      || (/times|serif|georgia|garamond|roman|cambria|caladea|tinos|minion|palatino|book|baskerville/i.test(plain) && !/sans/i.test(plain));
    // Reverse map: character -> code, for writing new text in this font.
    let reverse = null;
    info.encode = (ch) => {
      if (!reverse) {
        reverse = new Map();
        const codes = toUnicode ? [...toUnicode.keys()] : Array.from({ length: info.codeCount || 0 }, (_, i) => i);
        for (const code of codes) {
          const t = info.text(code);
          if (t && [...t].length === 1 && !reverse.has(t)) reverse.set(t, code);
        }
      }
      const code = reverse.get(ch);
      if (code === undefined) return null;
      return { bytes: info.bytesOf(code), w: info.widthOf(code) };
    };
    return info;
  }

  // ---------------------------------------------------------------------
  // Following the instructions (and rewriting the text ones)
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

  // Fonts per document (a WeakMap on the font dictionaries).
  const fontCache = new WeakMap();
  function fontFor(ctx, resources, fontName) {
    const { PDFName, PDFDict } = PDFLib;
    const fonts = resources instanceof PDFDict ? ctx.lookup(resources.get(PDFName.of('Font'))) : null;
    const dict = fonts instanceof PDFDict ? ctx.lookup(fonts.get(PDFName.of(fontName))) : null;
    if (!(dict instanceof PDFDict)) return { ok: false, baseFont: '' };
    if (!fontCache.has(dict)) {
      let info;
      try { info = fontInfo(ctx, dict); } catch (err) { console.warn('Font not readable', err); info = { ok: false, baseFont: '' }; }
      fontCache.set(dict, info);
    }
    return fontCache.get(dict);
  }

  // Colour operators kept as they are written (to write new text the same colour).
  const COLOR_OPS = { g: 1, rg: 3, k: 4 };

  // Follows a page's instructions. `hooks.glyph(g)` is called for every letter
  // and returns true to delete it; `hooks.unmeasured(x, y)` for text whose
  // letters can't be measured. Returns { text, xobjects } when something was
  // deleted (the new instructions), else null.
  function interpret(ctx, src, resources, ctm0, gs0, depth, path, hooks) {
    const { PDFName, PDFArray, PDFDict, PDFRawStream } = PDFLib;
    const lookup = (dict, key) => (dict instanceof PDFDict ? ctx.lookup(dict.get(PDFName.of(key))) : undefined);
    const toks = tokenize(src);
    let gs = { ...gs0, ctm: ctm0 };
    const stack = [];
    let tm = ID, tlm = ID;
    const edits = []; // { s, e, text }
    const newXObjects = new Map();
    let operands = [];
    let arr = null; // collecting an array operand

    // Show strings (or a TJ array); returns replacement TJ elements if something was deleted.
    const show = (items) => {
      const font = gs.font ? fontFor(ctx, resources, gs.font) : { ok: false };
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
          // Can't measure: report where this text seems to be, keep it.
          const trm = mul(mul([fs * th, 0, 0, fs, 0, gs.rise], tm), gs.ctm);
          if (hooks.unmeasured) hooks.unmeasured(...apply(trm, 0.25, 0.3), gs);
          pushStr(item);
          tm = mul([1, 0, 0, 1, item.length * 0.5 * fs * th, 0], tm); // rough guess
          continue;
        }
        for (const g of font.split(item)) {
          const trm = mul(mul([fs * th, 0, 0, fs, 0, gs.rise], tm), gs.ctm);
          const advance = (g.w * fs + gs.tc + (g.space ? gs.tw : 0)) * th;
          const remove = hooks.glyph({ trm, w: g.w, code: g.code, bytes: g.bytes, space: g.space, font, gs, path, advance, fontName: gs.font });
          if (remove && fs) {
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
        case 'w': if (nums.length) gs.lw = nums[0]; break;
        case 'g': case 'rg': case 'k':
          if (nums.length >= COLOR_OPS[op]) gs.fill = { op, v: nums.slice(-COLOR_OPS[op]) };
          break;
        case 'G': case 'RG': case 'K':
          if (nums.length >= COLOR_OPS[op.toLowerCase()]) gs.stroke = { op, v: nums.slice(-COLOR_OPS[op.toLowerCase()]) };
          break;
        case 'cs': { // colour space: reset to its default colour
          const n = operands.find((o) => o.t === 'name');
          gs.fillSpace = n ? n.v : null;
          const dflt = { DeviceGray: { op: 'g', v: [0] }, DeviceRGB: { op: 'rg', v: [0, 0, 0] }, DeviceCMYK: { op: 'k', v: [0, 0, 0, 1] } };
          gs.fill = (n && dflt[n.v]) || { op: 'cs', v: [], space: n && n.v };
          break;
        }
        case 'sc': case 'scn': {
          const sp = gs.fillSpace;
          const kind = sp === 'DeviceGray' ? 'g' : sp === 'DeviceRGB' ? 'rg' : sp === 'DeviceCMYK' ? 'k' : null;
          if (kind && nums.length >= COLOR_OPS[kind]) gs.fill = { op: kind, v: nums.slice(-COLOR_OPS[kind]) };
          else {
            // A named colour space: work out its kind from the resources.
            const csDict = lookup(resources, 'ColorSpace');
            const cs = sp && lookup(csDict, sp);
            let n = 0;
            if (cs instanceof PDFArray && name(cs.get(0)) === 'ICCBased') { const icc = ctx.lookup(cs.get(1)); const N = icc && lookup(icc.dict, 'N'); n = N ? N.asNumber() : 0; }
            if (cs instanceof PDFArray && /^Cal(RGB|Gray)$/.test(name(cs.get(0)))) n = name(cs.get(0)) === 'CalRGB' ? 3 : 1;
            const k = { 1: 'g', 3: 'rg', 4: 'k' }[n];
            gs.fill = k && nums.length >= n ? { op: k, v: nums.slice(-n) } : { op: 'other', v: nums };
          }
          break;
        }
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
          const r = interpret(ctx, text, formRes, mul(m, gs.ctm), gs, depth + 1, [...path, n.v], hooks);
          if (!r) break;
          // A changed copy of the drawing, for this place only.
          const copy = ctx.flateStream(toBytes(r.text));
          for (const [k, v] of form.dict.entries()) {
            if (!['Filter', 'DecodeParms', 'Length', 'DL', 'Resources'].includes(name(k))) copy.dict.set(k, v);
          }
          copy.dict.set(PDFName.of('Resources'), withXObjects(ctx, formRes, r.xobjects));
          const newName = `${n.v}_e${++hooks.formCount}`;
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
  function withXObjects(ctx, resources, extra) {
    const { PDFName, PDFDict } = PDFLib;
    const res = resources instanceof PDFDict ? resources.clone(ctx) : ctx.obj({});
    if (extra.size) {
      const old = ctx.lookup(res.get(PDFName.of('XObject')));
      const xo = old instanceof PDFDict ? old.clone(ctx) : ctx.obj({});
      for (const [k, ref] of extra) xo.set(PDFName.of(k), ref);
      res.set(PDFName.of('XObject'), xo);
    }
    return res;
  }

  function pageSource(ctx, page) {
    const { PDFName, PDFArray, PDFRawStream } = PDFLib;
    const contents = ctx.lookup(page.node.get(PDFName.of('Contents')));
    if (!contents) return '';
    const parts = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
    return parts.filter((p) => p instanceof PDFRawStream).map(streamText).join('\n');
  }
  const startState = () => ({ ctm: ID, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0, font: null, fs: 0, fill: { op: 'g', v: [0] }, stroke: { op: 'G', v: [0] }, lw: 1 });

  // ---------------------------------------------------------------------
  // Deleting text
  // ---------------------------------------------------------------------
  //   removeText(doc, page, [ (x, y) => inside?, … ])
  //   -> per area { removed, unsure, invisible }
  //   unsure: some text there couldn't be measured (unusual font encoding)
  //   and was left in place; invisible: hidden text was removed (e.g. the
  //   text layer of a scan made by another program).
  function removeText(doc, page, areas) {
    const { PDFName } = PDFLib;
    const ctx = doc.context;
    const results = areas.map(() => ({ removed: 0, unsure: false, invisible: false }));
    if (!areas.length) return results;
    let src;
    try { src = pageSource(ctx, page); } catch (err) { console.warn('Page contents not readable', err); return results; }
    if (!src) return results;
    const hooks = {
      formCount: 0,
      glyph(g) {
        const [x, y] = apply(g.trm, g.w / 2, 0.3);
        const hit = areas.findIndex((inside) => inside(x, y));
        if (hit < 0) return false;
        results[hit].removed++;
        if (g.gs.tr === 3 || g.gs.tr === 7) results[hit].invisible = true;
        return true;
      },
      unmeasured(x, y) { areas.forEach((inside, k) => { if (inside(x, y)) results[k].unsure = true; }); },
    };
    const r = interpret(ctx, src, page.node.Resources(), ID, startState(), 0, [], hooks);
    if (r) {
      // Kept as a list: pdf-lib adds its own drawing to the list later.
      page.node.set(PDFName.of('Contents'), ctx.obj([ctx.register(ctx.flateStream(toBytes(r.text)))]));
      if (r.xobjects.size) page.node.set(PDFName.of('Resources'), withXObjects(ctx, page.node.Resources(), r.xobjects));
    }
    return results;
  }

  // ---------------------------------------------------------------------
  // Reading text: letters -> lines -> paragraphs
  // ---------------------------------------------------------------------
  // Every visible letter on the page:
  //   { u, v (position along / across the baseline), rot, size, adv, str,
  //     style: { font: [form names…, font name], m (letter matrix), fill, tr, … } }
  // { invisible: true } also reads hidden text (the recognised text of a scan).
  function letters(doc, page, { invisible = false } = {}) {
    const ctx = doc.context;
    const out = [];
    const unmeasured = [];
    let src;
    try { src = pageSource(ctx, page); } catch { return { letters: out, unmeasured }; }
    const hooks = {
      formCount: 0,
      glyph(g) {
        const { trm, gs } = g;
        if ((gs.tr === 3 || gs.tr === 7) && !invisible) return false; // invisible text
        const rot = Math.round((Math.atan2(trm[1], trm[0]) * 180) / Math.PI * 10) / 10;
        const size = Math.hypot(trm[2], trm[3]);
        if (!size || g.font.vertical) return false;
        const [u, v] = rotate(trm[4], trm[5], -rot);
        const scaleX = Math.hypot(trm[0], trm[1]);
        out.push({
          u, v, rot, size,
          adv: g.advance * (scaleX / ((gs.fs || 1) * gs.th || 1)), // along the baseline, in page units
          w: g.w * scaleX,
          str: g.font.text(g.code) || '',
          // Code 32 is a space only if the font says so (subset fonts reuse codes).
          space: g.space && (!g.font.text(g.code) || g.font.text(g.code) === ' '),
          style: {
            font: [...g.path, g.fontName], baseFont: g.font.baseFont, m: trm.slice(0, 4).map((x) => Math.round(x * 1e4) / 1e4),
            fill: gs.fill, tr: gs.tr, stroke: gs.tr === 1 || gs.tr === 2 ? gs.stroke : null, lw: gs.lw,
            bold: g.font.bold, italic: g.font.italic, serif: g.font.serif, mono: g.font.mono,
          },
        });
        return false;
      },
      unmeasured(x, y) { unmeasured.push([x, y]); },
    };
    interpret(ctx, src, page.node.Resources(), ID, startState(), 0, [], hooks);
    return { letters: out, unmeasured };
  }

  const styleKey = (s) => JSON.stringify([s.font, s.m, s.fill, s.tr, s.stroke]);
  const BULLET = /^([•◦▪▫‣⁃●○■□►▸–—\-\uf0a7\uf0b7\uf076\uf0d8\uf0fc\ufffd\ue000-\uf8ff]|\d{1,3}[.)]|[a-zA-Z][.)]|\(\w{1,3}\))(\s|$)/;
  // (also what text recognition often reads bullets as: * + · o e © «)
  const isBulletText = (t) => /^([•◦▪▫‣⁃●○■□►▸–—\-\ufffd\ue000-\uf8ff*+·oe©«»°®]|\d{1,3}[.)]|[a-zA-Z][.)]|\(\w{1,3}\))$/.test(t);

  // Lines (pieces of text on one baseline, split at wide gaps such as table
  // columns), then paragraphs.
  // opts.ocr: recognised text (sizes are estimates, so styles are compared loosely).
  function paragraphs(doc, page, opts = {}) {
    const { letters: all, unmeasured } = letters(doc, page, opts);
    // 1. Lines.
    const groups = [];
    for (const g of all) {
      if (!g.str && !g.space) continue;
      let line = null;
      for (let i = groups.length - 1; i >= Math.max(0, groups.length - 40); i--) {
        const l = groups[i];
        if (Math.abs(l.rot - g.rot) < 1 && Math.abs(l.v - g.v) < Math.min(l.size, g.size) * 0.35) { line = l; break; }
      }
      if (!line) { line = { rot: g.rot, v: g.v, size: g.size, items: [] }; groups.push(line); }
      line.items.push(g);
      line.size = Math.max(line.size, g.size);
    }
    const lines = [];
    for (const grp of groups) {
      grp.items.sort((a, b) => a.u - b.u);
      let cur = null;
      for (const g of grp.items) {
        const gap = cur ? g.u - cur.u1 : 0;
        const bulletBefore = cur && isBulletText(cur.items.map((x) => x.str).join('').trim()) && gap < Math.max(cur.size, g.size) * 4;
        if (!cur || (gap > Math.max(cur.size, g.size) * 1.2 && !bulletBefore) || gap < -Math.max(cur.size, g.size)) {
          cur = { rot: grp.rot, v: g.v, size: g.size, u0: g.u, u1: g.u + g.adv, items: [] };
          lines.push(cur);
        }
        cur.items.push(g);
        cur.u1 = Math.max(cur.u1, g.u + g.adv);
        cur.size = Math.max(cur.size, g.size);
      }
    }
    // Text of each line, with spaces where the letters have gaps.
    for (const line of lines) {
      const parts = []; // { text, style }
      let prevEnd = null, prev = null;
      for (const g of line.items) {
        if (g.space || g.str === ' ') { if (parts.length && !/\s$/.test(parts[parts.length - 1].text)) parts.push({ text: ' ', style: g.style }); prevEnd = g.u + g.adv; prev = g; continue; }
        if (prev && prevEnd != null && g.u - prevEnd > g.size * 0.18 && parts.length && !/\s$/.test(parts[parts.length - 1].text) && !(isCJK(prev.str.slice(-1)) && isCJK(g.str[0]))) {
          parts.push({ text: ' ', style: prev.style });
        }
        parts.push({ text: g.str || '�', style: g.style });
        prevEnd = g.u + g.adv;
        prev = g;
      }
      line.parts = parts;
      line.text = parts.map((p) => p.text).join('').trim();
      // Letters not on the baseline (sub/superscripts) don't move the line.
      const counts = new Map();
      for (const g of line.items) if (g.str.trim()) { const k = Math.round(g.v * 4) / 4; counts.set(k, (counts.get(k) || 0) + 1); }
      if (counts.size) line.v = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const sizes = line.items.filter((g) => g.str.trim()).map((g) => g.size).sort((a, b) => a - b);
      line.size = sizes.length ? sizes[Math.floor(sizes.length / 2)] : line.size;
    }
    const usable = lines.filter((l) => l.text);
    // The next piece of text to the right on the same baseline (a table's next
    // column or the page's next column), if any.
    const pageRight = {};
    for (const l of usable) {
      l.rightLimit = Infinity;
      l.hasLeft = false;
      const k = Math.round(l.rot);
      pageRight[k] = Math.max(pageRight[k] ?? -Infinity, l.u1);
      for (const o of usable) {
        if (o === l || Math.abs(o.rot - l.rot) >= 1 || Math.abs(o.v - l.v) >= l.size * 0.35) continue;
        if (o.u0 >= l.u1 && o.u0 < l.rightLimit) l.rightLimit = o.u0;
        if (o.u1 <= l.u0) l.hasLeft = true;
      }
    }
    // 2. Paragraphs: lines below each other with even spacing and overlapping.
    usable.sort((a, b) => a.rot - b.rot || b.v - a.v || a.u0 - b.u0);
    const used = new Set();
    const paras = [];
    for (const first of usable) {
      if (used.has(first)) continue;
      used.add(first);
      const para = [first];
      let gap = null;
      for (;;) {
        const last = para[para.length - 1];
        const left = Math.min(...para.map((l) => l.u0)), right = Math.max(...para.map((l) => l.u1));
        // The nearest line below that overlaps horizontally.
        let next = null;
        for (const l of usable) {
          if (l === last || Math.abs(l.rot - last.rot) >= 1 || l.v >= last.v - last.size * 0.5) continue;
          if (l.u0 >= right || l.u1 <= left) continue;
          if (!next || l.v > next.v) next = l;
        }
        if (!next || used.has(next)) break;
        const d = last.v - next.v;
        const ratio = next.size / last.size;
        if (opts.ocr ? ratio < 0.7 || ratio > 1.4 : ratio < 0.85 || ratio > 1.18) break;
        if (d < last.size * 0.95 || d > last.size * 2.1) break;
        if (gap != null && Math.abs(d - gap) > last.size * (opts.ocr ? 0.35 : 0.25)) break;
        if (BULLET.test(next.text) || (para.length === 1 && /^[*+·©«°®]\s/.test(next.text))) break;
        // A line on its own followed by a row of a table (or columns): separate.
        if (!Number.isFinite(last.rightLimit) && !last.hasLeft && Number.isFinite(next.rightLimit)) break;
        // A short first line without closing punctuation over a long one: a heading.
        if (para.length === 1 && last.u1 - last.u0 < (next.u1 - next.u0) * 0.5 && !/[.,;:!?。，；：]$/.test(last.text)) break;
        // Lines with nothing in common in their style (font, size, colour) are separate.
        const keysOf = (l) => new Set(l.items.filter((g) => g.str.trim()).map((g) => styleKey(g.style)));
        const lk = keysOf(last);
        if (!opts.ocr && ![...keysOf(next)].some((k) => lk.has(k))) break;
        // Next to another column (a table): only a line that runs up to the
        // next column continues onto the line below (wrapped cell or column text).
        const limit = Number.isFinite(last.rightLimit) ? last.rightLimit : last.hasLeft ? pageRight[Math.round(last.rot)] : null;
        if (limit != null && last.u1 < limit - Math.max(last.size * 3, (limit - last.u0) * 0.35)) break;
        // The last column of a table (narrow, with text to its left).
        if (!Number.isFinite(last.rightLimit) && last.hasLeft && limit - last.u0 < last.size * 12) break;
        // Edges must line up: left (also indented first line), right or centre.
        const nL = next.u0, nR = next.u1, tol = last.size * 0.6;
        const others = para.length > 1 ? para.slice(1) : para;
        const leftOk = others.some((l) => Math.abs(l.u0 - nL) < tol) || (para.length === 1 && Math.abs(last.u0 - nL) < last.size * 4 && nL < last.u0 + tol);
        const centreOk = Math.abs((last.u0 + last.u1) / 2 - (nL + nR) / 2) < tol;
        const rightOk = Math.abs(last.u1 - nR) < tol;
        if (!leftOk && !centreOk && !rightOk) break;
        // A clearly short line ends a paragraph (when the width is known).
        if (para.length >= 2 && last.u1 < right - Math.max(last.size * 4, (right - left) * 0.2) && leftOk && !centreOk && !rightOk) break;
        used.add(next);
        para.push(next);
        gap = gap == null ? d : gap;
      }
      paras.push(para);
    }
    return { paragraphs: paras.map((p) => describe(p, page)), unmeasured };
  }

  // A paragraph's geometry, alignment and styled text.
  function describe(lines, page) {
    const rot = lines[0].rot;
    const left = Math.min(...lines.map((l) => l.u0)), right = Math.max(...lines.map((l) => l.u1));
    const size = lines[0].size;
    const gaps = lines.slice(1).map((l, i) => lines[i].v - l.v);
    const lineGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : size * 1.2;
    const tol = size * 0.5;
    let align = 'left';
    const body = lines.length > 1 ? lines.slice(1) : lines;
    const leftsEqual = body.every((l) => Math.abs(l.u0 - body[0].u0) < tol);
    const notLast = lines.slice(0, -1);
    if (lines.length >= 2) {
      const rightsEqual = notLast.every((l) => Math.abs(l.u1 - right) < tol);
      const centres = lines.map((l) => (l.u0 + l.u1) / 2);
      const centred = centres.every((c) => Math.abs(c - centres[0]) < tol) && !lines.every((l) => Math.abs(l.u0 - left) < tol);
      if (centred) align = 'center';
      else if (lines.every((l) => Math.abs(l.u1 - right) < tol) && !lines.every((l) => Math.abs(l.u0 - left) < tol)) align = 'right';
      else if (leftsEqual && rightsEqual && notLast.length >= 1 && (lines.length >= 3 || lines[0].items.some((g) => g.space))) {
        // Justified when the full lines all end together (ragged text rarely does).
        align = lines.length >= 3 ? 'justify' : 'left';
      }
    } else if (page) {
      // One line: keep a heading centred if it sits in the middle of the page.
      const box = page.getCropBox ? page.getCropBox() : null;
      if (box && Math.abs(rot) < 1) {
        const mid = box.x + box.width / 2;
        if (Math.abs((left + right) / 2 - mid) < 3 && left - box.x > box.width * 0.15) align = 'center';
      }
    }
    const indent = lines.length > 1 && leftsEqual ? lines[0].u0 - body[0].u0 : 0;
    const base = lines.length > 1 && leftsEqual ? body[0].u0 : left;
    // Styled runs; lines are joined with spaces (or nothing after a hyphen / between Chinese).
    const styles = [], keys = new Map();
    const runs = [];
    const add = (text, style) => {
      const k = styleKey(style);
      if (!keys.has(k)) { keys.set(k, styles.length); styles.push(style); }
      const s = keys.get(k);
      const last = runs[runs.length - 1];
      if (last && last.s === s) last.text += text; else runs.push({ s, text });
    };
    lines.forEach((l, i) => {
      const parts = l.parts.slice();
      while (parts.length && !parts[0].text.trim()) parts.shift();
      while (parts.length && !parts[parts.length - 1].text.trim()) parts.pop();
      if (i > 0) {
        const prevLine = lines[i - 1], prevText = prevLine.text;
        // Did the line above wrap because it was full, or end on purpose?
        // (It wrapped if this line's first word wouldn't have fitted after it.)
        const right = align === 'left' || align === 'justify' ? Math.max(...lines.map((x) => x.u1)) : Infinity;
        let firstWord = 0;
        for (const g of l.items) { if (g.space || g.str === ' ' || (firstWord && g.u - (l.items[0].u + firstWord) > g.size * 0.18)) break; firstWord = g.u + g.adv - l.items[0].u; }
        const cjkJoin = isCJK(prevText.slice(-1)) && isCJK(l.text[0]);
        const wrapped = align !== 'left' || prevLine.u1 + size * 0.25 + (cjkJoin ? size : firstWord) > right - size * 0.3;
        const join = !wrapped ? '\n' : /-$/.test(prevText) || cjkJoin ? '' : ' ';
        if (join) add(join, runs.length ? styles[runs[runs.length - 1].s] : parts[0].style);
      }
      for (const p of parts) add(p.text, p.style);
    });
    const text = runs.map((r) => r.text).join('');
    const sizes = styles.map((s) => Math.hypot(s.m[2], s.m[3]));
    // Areas covering the original letters (one per line), to delete them.
    const areas = lines.map((l) => {
      const v0 = l.v - l.size * 0.3, v1 = l.v + l.size * 0.95;
      const [x, y] = rotate(l.u0 - 0.5, v0, rot);
      return { x, y, w: l.u1 - l.u0 + 1, h: v1 - v0, rot };
    });
    return {
      rot, align, lineGap, indent,
      u0: align === 'left' || align === 'justify' ? base : left,
      width: align === 'left' || align === 'justify' ? right - base : right - left,
      left, right, v: lines[0].v, vBottom: lines[lines.length - 1].v, size, lines: lines.length,
      runs, styles, text, sizes, areas,
      lineBoxes: lines.map((l) => ({ u0: l.u0, u1: l.u1, v: l.v, size: l.size })),
    };
  }

  // ---------------------------------------------------------------------
  // Writing a paragraph
  // ---------------------------------------------------------------------
  // Resolves a style's font path ([form names…, font name]) on a page.
  function fontDictAt(doc, page, path) {
    const { PDFName, PDFDict } = PDFLib;
    const ctx = doc.context;
    let res = page.node.Resources();
    for (const formName of path.slice(0, -1)) {
      const xo = res instanceof PDFDict ? ctx.lookup(res.get(PDFName.of('XObject'))) : null;
      const form = xo instanceof PDFDict ? ctx.lookup(xo.get(PDFName.of(formName))) : null;
      if (!form || !form.dict) return null;
      res = ctx.lookup(form.dict.get(PDFName.of('Resources'))) || res;
    }
    const fonts = res instanceof PDFDict ? ctx.lookup(res.get(PDFName.of('Font'))) : null;
    const ref = fonts instanceof PDFDict ? fonts.get(PDFName.of(path[path.length - 1])) : null;
    const dict = ctx.lookup(ref);
    return dict instanceof PDFDict ? { ref, dict } : null;
  }
  function fontInfoAt(doc, page, path) {
    if (!path) return null; // text that never had a font (recognised scans)
    const found = fontDictAt(doc, page, path);
    if (!found) return null;
    if (!fontCache.has(found.dict)) {
      let info;
      try { info = fontInfo(doc.context, found.dict); } catch { info = { ok: false }; }
      fontCache.set(found.dict, info);
    }
    return { ...found, info: fontCache.get(found.dict) };
  }

  // Splits each run into pieces in one font: the original where it has the
  // letters, otherwise a look-alike (`fallback(style, ch)` -> { key, w(ch), encode(ch) }).
  // Returns tokens for line breaking: words, spaces and line breaks.
  function shape(doc, page, para, runs, fallback) {
    const styles = para.styles;
    const infos = styles.map((s) => fontInfoAt(doc, page, s.font));
    const tokens = [];
    let usedFallback = false;
    for (const run of runs) {
      const style = styles[run.s];
      const scale = Math.hypot(style.m[0], style.m[1]); // letter advance -> page units
      const fi = infos[run.s];
      const chars = [...run.text];
      // A mostly Latin run switches font as a whole if any letter is missing
      // (mixing two fonts inside a word looks wrong); Chinese goes letter by letter.
      const cjk = chars.filter(isCJK).length > chars.length / 2;
      const missingLatin = chars.some((ch) => !isCJK(ch) && ch !== '\n' && ch !== ' ' && !(fi && fi.info.ok && fi.info.encode(ch)));
      for (const ch of chars) {
        if (ch === '\n') { tokens.push({ t: 'br' }); continue; }
        let glyph = null, fontKey = null;
        const own = fi && fi.info.ok && (cjk || !missingLatin || isCJK(ch)) ? fi.info.encode(ch) : null;
        if (own) { glyph = own; fontKey = 'own:' + run.s; }
        else if (ch !== ' ') {
          const fb = fallback(style, ch);
          if (fb) { glyph = fb.encode(ch); fontKey = 'fb:' + fb.key; usedFallback = true; }
        }
        const piece = { ch, s: run.s, fontKey, bytes: glyph ? glyph.bytes : null, adv: glyph ? glyph.w * scale : 0, style };
        if (ch === ' ') {
          // Space: the font's own space, else a typical word gap.
          const sp = fi && fi.info.ok ? fi.info.encode(' ') : null;
          piece.adv = sp && sp.w > 0 ? sp.w * scale : Math.hypot(style.m[2], style.m[3]) * 0.26;
          piece.bytes = sp && sp.w > 0 ? sp.bytes : null;
          piece.fontKey = sp && sp.w > 0 ? 'own:' + run.s : null;
          tokens.push({ t: 'space', pieces: [piece] });
          continue;
        }
        if (!glyph) continue; // a letter no font has: left out
        const last = tokens[tokens.length - 1];
        // Chinese can break between any two characters; other text between words.
        if (last && last.t === 'word' && !isCJK(ch) && !isCJK(last.pieces[last.pieces.length - 1].ch)) last.pieces.push(piece);
        else tokens.push({ t: 'word', pieces: [piece] });
      }
    }
    return { tokens, usedFallback };
  }

  // Line breaking. Returns lines of pieces with their positions along the baseline.
  function layout(para, tokens, width) {
    const wrap = width != null ? width : Infinity;
    const lines = [];
    let cur = { pieces: [], w: 0, spaces: 0, hard: false };
    const firstIndent = para.indent || 0;
    const room = () => (lines.length === 0 ? wrap - firstIndent : wrap);
    const wordW = (tok) => tok.pieces.reduce((s, p) => s + p.adv, 0);
    let pendingSpace = null;
    const finish = (hard) => { cur.hard = hard; lines.push(cur); cur = { pieces: [], w: 0, spaces: 0, hard: false }; pendingSpace = null; };
    for (const tok of tokens) {
      if (tok.t === 'br') { finish(true); continue; }
      if (tok.t === 'space') { if (cur.pieces.length) pendingSpace = tok; continue; }
      const w = wordW(tok);
      const spaceW = pendingSpace ? wordW(pendingSpace) : 0;
      if (cur.pieces.length && cur.w + spaceW + w > room() + 0.01) finish(false);
      if (pendingSpace && cur.pieces.length) {
        for (const p of pendingSpace.pieces) cur.pieces.push({ ...p, isSpace: true });
        cur.w += spaceW; cur.spaces++;
      }
      pendingSpace = null;
      for (const p of tok.pieces) cur.pieces.push(p);
      cur.w += w;
    }
    lines.push(cur);
    cur.hard = true;
    // Positions.
    lines.forEach((line, i) => {
      const avail = i === 0 ? wrap - firstIndent : wrap;
      let start = i === 0 ? firstIndent : 0, extra = 0;
      if (para.align === 'center') start = (para.width - line.w) / 2;
      else if (para.align === 'right') start = para.width - line.w;
      else if (para.align === 'justify' && !line.hard && line.spaces && Number.isFinite(avail)) extra = Math.max(0, (avail - line.w) / line.spaces);
      let u = start;
      for (const p of line.pieces) {
        p.u = u;
        u += p.adv + (p.isSpace ? extra : 0);
        p.extra = p.isSpace ? extra : 0;
      }
      line.end = u;
    });
    return lines;
  }

  const fillOp = (f) => (f && COLOR_OPS[f.op] ? f.v.map(fmt).join(' ') + ' ' + f.op : '0 g');
  const strokeOp = (s) => (s && COLOR_OPS[s.op.toLowerCase()] ? s.v.map(fmt).join(' ') + ' ' + s.op : '');

  // Writes an edited paragraph onto a page.
  //   a: { x, y (start of the first baseline), rot, align, width, lineGap,
  //        indent, lines, styles, runs }
  //   fallback(style, ch) -> { key, encode(ch) -> { bytes, w }, ref (font in this document) }
  // Returns { lines, width, height } (the area the text covers, in the
  // paragraph's own directions), and { missing } letters no font had.
  function writeParagraph(doc, page, a, fallback, fontResource) {
    const { PDFName } = PDFLib;
    const ctx = doc.context;
    const { tokens, usedFallback } = shape(doc, page, a, a.runs, fallback);
    const lines = layout(a, tokens, a.wrap ? a.width : null);
    // Font resources on this page for the fonts used.
    const resNames = new Map();
    const resourceFor = (piece) => {
      if (resNames.has(piece.fontKey)) return resNames.get(piece.fontKey);
      let ref;
      if (piece.fontKey.startsWith('own:')) ref = fontDictAt(doc, page, piece.style.font).ref;
      else ref = fontResource(piece.fontKey.slice(3));
      const nm = page.node.newFontDictionary('PE', ref).decodeText();
      resNames.set(piece.fontKey, nm);
      return nm;
    };
    let ops = 'q\n';
    const r = (a.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    lines.forEach((line, i) => {
      const v = -i * a.lineGap;
      // Group consecutive pieces with the same font and style into one TJ.
      let k = 0;
      while (k < line.pieces.length) {
        const p0 = line.pieces[k];
        if (!p0.fontKey) { k++; continue; }
        const group = [p0];
        let j = k + 1;
        while (j < line.pieces.length) {
          const p = line.pieces[j];
          if (p.fontKey && (p.fontKey !== p0.fontKey || p.s !== p0.s)) break;
          group.push(p);
          j++;
        }
        const st = p0.style;
        const scale = Math.hypot(st.m[0], st.m[1]);
        // Letter matrix: the original's, placed at this piece.
        const [ox, oy] = rotate(p0.u, v, a.rot);
        const x = a.x + ox, y = a.y + oy;
        const isOwn = p0.fontKey.startsWith('own:');
        let m = st.m;
        if (!isOwn) { // look-alike fonts: same size and direction, upright
          const size = Math.hypot(st.m[2], st.m[3]);
          m = [size * c * (scale / size || 1), size * s * (scale / size || 1), -size * s, size * c];
          if (st.italic && !/Italic|Oblique/.test(p0.fontKey)) { /* the fallback font has its own italic */ }
        }
        let tj = '';
        let prevEnd = p0.u;
        for (const p of group) {
          const gapUnits = p.u - prevEnd; // positioning differences (spaces without a glyph, justification)
          if (Math.abs(gapUnits) > 1e-4) tj += ' ' + fmt((-gapUnits / scale) * 1000);
          if (p.bytes && p.fontKey === p0.fontKey) {
            tj += ' ' + hexOf(p.bytes);
            prevEnd = p.u + p.adv;
          } else {
            prevEnd = p.u; // a space without a glyph: its width is a gap
          }
        }
        // A piece's advance in our layout already includes its width; the gap
        // for glyph-less spaces is added on the next letter.
        ops += 'BT\n';
        ops += fillOp(st.fill) + '\n';
        if (st.tr && st.tr !== 3 && st.tr !== 7) ops += `${st.tr} Tr\n` + (st.stroke ? strokeOp(st.stroke) + '\n' : '') + `${fmt(st.lw || 1)} w\n`;
        ops += `/${resourceFor(p0)} 1 Tf\n`;
        ops += `${m.map(fmt).join(' ')} ${fmt(x)} ${fmt(y)} Tm\n`;
        ops += `[${tj.trim()}] TJ\nET\n`;
        k = j;
      }
    });
    ops += 'Q\n';
    page.node.normalize(); // the original drawing is wrapped in q/Q first, so its settings don't leak
    page.node.addContentStream(ctx.register(ctx.flateStream(toBytes(ops))));
    const width2 = Math.max(0, ...lines.map((l) => l.end));
    return { lines: lines.length, width: width2, height: (lines.length - 1) * a.lineGap, usedFallback };
  }

  window.PdfText = { removeText, paragraphs, letters, shape, writeParagraph, tokenize, fontInfoAt, isCJK };
})();
