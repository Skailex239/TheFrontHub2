// sw.js — KILL-SWITCH (site en refonte)
// L'ancien Service Worker (v9, cache-first) est encore installé chez les
// visiteurs déjà venus. Ce remplaçant purge TOUS les caches, se
// désenregistre lui-même et recharge les onglets ouverts : tout le monde
// retombe sur le réseau (donc sur le nouveau site), plus aucune page
// obsolète servie depuis le cache.
const purge = async () => {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch (_) { /* noop */ }
};

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await purge();
    try { await self.registration.unregister(); } catch (_) { /* noop */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) {
        if (c && c.url && c.navigate) c.navigate(c.url).catch(() => {});
      }
    } catch (_) { /* noop */ }
  })());
});
