// Home Control usa un service worker proprio e non condivide cache con altre app.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  const isStaticGet = event.request.method === 'GET'
    && requestUrl.origin === self.location.origin;

  if (isStaticGet) event.respondWith(fetch(event.request));
});
