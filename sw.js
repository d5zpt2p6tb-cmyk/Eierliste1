/* =====================================================================
 * sw.js – Service Worker: macht die App offline nutzbar
 * ---------------------------------------------------------------------
 * Strategie: Alle App-Dateien werden beim ersten Besuch in den Cache gelegt
 * und danach immer aus dem Cache geliefert (cache-first).
 *
 * WICHTIG BEI UPDATES: Wenn du Dateien änderst und neu hochlädst, hier die
 * Versionsnummer hochzählen (z. B. 'eierliste-v2'). Nur dann holt sich das
 * Handy die neuen Dateien. Deine Daten bleiben dabei unberührt (die liegen in
 * IndexedDB, nicht im Cache).
 * ===================================================================== */
var CACHE = 'eierliste-v1';
var FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'style.css',
  'logic.js',
  'db.js',
  'minichart.js',
  'app.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).catch(function () {
        // Offline und nicht im Cache: bei Seitenaufrufen die Startseite zeigen
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
