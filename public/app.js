const $ = (id) => document.getElementById(id);
const queue = $('queue'), logEl = $('log');
let items = [];
let current = -1;
let lastTick = { t: 0, bytes: 0 };
let extReady = false;
let job = null; // { folder, extract, moves: Promise }

const fmt = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + ' ' + u[i];
};

function appendLog(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line }) }).catch(() => {});
  appendLog(line);
}

/** Move a finished file into the job folder; tell the extension so a later reload won't redo it. */
function queueMove(index, from) {
  if (!job) return;
  const { folder } = job;
  job.moves = job.moves.then(() => post('/move', { from, folder }))
    .then((r) => { log(`Moved → ${r.to}`); toExt({ type: 'moved', index }); })
    .catch((err) => { if (job) job.moveFailed = true; log(`Move failed for ${from}: ${err.message}`); });
}

/** Rebuild the view from the extension's saved job after a page refresh, then catch up. */
function restore(s, running) {
  items = s.items.map((it) => ({ ...it, meta: it.message, pct: ['done', 'skipped'].includes(it.status) ? 100 : 0 }));
  current = items.findIndex((it) => ['opening', 'downloading'].includes(it.status));
  logEl.textContent = '';
  s.log.forEach(appendLog);
  if (s.folder) $('folder').value = s.folder;
  if (typeof s.extract === 'boolean') $('extract').checked = s.extract;
  if (s.mode) $('mode').value = s.mode;
  job = { folder: s.folder, extract: s.extract, moves: Promise.resolve(), moveFailed: false };
  log(running ? 'Reconnected to running job.' : 'Restored last job.');
  items.forEach((it, i) => { if (it.status === 'done' && it.path && !it.moved) queueMove(i, it.path); });
  render();
  if (s.finished) finish(s.finished);
  else if (!running) finish({ interrupted: true });
}

function render() {
  queue.innerHTML = items.length ? '' : '<li class="empty">Nothing queued.</li>';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="status ${it.status}">${it.status}</span>
      <span class="name"></span><div class="bar"><i style="width:${it.pct || 0}%"></i></div>
      <span class="meta"></span>`;
    li.querySelector('.name').textContent = it.name || it.link;
    li.querySelector('.meta').textContent = it.meta || '';
    queue.appendChild(li);
  }
  const done = items.filter((i) => ['done', 'skipped'].includes(i.status)).length;
  $('summary').textContent = items.length ? `${done} / ${items.length} downloaded` : '';
}

function setRunning(on) {
  $('start').disabled = on || !extReady; $('stop').disabled = !on;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---- Extension bridge ----
const toExt = (msg) => window.postMessage({ __lg: 'page', ...msg }, location.origin);

window.addEventListener('message', (m) => {
  if (m.source !== window || m.data?.__lg !== 'ext') return;
  const e = m.data;
  if (e.type === 'hello') {
    const first = !extReady;
    extReady = true; $('ext-banner').hidden = true;
    if (first) {
      log('Edge extension connected. Ready.');
      if (e.snapshot && !job) restore(e.snapshot, e.running);
    }
    setRunning(e.running || !!job);
    $('summary').textContent ||= 'Extension connected';
    return;
  }
  if (e.type === 'start') {
    log(`Started ${e.count} link(s) in Edge (${$('mode').value})`);
  } else if (e.type === 'item') {
    const it = items[e.index]; if (!it) return;
    current = e.index; lastTick = { t: 0, bytes: 0 };
    Object.assign(it, { status: e.status, name: e.name || it.name });
    if (e.status === 'done' || e.status === 'skipped') it.pct = 100;
    if (e.message) { it.meta = e.message; log(`#${e.index + 1} ${e.status}: ${e.message}`); }
    else log(`#${e.index + 1} ${e.status}${it.name ? ' ' + it.name : ''}`);
    if (e.status === 'done' && e.path) queueMove(e.index, e.path);
  } else if (e.type === 'progress') {
    const it = items[current]; if (!it) return;
    const now = Date.now();
    if (now - lastTick.t < 900) return;
    const speed = lastTick.t ? (e.received - lastTick.bytes) / ((now - lastTick.t) / 1000) : 0;
    lastTick = { t: now, bytes: e.received };
    it.pct = e.total > 0 ? (e.received / e.total) * 100 : 0;
    it.meta = `${fmt(e.received)} / ${e.total > 0 ? fmt(e.total) : '?'}` + (speed > 0 ? ` · ${fmt(speed)}/s` : '');
  } else if (e.type === 'log') {
    log(e.message);
  } else if (e.type === 'finished') {
    finish(e);
  }
  render();
});

async function finish({ stopped, failed, interrupted }) {
  const j = job; if (!j) return setRunning(false);
  await j.moves;
  if (interrupted) log('Previous job was interrupted (browser closed?). Press Start to resume; finished files are skipped.');
  else if (stopped) log('Stopped by user.');
  else if (failed || j.moveFailed) log(`${failed} download(s) failed — skipping extraction. Press Start again; finished files are skipped.`);
  else if (j.extract) {
    log('All downloads done. Extracting…');
    try { await post('/extract', { folder: j.folder }); } catch (err) { log('Extract error: ' + err.message); }
  }
  job = null; setRunning(false); log('Finished.');
  toExt({ type: 'ack' }); // post-processing done; extension can drop its saved job
}

// Extraction progress from the server.
new EventSource('/events').onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === 'extract') log(`Extract ${e.status}: ${e.file || ''}${e.outDir ? ' → ' + e.outDir : ''}${e.message ? ' — ' + e.message : ''}`);
};

// Handshake: the extension's first hello can arrive before this script loads, so keep pinging.
let pings = 0;
const pinger = setInterval(() => {
  if (extReady) return clearInterval(pinger);
  toExt({ type: 'ping' });
  if (++pings === 3) { $('ext-banner').hidden = false; setRunning(false); }
}, 500);
toExt({ type: 'ping' });

// ---- Controls ----
$('start').onclick = async () => {
  if (!extReady) return log('Extension not connected.');
  logEl.textContent = '';
  try {
    const { folder, items: prepared } = await post('/prepare', { links: $('links').value, folder: $('folder').value });
    items = prepared.map((p) => ({ ...p, status: 'queued' }));
    job = { folder, extract: $('extract').checked, moves: Promise.resolve(), moveFailed: false };
    setRunning(true); render();
    log(`Saving to ${folder}`);
    toExt({ type: 'start', items: prepared, mode: $('mode').value, folder, extract: job.extract });
  } catch (err) {
    log('Error: ' + err.message);
  }
};
$('stop').onclick = () => toExt({ type: 'stop' });

try { const saved = localStorage.getItem('folder'); if (saved) $('folder').value = saved; } catch {}
$('folder').onchange = () => { try { localStorage.setItem('folder', $('folder').value); } catch {} };

$('browse').onclick = async () => {
  const btn = $('browse');
  btn.disabled = true; btn.textContent = 'Picking…';
  try {
    const { folder } = await post('/pick-folder', { current: $('folder').value });
    if (folder) { $('folder').value = folder; $('folder').onchange(); }
  } catch (err) {
    log('Folder picker error: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Browse…';
  }
};
