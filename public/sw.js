// Service worker: guarda só a "casca" do app (HTML, CSS, JS, ícones) para abrir rápido.
// Dados financeiros (/api/*) NUNCA são guardados em cache no aparelho.
const VERSION = 'wf-v1.0.0';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/js/api.js', '/js/ui.js', '/js/state.js', '/js/charts.js', '/js/ocr.js', '/js/views-fin.js', '/js/views-os.js', '/js/views-more.js',
  '/shared/money.js', '/shared/finance.js', '/shared/receipt.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Rede primeiro (sempre a versão mais nova); cache só quando estiver sem internet.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
