# Life Events

A small, self-contained webpage for recording life events — yours, your parents',
your friends', your relatives' and above all your kids'. Add a story, tag the people
involved, attach photos, and export the whole thing to Excel. Next time, import that
same Excel file and keep going.

Nothing is uploaded anywhere. No server, no accounts, no internet connection needed.

## Getting started

Double-click `index.html`. That's it.

1. Open the **People** tab and add yourself, your kids, your parents.
2. Hit **+ Add event**, write what happened, tick who it was about, attach photos.
3. Open **Import & Export** and export an **Excel workbook**.
4. Next time you want to add events, either keep using the page, or add rows to the
   Excel file and import it back.

## The Excel round trip

The exported workbook has three sheets:

| Sheet | What it holds |
| --- | --- |
| `Events` | One row per event |
| `People` | One row per person |
| `Read me` | A short reminder of the rules below |

When you import a workbook, records are matched by the **ID** column:

- **Leave the ID alone** on existing rows — that is how the page knows to *update*
  a record instead of creating a second copy of it.
- **Leave the ID blank** on a new row and a new record is created for it.
- The **People** column on an event holds names, comma-separated. A name that
  doesn't exist yet is added as a new person automatically, so you can type
  straight into Excel without touching the People sheet.
- **Dates** are written as `YYYY-MM-DD`. On import, `DD/MM/YYYY` and Excel's own
  date cells are also understood. Ambiguous dates like `05/06/2024` are read
  day-first (5 June).
- **Favourite** accepts `TRUE`/`FALSE`, and also `yes`, `y`, `1`, `x`.

On import you choose **Merge** (update what matches, add the rest) or **Replace**
(wipe this device and load the file).

## Export formats

| Format | Use it for |
| --- | --- |
| **Excel (.xlsx)** | The working format — edit and re-import |
| **JSON backup** | Everything *including photos* — moving to another device |
| **CSV** | Opening the events list anywhere |
| **Printable album** | Opens a print view; choose "Save as PDF" |

## About photos

Spreadsheets can't hold photographs, so:

- The Excel and CSV exports record *which* photos belong to each event (the
  `PhotoIDs` column), not the images themselves. Re-importing on the same browser
  re-attaches them.
- The **JSON backup is the only export that contains the actual images.** Use it
  when moving to another computer, phone or browser.

Photos are shrunk to 1400px and saved as JPEG when you add them, so a few hundred
photos stay manageable.

## Where the data lives

In your browser's local storage, for the specific browser and device you used.

- Clearing your browsing data will erase it. **Export a backup now and then.**
- Photos normally go to IndexedDB. Some browsers block that for pages opened
  directly from a file, in which case the page falls back to a smaller store and
  tells you so — the **This device** panel shows which one is in use.
- If you hit the storage limit, either export a JSON backup and start a fresh file,
  or serve the folder over a local web server, which lifts the restriction:

  ```
  npx serve .
  ```

## Files

```
index.html            the page
assets/styles.css     styling, light and dark
assets/app.js         records, rendering, import/export
assets/storage.js     local persistence (IndexedDB, localStorage fallback)
assets/xlsx-lite.js   dependency-free .xlsx reader/writer
```

`xlsx-lite.js` writes an uncompressed ZIP by hand and reads compressed ones using
the browser's built-in `DecompressionStream`, which is why the page needs no
libraries and no network. It expects a reasonably current Chrome, Edge, Firefox
or Safari.
