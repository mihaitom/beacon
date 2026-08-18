// sw.js — app-shell cache for the Remote Control PWA. Only ever touches
// /remote/app/* (the static shell) — every API call (/remote/state,
// /remote/events, /remote/songs, …) is intentionally left to hit the
// network directly, both because that data is live/real-time and because
// this scope match makes that exclusion automatic rather than a maintained
// list of paths to skip.

const CACHE_NAME = 'beacon-remote-v1';
const SHELL_PATHS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './fonts/mdi.css',
  './fonts/materialdesignicons-webfont.woff2',
  './js/api.js',
  './js/art.js',
  './js/devices.js',
  './js/state.js',
  './js/router.js',
  './js/sheet.js',
  './js/song-row.js',
  './js/views/now-playing.js',
  './js/views/queue.js',
  './js/views/playlists.js',
  './js/views/songs.js',
  './js/views/radio.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !url.pathname.startsWith('/remote/app/')) return;

  // Network-first with a cache fallback — a version bump (new deploy) is
  // picked up immediately on a good connection instead of serving stale
  // shell files indefinitely; the cache only kicks in once offline/unreachable.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
