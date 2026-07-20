/**
 * Service worker — makes the app installable and usable offline.
 * Strategy: stale-while-revalidate (serve cache instantly, refresh in the
 * background so the next load picks up new deploys).
 */

const CACHE = 'b2d-v21'; // keep in lockstep with js/version.js
const SAMPLES = ['kick', 'snare', 'hat', 'openhat', 'tom', 'tomfloor', 'rimshot', 'crash']
  .flatMap((d) => [1, 2, 3, 4, 5].map((i) => `samples/real/${d}_${i}.wav`));
const ASSETS = [
  '.',
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/audio-engine.js',
  'js/classifier.js',
  'js/recorder.js',
  'js/groove.js',
  'js/waveform.js',
  'js/sample-kit.js',
  'js/clip-analysis.js',
  'js/neural.js',
  'js/version.js',
  ...SAMPLES,
  'js/metronome.js',
  'js/timeline.js',
  'js/worklet/onset-processor.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const fresh = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
