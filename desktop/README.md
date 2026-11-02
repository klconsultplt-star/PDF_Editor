# PDF Editor: desktop app

The same PDF Editor as the web version, as a normal program for **Windows**, **Mac** and **Linux**. Everything works offline, including text recognition (OCR) in English, Malay and Chinese.

## Install (Windows)

- **Installer:** run `PDF-Editor-Setup-1.0.0.exe`. It installs for your user account (no administrator rights needed), adds Start-menu and desktop shortcuts, and registers the app for PDF files.
- **Portable:** `PDF-Editor-Portable-1.0.0.exe` runs straight away without installing (it can't add itself to "Open with").

Windows may show **"Windows protected your PC"** because the app isn't code-signed (that needs a paid certificate). Click **More info → Run anyway**.

To make it your default PDF program: right-click any PDF → **Open with → Choose another app → PDF Editor**, and tick "Always use this app".

## Mac and Linux

- **Linux:** `PDF-Editor-1.0.0.AppImage`: make it executable (`chmod +x`) and run it.
- **Mac:** build it on GitHub (below). The first time, right-click the app and choose **Open**, because it isn't signed by Apple.

## What the desktop app adds

- Open PDFs from Windows: double-click, **Open with**, or drag a file onto the app icon. Opening another PDF while the app is running opens it in the same window.
- Real **Open** and **Save as** windows, remembering the last folder.
- A menu bar (File, Edit, View, Help) with keyboard shortcuts: Ctrl+O open, Ctrl+S save, Ctrl+E convert, Ctrl+= / Ctrl+- zoom.
- Compressing many PDFs at once saves them straight into a folder you choose.
- A warning before closing with unsaved changes.
- Text recognition works fully offline (the engine and English, Malay and Chinese language data are built in).

## Building it

You need [Node.js](https://nodejs.org) 22.

```
cd desktop
npm install
npm start            # run it from the source
npm run dist:win     # Windows installer + portable exe (on Linux this needs Wine)
npm run dist:linux   # Linux AppImage
npm run dist:mac     # Mac (must be run on a Mac)
```

The installers appear in `desktop/dist`. `npm run prepare-app` (run automatically by the commands above) copies the editor from the repository root into `desktop/app`, so after changing the editor just rebuild.

**On GitHub:** the repository's **Actions** tab has a **Desktop app** workflow that builds Windows, Mac and Linux versions on GitHub's computers. Open it, click **Run workflow**, and download the installers from the finished run's **Artifacts**.

## Files

- `main.js`: the desktop shell (window, menus, file opening, Save dialogs, closing).
- `preload.js`: the small, safe bridge between the shell and the editor page.
- `scripts/prepare-app.js`: copies the editor into `app/`.
- `build/`: app icons.

## PDF Editor Lite

The same app without text recognition (OCR): everything else is identical (editing, converting, compressing, passwords, signatures). Scanned PDFs can still be opened, viewed, annotated, split and compressed, but their text can't be read, edited or converted. It installs alongside the full app, with its own name and shortcut.

Build it with `npm run dist:win:lite` (`PDF-Editor-Lite-Setup-1.0.0.exe` and `PDF-Editor-Lite-Portable-1.0.0.exe`), or try it with `npm run start:lite`. It is about 10 MB smaller; most of the size is Electron itself.

**Speed tip:** the installed app starts in a few seconds. The portable `.exe` unpacks itself into a temporary folder every time it starts, which takes 10–60 seconds depending on the computer (and on the antivirus scanning it), so use the installer if you can.
