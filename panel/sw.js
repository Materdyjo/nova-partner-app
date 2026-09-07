// Service worker panelu personelu Nova Seafood — odbiera powiadomienia push
// (Web Push / VAPID) i pokazuje je NAWET przy zamkniętym panelu.
//
// Treść przychodzi z Edge Function `notify-push` jako JSON:
//   { title, body, url, tag }
// Nie ma tu żadnej logiki biznesowej ani dostępu do bazy — service worker
// wyłącznie wyświetla powiadomienie i otwiera panel po kliknięciu.

/** Domyślna treść, gdy powiadomienie przyjdzie bez danych (rzadkie). */
const FALLBACK = {
  title: 'Nova Seafood',
  body: 'Nowe zdarzenie w panelu personelu.',
  url: './',
  tag: 'nova',
};

self.addEventListener('install', () => {
  // Nowy worker przejmuje kontrolę od razu — bez czekania na zamknięcie kart.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = FALLBACK;
  if (event.data) {
    try {
      data = { ...FALLBACK, ...event.data.json() };
    } catch {
      data = { ...FALLBACK, body: event.data.text() || FALLBACK.body };
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // Ikona z data: URI — panel nie ma osobnych plików graficznych,
      // a CSP dopuszcza img-src data:.
      icon: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 rx=%2714%27 fill=%27%232a487d%27/%3E%3Ctext x=%2732%27 y=%2743%27 font-family=%27Arial,sans-serif%27 font-size=%2730%27 font-weight=%27700%27 fill=%27white%27 text-anchor=%27middle%27%3Ens%3C/text%3E%3C/svg%3E',
      // tag: kolejne zapytanie zastępuje poprzednie zamiast zasypywać ekran.
      tag: data.tag,
      renotify: true,
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';

  // Jeśli panel jest już gdzieś otwarty — podnieś tę kartę zamiast otwierać nową.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes('/panel/') && 'focus' in client) {
            client.navigate(target).catch(() => {});
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
