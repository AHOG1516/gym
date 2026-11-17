// 서비스워커: 앱 화면 파일만 캐시해서 인터넷이 없어도 앱이 열리게 함.
// 구글 시트(Apps Script)로 가는 요청은 절대 건드리지 않음.
const CACHE = "gym-v5";
const ASSETS = [
  "./",
  "index.html",
  "routines.json",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // POST(API)는 통과
  if (new URL(req.url).origin !== self.location.origin) return;  // 다른 사이트 요청도 통과

  // 새 버전을 먼저 받아오되, 3초 안에 안 오거나 실패하면 저장해 둔 파일을 씀
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === "navigate" ? await cache.match("index.html") : undefined);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    if (!cached) return fresh;
    fresh.catch(() => {});
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), 3000));
    return Promise.race([fresh.catch(() => cached), timeout]);
  })());
});
