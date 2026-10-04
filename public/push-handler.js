// Imported by the generated service worker (vite.config.js -> workbox.importScripts).
// Shows a notification for each push and opens the right page when it is tapped.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* plain text */ }
  event.waitUntil(self.registration.showNotification(data.title || 'CHANG', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { tab: data.tab || null },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const tab = event.notification.data?.tab
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins[0]
    if (win) {
      if (tab) win.postMessage({ type: 'chang-open-tab', tab })
      return win.focus()
    }
    return self.clients.openWindow(tab ? `/#tab=${encodeURIComponent(tab)}` : '/')
  })())
})
