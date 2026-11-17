[Deutsch](README.md) · **English**

# Vintview

A lean viewer for **PDF and spreadsheet files** on Android – fast, dark, no ads, no tracking, no account.

<p>
  <img src="docs/home.png" width="250" alt="Home">
  <img src="docs/pdf.png" width="250" alt="PDF view">
  <img src="docs/excel.png" width="250" alt="Spreadsheet view">
</p>

## Download

👉 **[Download the latest version](https://github.com/hunther2k/vintview/releases/latest)** – open `vintview-x.y.z.apk` on your phone.

The first time, Android asks whether your browser (or file manager) may **install apps** – allow it once, done.

## Features

- **PDF**: smooth scrolling, pinch zoom and double tap, sharp rendering when zoomed, page indicator with “Go to page …”, password-protected PDFs, landscape and mixed page sizes
- **Spreadsheets**: Excel (`xlsx`, `xlsm`, `xls`, `xlsb`), OpenDocument (`ods`) and CSV/TSV
  - sheets as tabs, sticky row and column headers like in Excel
  - column widths, merged cells and hidden rows/columns from the file
  - tap a cell → full content and formula at the bottom
  - CSV: delimiter (`;` `,` tab) and encoding (UTF-8 / Windows) are detected
  - large sheets – rows load while scrolling
- **Open with**: open attachments from email, WhatsApp, file managers etc. directly – choose “Always” to make Vintview the default
- **Recent files**, share, pass on to another app, file info
- **In-app updates**: Vintview checks for a new version on start and installs it with one tap
- German and English (follows the phone language)

Vintview needs no storage permission: files are only read through the Android file picker or “Open with”. The only network access is the update check on GitHub.

## Set as default app

Android does not let apps make themselves the default:

1. Tap a PDF or Excel attachment.
2. Choose **Vintview** and tap **“Always”**.

If another app opens right away, it is already the default: *Settings → Apps → (that app) → Open by default → Clear defaults.*

## Build it yourself

Requirements: JDK 17 and Android SDK (platform 35).

```bash
./gradlew assembleRelease
```

Signing via the environment variables `VV_KEYSTORE`, `VV_KEYSTORE_PASSWORD`, `VV_KEY_ALIAS` or `local.properties` (`vv.keystore`, …). Releases are built by GitHub Actions for every `v*` tag (`scripts/bump.sh`, then `scripts/release.sh "New: …"`).

## License

MIT – see [LICENSE](LICENSE). Bundled libraries: pdf.js (Mozilla) and SheetJS Community Edition, both Apache 2.0 – see [THIRD_PARTY.md](THIRD_PARTY.md).
