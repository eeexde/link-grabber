import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { extractAll } from './lib/extractor.js';

const PORT = 4321;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.resolve('public')));

// ---- Server-sent events (extraction progress) ----
const clients = new Set();
function emit(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(data);
}
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// UI log mirrored to disk for troubleshooting.
const LOG_FILE = path.resolve('link-grabber.log');
app.post('/log', (req, res) => {
  fs.appendFile(LOG_FILE, `${new Date().toISOString().slice(0, 10)} ${String(req.body.line || '').slice(0, 2000)}\n`, () => {});
  res.end();
});

/** Name hinted in the URL fragment, e.g. ...#Game.part01.rar */
function nameFromLink(link) {
  try {
    const hash = decodeURIComponent(new URL(link).hash.slice(1));
    return hash ? hash.replace(/[<>:"/\\|?*]/g, '_') : null;
  } catch {
    return null;
  }
}

// Validate links, resolve folder, and mark links whose file already exists (resume support).
app.post('/prepare', (req, res) => {
  const links = (req.body.links || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (!links.length) return res.status(400).json({ error: 'No valid links' });
  const folder = path.resolve(req.body.folder || 'downloads');
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (e) {
    return res.status(400).json({ error: `Cannot create folder: ${e.message}` });
  }
  const items = links.map((link) => {
    const name = nameFromLink(link);
    return { link, name, skip: !!name && fs.existsSync(path.join(folder, name)) };
  });
  res.json({ folder, items });
});

// Move a finished download from <Downloads>\LinkGrabber\ into the chosen folder.
app.post('/move', async (req, res) => {
  try {
    const from = path.resolve(String(req.body.from || ''));
    if (path.basename(path.dirname(from)) !== 'LinkGrabber' || !fs.existsSync(from)) {
      return res.status(400).json({ error: 'Invalid source file' });
    }
    const to = path.join(path.resolve(req.body.folder), path.basename(from));
    if (path.resolve(to) === from) return res.json({ to });
    try {
      await fs.promises.rename(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e; // different drive: copy then delete
      await fs.promises.copyFile(from, to);
      await fs.promises.unlink(from);
    }
    res.json({ to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let extracting = false;
app.post('/extract', async (req, res) => {
  if (extracting) return res.status(409).json({ error: 'Extraction already running' });
  extracting = true;
  try {
    await extractAll(path.resolve(req.body.folder), emit);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    extracting = false;
  }
});

// Native Windows folder picker (browsers can't expose absolute paths).
const PICK_FOLDER_PS = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select download folder'
$d.ShowNewFolderButton = $true
if ($env:START_DIR -and (Test-Path $env:START_DIR)) { $d.SelectedPath = $env:START_DIR }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`;

app.post('/pick-folder', (req, res) => {
  const start = path.resolve(req.body.current || 'downloads');
  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', PICK_FOLDER_PS],
    { env: { ...process.env, START_DIR: start }, windowsHide: true },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ folder: stdout.trim() || null }); // null = cancelled
    });
});

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Link Grabber running at ${url}`);
  if (!process.env.NO_OPEN) exec(`start "" "${url}"`);
});
