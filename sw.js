/* 映画鑑賞記録 Service Worker
   アプリの画面（シェル）をキャッシュして、オフラインでも開けるようにする。
   API通信（TMDB / Gemini / Notion中継）はキャッシュしない。
   ※ 下書きは localStorage に保存されるため、このキャッシュの版数とは無関係に保持される。 */
const CACHE_NAME = "movie-pwa-shell-v4";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=4",
  "./app.js?v=3",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-64.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "no-cache" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 外部APIはネットワークのみ（キャッシュしない）
  if (url.origin !== self.location.origin) return;
  // 同一オリジンはネットワーク優先、失敗したらキャッシュ（更新を取りこぼさないため）
  // HTTPキャッシュ（GitHub Pagesは max-age=600）を経由すると古い版が返ることがあるため、
  // 必ずサーバーへ再検証に行く（no-cache）。
  event.respondWith(
    fetch(req, { cache: "no-cache" }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
