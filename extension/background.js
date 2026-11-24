// Link Grabber Helper — runs the sequential download queue inside the user's real Edge profile.
const SUBFOLDER = 'LinkGrabber'; // relative to the browser's Downloads folder (downloads API limit)
const ports = new Set();
let job = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rootDomain = (u) => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return ''; } };
const basename = (p) => p.split(/[\\/]/).pop();

function send(msg) {
  for (const p of ports) { try { p.postMessage(msg); } catch {} }
}

/** Poll cond() every 200ms for up to ms. Extension API calls in loops also keep the worker alive. */
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(200);
}

// Visible entry points: open (or focus) the app page on install/reload and on toolbar click.
const APP_URL = 'http://localhost:4321/';
async function openApp() {
  const [tab] = await chrome.tabs.query({ url: ['http://localhost:4321/*', 'http://127.0.0.1:4321/*'] });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.reload(tab.id); // re-inject bridge.js so the page connects
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
}
chrome.runtime.onInstalled.addListener(() => openApp().catch(() => {}));
chrome.action.onClicked.addListener(() => openApp().catch(() => {}));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'lg-ui') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === 'start') startJob(msg).catch((e) => send({ type: 'log', message: 'Fatal: ' + e.message }));
    else if (msg.type === 'stop') stopJob();
    else if (msg.type === 'ping') port.postMessage({ type: 'hello', running: !!job });
  });
  port.postMessage({ type: 'hello', running: !!job });
});

// ---- Download capture -------------------------------------------------------

function isOurs(item) {
  if (!job || job.current == null) return false;
  const want = rootDomain(job.items[job.current].link);
  return [item.url, item.finalUrl, item.referrer].some((u) => u && rootDomain(u) === want);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!isOurs(item)) return suggest();
  if (job.dlId == null) {
    job.dlId = item.id;
    const name = job.items[job.current].name || item.filename;
    suggest({ filename: `${SUBFOLDER}/${name}`, conflictAction: 'overwrite' });
  } else {
    suggest();
    if (item.id !== job.dlId) chrome.downloads.cancel(item.id).catch(() => {}); // duplicate from a repeat click
  }
});

// Track popups/ad tabs spawned by our window so we can close them.
chrome.tabs.onCreated.addListener((tab) => {
  if (job && (tab.windowId === job.windowId || job.tabIds.has(tab.openerTabId))) job.tabIds.add(tab.id);
});

// ---- Page interaction ------------------------------------------------------

/** Injected into the host page (MAIN world). Returns 'cf' | 'loading' | 'none' | 'clicked'. */
function pageProbe() {
  if (/just a moment|attention required/i.test(document.title)) return 'cf';
  if (document.readyState === 'loading') return 'loading';
  // Capture window.open targets: a real-browser popup blocker may block the download popup,
  // so if the button tries to open a same-site URL we navigate to it directly instead.
  if (!window.__lgHooked) {
    window.__lgHooked = true;
    window.__lgOpened = [];
    const orig = window.open;
    window.open = function (u, ...rest) { window.__lgOpened.push(String(u)); return orig.call(window, u, ...rest); };
  }
  const label = (x) => (x.innerText || x.value || '').trim();
  const els = [...document.querySelectorAll('button, a, input[type=button], input[type=submit]')];
  const el = els.find((x) => /^download$/i.test(label(x))) || els.find((x) => /download/i.test(label(x)));
  if (!el) return 'none';
  el.click();
  const host = location.hostname.split('.').slice(-2).join('.');
  const same = window.__lgOpened.find((u) => {
    try { return new URL(u, location.href).hostname.endsWith(host); } catch { return false; }
  });
  if (same) { window.__lgOpened = []; location.href = new URL(same, location.href).href; }
  return 'clicked';
}

async function probe(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageProbe });
    return r?.result || 'loading';
  } catch {
    return 'loading'; // tab mid-navigation or not injectable yet
  }
}

// ---- Job control ------------------------------------------------------------

