# PDF Editor

A PDF editor and converter, as a **desktop app** for Windows, Mac and Linux or in a web browser. Files never leave your computer: there is no server and no upload.

**Recognize text in scanned PDFs (OCR)** in English, Malay and Chinese (Simplified and Traditional): make scans searchable, and convert them to Word or Excel. See [Recognizing text](#recognizing-text-ocr).

**Convert PDF to Word, Excel and OpenDocument:** `.docx`, `.odt`, `.xlsx`, `.ods` and `.csv`, keeping fonts, bold/italic, sizes, colours, headings, paragraphs, lists, tables and pictures. See [Converting](#converting) below.

Also in this repository, to save any web page as a PDF exactly as it looks on screen (and open it in this editor):

- **[Web to PDF browser extension](web-to-pdf-extension/README.md)** for Chrome and Edge: one click on the page you're viewing, works on logged-in pages, nothing to set up besides loading the extension. Download [`dist/web-to-pdf-extension.zip`](dist/web-to-pdf-extension.zip).
- **[Web to PDF server app](web-to-pdf/README.md)**: the same capture as a small web app (Node.js), for capturing pages by address or sharing with a team.

## How to run it

**Desktop app (recommended):** install the Windows app (`PDF-Editor-Setup-1.0.0.exe`) or use the portable `.exe`. It opens PDFs from Windows ("Open with", double-click), has real Open/Save windows and a menu bar, and works fully offline, including text recognition. See [`desktop/README.md`](desktop/README.md) for installing and for building Windows, Mac and Linux versions.

**One file:** download [`dist/pdf-editor.html`](dist/pdf-editor.html) (on GitHub, open the file and click the **Download raw file** button), save it anywhere, and double-click it. It contains the whole editor and works offline.

**Whole folder:** on GitHub click **Code → Download ZIP**, unzip it, and double-click `index.html`. `index.html` needs the files next to it (the `.js` files, `styles.css`, `vendor/`), so don't move it out of the folder on its own.

**Online:** turn on GitHub Pages for this repository (Settings → Pages) and the editor is available at your Pages URL.

After changing the app's files, run `python3 build-single-file.py` to rebuild `dist/pdf-editor.html`.

## What it can do

| Feature | How |
| --- | --- |
| Open a PDF | **Open**, or drag a PDF onto the window |
| Edit existing text | **Edit text** tool (E): hover to see what can be edited, click a word or line, type the new text, click away to finish. The new text matches the original's font style (sans/serif/mono, bold, italic), size and colour, and the background colour is matched to hide the old words. Clear all the text to delete it. Select it and press Delete to undo the change |
| Add text | **Add text** tool, click where it should go, type. Click away to finish. Double-click existing added text to edit it |
| Draw freehand | **Draw** tool |
| Highlight an area | **Highlight** tool, drag over the area |
| Draw a box | **Box** tool |
| Hide existing content | **Whiteout** tool covers it with a white box (then add new text on top to "replace" text) |
| Watermark | Type your text in the box next to **Watermark** (default "DRAFT", remembered for next time) and click the button: a faint diagonal watermark (bold, 150 pt, 10% opacity, 45°) goes across every page. Longer text is shrunk so it still fits the page. Click again to remove it, or change the text and click to replace it |
| Insert an image | **Image** (PNG or JPG), or drag an image onto the window |
| Sign | **Sign** (S): draw your signature, type your name in a handwriting style, or upload a photo of it (the white background is removed). Then click where it goes on the page; move and resize it like an image. Signatures are saved in your browser for next time |
| Move / resize / delete | **Select** tool: drag to move, drag the square handle to resize, Delete key to remove, arrow keys to nudge |
| Change color, font, size, line width | Toolbar controls. With an item selected, changes apply to it |
| Rotate, delete, insert blank pages | Hover a page thumbnail on the left |
| Reorder pages | Drag thumbnails |
| Merge PDFs | **Merge** adds another PDF's pages to the end |
| Split or extract pages | **Split**: save chosen pages (for example `1-3, 5, 8-`) as one PDF, or split the document into separate PDFs every N pages (downloaded together as a .zip). Your edits are included |
| Open locked PDFs | Opening a password-protected PDF asks for its password. The downloaded copy keeps the same password unless you change it |
| Password-protect | **Password**: set a password and downloads (including split files) are locked with AES-256 encryption. The button shows 🔒 while it's on; click it again to change or remove the password |
| Undo / redo | Buttons, or Ctrl+Z / Ctrl+Y |
| Save | **Download** (or Ctrl+S) saves `<name>-edited.pdf` |
| Convert | **Convert** (or **Convert a PDF to Word, Excel or ODF** on the start screen): choose Word, OpenDocument Text, Excel, OpenDocument Spreadsheet or CSV, and all pages or some. See [Converting](#converting) |
| Recognize text (OCR) | **Recognize text**: for scanned PDFs. Choose the languages and the text is recognized and added invisibly behind the scan. See [Recognizing text](#recognizing-text-ocr) |

## Converting

| Format | Best for | What you get |
| --- | --- | --- |
| **Word** `.docx` | Editing the document | Paragraphs that re-flow, with the original fonts, bold/italic, sizes and colours; headings (they show in Word's navigation pane); centred/right/justified alignment and indents; bullet and numbered lists; tables (with borders and cell shading when the PDF has them); pictures; page size, margins and page breaks |
| **OpenDocument Text** `.odt` | Editing in LibreOffice, OpenOffice, Google Docs or Word | The same as Word, plus each page's background colour |
| **Excel** `.xlsx` | Working with numbers | One sheet per page. Tables keep their columns; amounts like `$1,250.00`, `12.5%` or `1,200` become real numbers with matching number formats, so you can calculate with them. Bold, colours and cell shading are kept. Other text goes in column A |
| **OpenDocument Spreadsheet** `.ods` | Numbers in LibreOffice and others | The same as Excel |
| **CSV** `.csv` | Importing data elsewhere | The table data as plain text |

Your edits are included: text you added or edited is converted; watermarks and text hidden under Whiteout or replaced with **Edit text** are left out.

## Recognizing text (OCR)

Scanned PDFs are pictures of pages, so their text can't be searched, copied or converted. **Recognize text** reads it:

1. Open the scanned PDF. The app notices it's scanned and highlights **Recognize text**.
2. Tick the languages the document uses: **English**, **Malay**, **Chinese (Simplified)**, **Chinese (Traditional)** (any combination; fewer is faster). Your choice is remembered.
3. Wait a few seconds per page. Pages are straightened automatically if the scan is slightly crooked, and table lines are removed before reading so tables come out cleanly.

Then:
- **Save / Download** gives a **searchable PDF**: it looks exactly like the scan, but you can search, select and copy the text in any PDF reader (Chinese searches work without spaces between words).
- **Convert** turns the scan into Word, OpenDocument, Excel or CSV, with paragraphs, headings, lists and tables rebuilt from the recognized text. (Choosing Convert on a scan runs text recognition first.)

Measured on test scans (200 DPI, slightly tilted, grey paper with specks): English 99.9% of characters correct, Malay 100%, Chinese Simplified 99.5%, Chinese Traditional 100%.

The desktop app has the recognition engine and all four languages built in (about 15 MB) and works offline. The web version loads them from `vendor/ocr` when served from a website, or from the jsDelivr CDN the first time when the page is opened straight from disk (internet needed once).

Keyboard shortcuts for tools: V select, E edit text, T add text, P draw, H highlight, R box, W whiteout, S sign.

## Limitations

- **Edit text** covers the original words and writes new ones on top, which looks like a direct edit. The original words are still inside the file underneath, so **don't use it to remove confidential information** (they can be copied out with some tools). Word/Excel/CSV export does leave them out.
- Edited and added text use the 12 fonts built into every PDF reader (sans, serif and mono, each in regular, bold, italic and bold italic), matched to the closest original style. A document using an unusual font will look slightly different where edited. These fonts only cover Western European characters; other characters are saved as `?`.
- Edit text works on PDFs that contain real text. Scanned pages are pictures of text: use Whiteout and Add text there.
- **Converting rebuilds the document** from where text and pictures sit on each page (a PDF doesn't store paragraphs or tables). Ordinary documents, reports, letters, invoices and tables convert well. Expect some tidying with: multi-column layouts (newspaper style), text in boxes beside each other, merged table cells, and charts or shapes drawn as lines (only pictures are carried over, not drawn shapes). Text running sideways is skipped.
- Fonts are named as in the PDF; if a font isn't installed on your computer, Word or LibreOffice shows a similar one, so lines may wrap differently.
- Word has one page colour per document: a PDF whose pages have *different* background colours gets shaded paragraphs instead (`.odt` keeps each page's colour).
- **Text recognition** is very accurate on clear printed scans, less so on blurry phone photos, faint copies, decorative fonts or very small print. Handwriting isn't supported. It can't tell which font was used, so converted scans use Arial (or Microsoft YaHei for Chinese) at the recognized size; bold and italic aren't detected. Pictures inside a scanned page aren't carried into Word/Excel. **Edit text** doesn't work on recognized pages yet (use Whiteout and Add text).
- A forgotten password can't be recovered: there is no way to open a locked PDF without it.
- Typed signatures use handwriting fonts installed on your computer (Windows and Mac have several), and saved signatures stay in this browser only.

## How it works

- [`index.html`](index.html), [`styles.css`](styles.css), [`app.js`](app.js): the whole app, no build step.
- [`convert.js`](convert.js): the converter. It reads text, fonts, colours and pictures with pdf.js, rebuilds lines, paragraphs, lists, headings and tables, and writes `.docx`, `.odt`, `.xlsx`, `.ods` and `.csv` directly (they're zip files of XML; a small built-in zip writer makes them, no extra libraries).
- [`signature.js`](signature.js): the signature dialog (draw, type, upload, saved signatures).
- [`ocr.js`](ocr.js): text recognition with [Tesseract](https://github.com/tesseract-ocr/tesseract) via [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), running in WebAssembly. Before reading, each page is straightened, its paper whitened and long table lines erased; afterwards Chinese words are joined so searches match. The engine and the English, Malay and Chinese language data are in [`vendor/ocr`](vendor/ocr).
- [`desktop/`](desktop): the desktop app (Electron).
- [`security.js`](security.js): opening locked PDFs and password-protecting downloads, using [qpdf](https://qpdf.sourceforge.io/) (Apache-2.0) compiled to WebAssembly. It's loaded only when first needed (`vendor/qpdf.js` and `vendor/qpdf-wasm.js`, about 1.8 MB).
- [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) draws the pages; [pdf-lib](https://pdf-lib.js.org/) (MIT) writes the edited PDF. Both are bundled in [`vendor/`](vendor) so the app works offline.
- Edits are stored in PDF coordinates while you work and are written into the original pages when you download, so the original content (text, vector graphics, fonts) is kept as is.
