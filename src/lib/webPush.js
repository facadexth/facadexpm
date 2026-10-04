// Web Push (browser/phone notifications) -- client helpers.
// The public key must match the VAPID_PUBLIC_KEY secret of the Edge Functions
// (see supabase/functions/_shared/web-push.ts). It is public by design.
export const VAPID_PUBLIC_KEY = 'BDX5ThKaDY5mz--6gS-1lqFmtLb93SjqGdz5vZ8-rx-kqkGtObNpVNUTq7VfZD3YP4LSmxDwOMzCPbjM9kHSyXQ'

// Page ids a notification may open (see TABS in src/App.jsx). Used only by tests.
export const TABS_FOR_TEST = ['hr', 'purchase_orders', 'sites', 'settings', 'quotations']

export function urlBase64ToUint8Array(base64) {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export function isIos(ua = navigator.userAgent, maxTouch = navigator.maxTouchPoints) {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouch > 1)
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true
}

// 'unsupported' | 'needs-install' (iPhone/iPad: only works from the home-screen app) | 'ok'
export function pushSupport() {
  if (isIos() && !isStandalone()) return 'needs-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return 'ok'
}

export async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

export async function subscribeThisDevice() {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('denied')
  const reg = await navigator.serviceWorker.ready
  return (await reg.pushManager.getSubscription()) ||
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) })
}

export function subscriptionParts(sub) {
  const j = sub.toJSON()
  return { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth }
}