async function processItem(i) {
  const it = job.items[i];
  job.current = i;
  job.dlId = null;
  send({ type: 'item', index: i, status: 'opening', name: it.name });
  // Fresh tab per link: the browser's "multiple automatic downloads" limiter is per tab, and our
  // scripted click isn't a user gesture, so a reused tab silently blocks every download after the first.
  const oldTabId = job.mainTabId;
  const tab = await chrome.tabs.create({ windowId: job.windowId, url: it.link, active: true });
  job.mainTabId = tab.id;
  job.tabIds = new Set([tab.id]);
  chrome.tabs.remove(oldTabId).catch(() => {});

  // Phase 1: get past Cloudflare and click until the browser reports a download.
  const t0 = Date.now();
  let shown = false;
  let state = 'loading';
  while (job.dlId == null) {
    if (job.stopped) throw new Error('Stopped');
    state = await probe(job.mainTabId);
    if (state === 'cf' && !shown && job.mode !== 'visible' && Date.now() - t0 > 15000) {
      shown = true;
      await chrome.windows.update(job.windowId, { state: 'normal', focused: true }).catch(() => {});
      send({ type: 'log', message: 'Cloudflare check needs you: click the checkbox in the Edge window that just appeared.' });
    }
    if (Date.now() - t0 > (shown ? 200000 : 90000)) {
      throw new Error(state === 'none' ? 'No download button found' : state === 'cf' ? 'Stuck on Cloudflare check' : 'Download never started');
    }
    await waitFor(() => job.dlId != null || job.stopped, state === 'clicked' ? 5000 : 1000);
  }
  if (shown) chrome.windows.update(job.windowId, { state: 'minimized' }).catch(() => {});

  // Download has started: close ad popups and park the tab (it is replaced on the next link).
  for (const id of job.tabIds) if (id !== job.mainTabId) chrome.tabs.remove(id).catch(() => {});
  job.tabIds = new Set([job.mainTabId]);
  chrome.tabs.update(job.mainTabId, { url: 'about:blank' }).catch(() => {});

  // Phase 2: wait for completion. Next link starts only after this returns.
  send({ type: 'item', index: i, status: 'downloading', name: it.name });
  for (;;) {
    const [d] = await chrome.downloads.search({ id: job.dlId });
    if (!d) throw new Error('Download disappeared');
    if (d.state === 'complete') {
      send({ type: 'item', index: i, status: 'done', name: it.name || basename(d.filename), path: d.filename });
      return;
    }
    if (d.state === 'interrupted') throw new Error(job.stopped ? 'Stopped' : 'Interrupted: ' + d.error);
    send({ type: 'progress', received: d.bytesReceived, total: d.totalBytes });
    await waitFor(() => job.stopped, 1000);
  }
}

async function startJob({ items, mode }) {
  if (job) return send({ type: 'log', message: 'A job is already running in the extension.' });
  job = { items, mode, current: null, dlId: null, tabIds: new Set(), stopped: false, failed: 0 };
  send({ type: 'start', count: items.length });
  try { chrome.downloads.setUiOptions?.({ enabled: false }); } catch {} // hide download bubble

  const win = await chrome.windows.create({ url: 'about:blank', focused: mode === 'visible' });
  job.windowId = win.id;
  job.mainTabId = win.tabs[0].id;
  job.tabIds.add(job.mainTabId);
  if (mode !== 'visible') await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});

  try {
    for (let i = 0; i < items.length && !job.stopped; i++) {
      if (items[i].skip) {
        send({ type: 'item', index: i, status: 'skipped', name: items[i].name, message: 'Already exists' });
        continue;
      }
      try {
        await processItem(i);
      } catch (e) {
        if (job.stopped) { send({ type: 'item', index: i, status: 'stopped', message: 'Stopped by user' }); break; }
        job.failed++;
        send({ type: 'item', index: i, status: 'error', message: e.message });
      }
    }
  } finally {
    const { stopped, failed, windowId } = job;
    job = null;
    chrome.windows.remove(windowId).catch(() => {});
    try { chrome.downloads.setUiOptions?.({ enabled: true }); } catch {}
    send({ type: 'finished', stopped, failed });
  }
}

function stopJob() {
  if (!job) return;
  job.stopped = true;
  if (job.dlId != null) chrome.downloads.cancel(job.dlId).catch(() => {}); // browser deletes partial file
}
