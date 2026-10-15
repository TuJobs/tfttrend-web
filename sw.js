/**
 * Service worker cho bản PWA (chủ yếu phục vụ iOS/iPadOS, nơi không có overlay thật).
 * Electron và Android WebView không dùng file này: ở đó tài nguyên vốn đã nằm sẵn trên máy.
 *
 * Chiến lược:
 *  - meta.json  : mạng trước, hỏng thì lấy cache — luôn ưu tiên meta mới nhất.
 *  - trang HTML : mạng trước. index.html trỏ tới tên file JS/CSS có băm; lấy bản
 *                 cache trước thì deploy mới phải mở hai lần mới thấy.
 *  - còn lại    : cache trước, đồng thời cập nhật ngầm cho lần mở sau. Tên file có
 *                 băm nên bản cũ và mới không đè lên nhau.
 */
const VERSION = 'tfttrend-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './meta.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

/**
 * JS/CSS mang tên có băm nên không thể liệt kê cứng ở đây. Đọc index.html rồi rút
 * ra đúng các đường dẫn đang dùng.
 *
 * Không làm bước này thì lần mở đầu tiên gần như không cache được gì: trình duyệt
 * đã nạp xong JS/CSS trước khi service worker kịp kiểm soát trang, phải mở lần hai
 * mới dùng offline được — đo thật ra đúng 4 mục trong cache.
 */
async function precacheShell() {
  const cache = await caches.open(VERSION);
  const urls = new Set(CORE);

  try {
    const html = await (await fetch('./index.html', { cache: 'reload' })).text();
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) urls.add(m[1]);
  } catch {
    /* mất mạng giữa lúc cài: phần còn lại vẫn cache được gì hay nấy */
  }

  // Thiếu một file không được làm hỏng cả lượt cài đặt.
  await Promise.allSettled([...urls].map((url) => cache.add(url)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => precacheIcons())
  );
});

/**
 * 505 icon (~2MB). Tải ngầm sau khi kích hoạt để lần mất mạng đầu tiên vẫn còn đủ
 * hình, chứ không chờ người dùng cuộn qua từng cái. Chạy theo lô nhỏ, lỗi thì bỏ
 * qua — đây là phần thêm, không phải điều kiện sống còn.
 *
 * Đường dẫn suy từ `key` của bốn bảng tra, KHÔNG duyệt tìm trường `icon` nữa:
 * meta.json không còn chép icon (suy được từ khoá), duyệt kiểu cũ sẽ ra rỗng và
 * lần mở đầu tiên mất offline lại chỉ còn vài mục trong cache. Bốn bảng này phủ hết
 * mọi khoá xuất hiện trong file.
 *
 * ĐUÔI ẢNH PHẢI KHỚP `ico()` TRONG `src/data.ts`. Lõi dùng `.png` (art trong game
 * không có bản webp), ba nhóm còn lại `.webp`. Chỗ này từng ghép cứng `.webp` cho
 * cả bốn nhóm: đo ra cache giữ 65/65 tướng, 142/142 món, 36/36 tộc hệ và **0/258
 * lõi** — 258 yêu cầu 404 mỗi lần kích hoạt, và mất mạng thì cả tab Lõi trắng trơn.
 * `cache.add` từ chối khi phản hồi không ok, còn `allSettled` nuốt luôn lỗi, nên
 * hỏng kiểu này im hoàn toàn. Chốt chặn nằm ở `scripts/test-pwa.mjs`: nó đối chiếu
 * số icon đã cache của TỪNG nhóm với số mục trong meta.json, chứ không xem tổng.
 */
const NHOM_ICON = [
  ['champions', 'units', 'webp'],
  ['items', 'items', 'webp'],
  ['augments', 'augments', 'png'],
  ['traits', 'traits', 'webp']
];

async function precacheIcons() {
  try {
    const cache = await caches.open(VERSION);
    const meta = await (await fetch('./meta.json')).json();

    const icons = new Set();
    for (const [nhom, truong, duoi] of NHOM_ICON)
      for (const e of meta[truong] || [])
        if (e && typeof e.key === 'string') icons.add(`./icons/${nhom}/${e.key.toLowerCase()}.${duoi}`);

    const list = [...icons];
    for (let i = 0; i < list.length; i += 24) {
      await Promise.allSettled(
        list.slice(i, i + 24).map(async (url) => {
          if (await cache.match(url)) return;
          await cache.add(url);
        })
      );
    }
  } catch {
    /* không có mạng hoặc meta hỏng: cứ để icon tải theo kiểu cache dần */
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // ảnh dự phòng từ CDN: để trình duyệt tự lo

  const isPage = request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isPage || url.pathname.endsWith('/meta.json')) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);

  const fetching = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached ?? fetching;
}
