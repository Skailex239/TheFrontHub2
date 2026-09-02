/* TheFrontHub — panel de tâches : service worker minimal.
   But : rendre le panel installable comme une application (PWA)
   SANS jamais servir de contenu périmé (aucun cache applicatif :
   tout passe par le réseau, comme d'habitude). */
const SW = 'thefronthub-task-sw-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SW).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  /* Navigations : toujours le réseau (pas de page périmée).
     Les autres requêtes (API, assets) passent normalement. */
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});
