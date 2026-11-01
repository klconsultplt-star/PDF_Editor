/* Password protection: open locked PDFs and lock downloads.
 *
 * Uses qpdf (the standard open-source PDF tool) compiled to WebAssembly.
 * It's about 1.8 MB, so it's only loaded the first time it's needed.
 * Downloads are locked with AES-256, the strongest PDF encryption.
 */
(() => {
  'use strict';

  let wasmUrl = null; // blob: address of the WebAssembly code

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ready() {
    // The single-file version has these built in; otherwise load them now.
    if (!window.createQpdfModule) await loadScript('vendor/qpdf.js');
    if (!wasmUrl) {
      // The code ships as text (so it works from file:// too) and is handed
      // to qpdf as a blob: address, which browsers can always fetch.
      if (!window.QPDF_WASM_BASE64) await loadScript('vendor/qpdf-wasm.js');
      const bin = atob(window.QPDF_WASM_BASE64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      wasmUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
      delete window.QPDF_WASM_BASE64; // free the text copy
    }
  }

  // Run qpdf once on `input` and return the file it wrote (or throw).
  async function run(args, input) {
    await ready();
    // This qpdf build writes its messages to the console (it ignores the
    // usual print hooks), so listen there while it runs.
    const errors = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...a) => errors.push(a.join(' '));
    console.log = console.warn = console.error = capture;
    let qpdf, code;
    try {
      qpdf = await window.createQpdfModule({ locateFile: () => wasmUrl, noInitialRun: true });
      qpdf.FS.writeFile('/in.pdf', input);
      try { code = qpdf.callMain(args); } catch (e) { code = typeof e.status === 'number' ? e.status : 2; }
    } finally {
      Object.assign(console, saved);
    }
    const message = errors.join('\n');
    if (/invalid password/i.test(message)) {
      const err = new Error('Wrong password');
      err.code = 'password';
      throw err;
    }
    let out = null;
    try { out = qpdf.FS.readFile('/out.pdf'); } catch {}
    // qpdf exit codes: 0 = OK, 3 = OK with warnings.
    if (!out || (code !== 0 && code !== 3)) throw new Error(message.split('\n').pop() || 'qpdf failed');
    return out;
  }

  // Remove the password. An empty password works for files that open freely
  // but have editing/printing restrictions.
  const decrypt = (bytes, password = '') =>
    run(['--password=' + password, '--decrypt', '/in.pdf', '/out.pdf'], bytes);

  // Lock with a password (AES-256). The same password unlocks everything.
  const encrypt = (bytes, password) =>
    run(['/in.pdf', '--encrypt', '--user-password=' + password, '--owner-password=' + password, '--bits=256', '--', '/out.pdf'], bytes);

  window.PdfSecurity = { decrypt, encrypt, run };
})();
