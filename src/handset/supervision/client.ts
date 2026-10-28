// A disconnected display keeps its last observations, with an explicit age.
// An authority refusal clears them instead of keeping a revoked view alive.
export const supervisionClient = `
const root = document.querySelector('[data-supervision-url]');
if (root) {
 const status = document.getElementById('supervision-freshness');
 const live = document.getElementById('supervision-live');
 let last = performance.now(), stopped = false, pending = false;
 const controls = () => document.querySelectorAll('[data-supervision-action] button');
 function stale() {
  status.textContent = 'Stale — updates unavailable. Last observed values retained; do not assume the queue is healthy.';
  status.setAttribute('role', 'alert');
  controls().forEach(button => button.disabled = true);
 }
 setInterval(() => { if (!stopped && performance.now() - last >= 7000) stale(); }, 500);
 async function poll() {
  if (pending || stopped) return;
  pending = true;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
  try {
   const response = await fetch(root.dataset.supervisionUrl, {cache:'no-store', signal:controller.signal});
   if ([401,403,404].includes(response.status)) {
    stopped = true;
    live.replaceChildren();
    document.querySelectorAll('[data-supervision-action]').forEach(form => form.remove());
    status.textContent = 'Access unavailable — the current supervision scope is no longer valid. Reload after the owner grants access.';
    status.setAttribute('role','alert');
    return;
   }
   if (!response.ok) throw new Error('updates unavailable');
   const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
   const next = doc.getElementById('supervision-live');
   if (!next) throw new Error('updates unavailable');
   live.replaceChildren(...next.childNodes);
   last = performance.now();
   status.textContent = 'Live — refreshed every 3 seconds. Last received ' + new Date().toISOString();
   status.setAttribute('role','status');
   controls().forEach(button => button.disabled = false);
  } catch { stale(); }
  finally { clearTimeout(timer); pending = false; }
 }
 setInterval(poll, 3000);
}
`;
