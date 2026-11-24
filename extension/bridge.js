// Runs on the local app page only. Relays messages: page <-> extension background.
let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'lg-ui' });
  } catch {
    return; // extension was reloaded; page needs a refresh
  }
  port.onMessage.addListener((msg) => window.postMessage({ __lg: 'ext', ...msg }, location.origin));
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 500); });
}
connect();

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.__lg !== 'page') return;
  const { __lg, ...msg } = e.data;
  if (!port) connect();
  try { port?.postMessage(msg); } catch { port = null; }
});
