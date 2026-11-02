/* PDF Editor desktop app (Electron).
 *
 * Wraps the same editor as the web version (copied into ./app by
 * `npm run prepare-app`) in a desktop window, and adds what a desktop
 * program needs: opening PDFs from the system (Open with, double-click,
 * drag onto the icon), native Open and Save dialogs, a menu bar, and a
 * warning before closing with unsaved changes. Everything, including text
 * recognition (OCR), works offline.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_DIR = path.join(__dirname, 'app');
// PDF Editor Lite is built without text recognition (OCR).
const HAS_OCR = fs.existsSync(path.join(APP_DIR, 'ocr.js'));
const NAME = HAS_OCR ? 'PDF Editor' : 'PDF Editor Lite';
const START_URL = 'app://editor/index.html';

// The editor is served from app://editor/… rather than file://, so that it
// behaves like a normal web page (workers, fetch, storage all work).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let rendererReady = false;
const pendingFiles = [];
let lastFolder = null;

// PDF paths given on the command line (Windows/Linux "Open with", double-click).
const pdfArgs = (argv) => argv.slice(1).filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a));

function openPath(file) {
  if (!win || !rendererReady) { pendingFiles.push(file); return; }
  try {
    win.webContents.send('open-file', { name: path.basename(file), data: fs.readFileSync(file) });
    lastFolder = path.dirname(file);
  } catch (err) {
    dialog.showErrorBox('Could not open the file', `${file}\n\n${err.message}`);
  }
  if (win.isMinimized()) win.restore();
  win.focus();
}

// Only one copy of the app: opening another PDF sends it to the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv);
    if (files.length) files.forEach(openPath);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}
app.on('open-file', (e, file) => { e.preventDefault(); openPath(file); }); // macOS

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#eef0f3',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.loadURL(START_URL);

  // Links to websites open in the normal browser; the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  // The editor asks before leaving with unsaved changes.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have changes that are not saved.',
      detail: 'Close anyway? Use File > Save as… to keep them.',
    });
    if (choice === 0) e.preventDefault(); // allow closing
  });

  win.on('closed', () => { win = null; rendererReady = false; });
}

// Files the editor creates (saved PDFs, Word/Excel, split files) go through
// a Save dialog. PDF_EDITOR_SAVE_DIR skips the dialog (used by automated tests).
function handleDownloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    const name = item.getFilename();
    const ext = path.extname(name).slice(1).toLowerCase();
    const kinds = { pdf: 'PDF document', docx: 'Word document', odt: 'OpenDocument text', xlsx: 'Excel workbook', ods: 'OpenDocument spreadsheet', csv: 'CSV file', zip: 'Zip archive' };
    if (process.env.PDF_EDITOR_SAVE_DIR) {
      item.setSavePath(path.join(process.env.PDF_EDITOR_SAVE_DIR, name));
    } else {
      item.setSaveDialogOptions({
        title: 'Save',
        defaultPath: path.join(lastFolder || app.getPath('documents'), name),
        filters: kinds[ext] ? [{ name: kinds[ext], extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
      });
    }
    item.once('done', (_e2, state) => {
      if (state === 'completed' && win) {
        lastFolder = path.dirname(item.getSavePath());
        win.webContents.send('saved', item.getSavePath());
      }
    });
  });
}

async function showOpenDialog(merge) {
  const res = await dialog.showOpenDialog(win, {
    title: merge ? 'Add pages from PDF' : 'Open PDF',
    defaultPath: lastFolder || app.getPath('documents'),
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    properties: merge ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return;
  if (!merge) return openPath(res.filePaths[0]);
  lastFolder = path.dirname(res.filePaths[0]);
  win.webContents.send('merge-files', res.filePaths.map((f) => ({ name: path.basename(f), data: fs.readFileSync(f) })));
}

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => showOpenDialog(false) },
        { label: 'Add pages from PDF…', click: () => showOpenDialog(true) },
        { label: 'New blank document', click: send('newBlank') },
        { type: 'separator' },
        { label: 'Save as…', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Convert to Word, Excel or ODF…', accelerator: 'CmdOrCtrl+E', click: send('convert') },
        ...(HAS_OCR ? [{ label: 'Recognize text (OCR)…', click: send('ocr') }] : []),
        { label: 'Split or extract pages…', click: send('split') },
        { label: 'Compress (make smaller)…', click: send('compress') },
        { label: 'Password…', click: send('password') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },
    {
      // Undo/redo are left to the editor (Ctrl+Z / Ctrl+Y), so they work on edits.
      label: '&Edit',
      submenu: [
        { label: 'Undo', click: send('undo') },
        { label: 'Redo', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Add signature…', click: send('sign') },
        { label: 'Watermark', click: send('watermark') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: send('zoomIn') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About ' + NAME,
          click: () => dialog.showMessageBox(win, {
            title: 'About ' + NAME,
            message: `${NAME} ${app.getVersion()}`,
            detail: 'Edit, sign, convert and recognize text in PDF files. Everything runs on this computer; nothing is uploaded.\n\n' +
              'Built with pdf.js, pdf-lib, qpdf and Tesseract (open-source; licences are in the app folder under vendor).',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Save several files into one folder (batch compress). Existing files are
// never overwritten: "name (2).pdf" is used instead.
ipcMain.handle('save-files', async (_e, files) => {
  let folder = process.env.PDF_EDITOR_SAVE_DIR;
  if (!folder) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for the PDFs',
      buttonLabel: 'Save here',
      defaultPath: lastFolder || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    folder = res.filePaths[0];
  }
  let count = 0;
  for (const [name, data] of Object.entries(files)) {
    const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file.pdf';
    const ext = path.extname(safe), stem = safe.slice(0, safe.length - ext.length);
    let target = path.join(folder, safe);
    for (let k = 2; fs.existsSync(target); k++) target = path.join(folder, `${stem} (${k})${ext}`);
    fs.writeFileSync(target, Buffer.from(data));
    count++;
  }
  lastFolder = folder;
  return { folder, count };
});

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  pendingFiles.splice(0).forEach(openPath);
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  handleDownloads();
  buildMenu();
  createWindow();
  pdfArgs(process.argv).forEach(openPath);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
