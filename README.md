# Link Grabber

Local web app that downloads a list of file-host links **one at a time** through your own browser profile, saves them into one folder, then extracts every archive into its own folder.

- Sequential: the next download starts only after the previous file is fully complete.
- Runs in a minimized browser window using your real profile (cookies/sessions), via a small extension.
- Clicks the page's **Download** button for you; closes ad popups.
- If a Cloudflare "verify you are human" check appears, the window pops up so you can click it.
- Resume: links whose file already exists in the target folder are skipped.
- Multi-part RAR sets (`.part01.rar`, `.part02.rar`, …) extract once from the first part; `.zip`, `.7z`, `.7z.001` also supported.
- Native Windows folder picker for the destination.

## Requirements

- Windows, Node.js 20+
- Microsoft Edge or Google Chrome (Chromium-based)
- WinRAR or 7-Zip installed (for extraction)

## Setup

```bash
npm install
npm start          # opens http://localhost:4321
```

Load the extension once (in the browser profile you want to use):

1. Open `edge://extensions` (or `chrome://extensions`) and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder of this repo.
3. Refresh the app page. The log shows **"Edge extension connected. Ready."**

Turn off *"Ask where to save each file"* in the browser's download settings, or every file will prompt.

## Usage

1. Paste links, one per line. A `#filename` fragment on each link (e.g. `https://host/abc#Name.part01.rar`) is used as the saved file name.
2. Pick the download folder.
3. Press **Start**. Press **Stop** at any time; the current partial download is deleted.

Files download to `<Downloads>\LinkGrabber\` first (browser extension limit), then the local server moves each one into your chosen folder. When all links succeed, archives are extracted.

## How it works

```
public/        UI page (localhost:4321)
server.js      Express: folder picker, move files, extraction, log
lib/extractor.js  picks archive entry points, runs UnRAR / 7z
extension/     MV3 extension: bridge.js (page <-> extension), background.js (queue)
```

Each link opens in a fresh tab, because browsers block repeated scripted downloads from the same tab ("multiple automatic downloads").

## Disclaimer

Only download content you have the right to download.
