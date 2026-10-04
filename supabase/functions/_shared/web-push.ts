// _shared/web-push.ts -- sends Web Push notifications to devices an OWNER/ADMIN has turned on.
//
// Free, and separate from the LINE message quota. Devices live in push_subscriptions
// (migration 2026-10-04-01). Never throws: a notification is a courtesy and must not break
// the request that triggered it. A device the push service says is gone (404/410), or that
// fails MAX_FAILURES times in a row, is removed.
//
// The VAPID keys are Edge Function secrets (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT); the public key is also hard-coded in src/lib/webPush.js, which must match.

import webpush from 'npm:web-push@3.6.7'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { PushPayload } from './web-push-messages.ts'

export type PushSub = { id: string; endpoint: string; p256dh_key: string; auth_key: string; failure_count: number }
export type PushResult = { sent: number; failed: number; removed: number }

const MAX_FAILURES = 5
const EMPTY: PushResult = { sent: 0, failed: 0, removed: 0 }
let configured = false

function configure(): boolean {
  if (configured) return true
  const pub = Deno.env.get('VAPID_PUBLIC_KEY')?.trim()
  const priv = Deno.env.get('VAPID_PRIVATE_KEY')?.trim()
  const subject = Deno.env.get('VAPID_SUBJECT')?.trim()
  if (!pub || !priv || !subject) {
    console.error('web push: VAPID keys are not configured')
    return false
  }
  try {
    webpush.setVapidDetails(subject, pub, priv)
    configured = true
    return true
  } catch (e) {
    console.error('web push: invalid VAPID configuration', (e as Error).message)
    return false
  }
}

export async function sendToSubscriptions(admin: SupabaseClient, subs: PushSub[], payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { ...EMPTY }
  if (subs.length === 0 || !configure()) return result
  const body = JSON.stringify(payload)
  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh_key, auth: s.auth_key } },
        body,
        { TTL: 60 * 60 * 24, urgency: 'normal' },
      )
      result.sent++
      await admin.from('push_subscriptions').update({ last_ok_at: new Date().toISOString(), failure_count: 0 }).eq('id', s.id)
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      result.failed++
      console.error('web push send failed', status ?? 'unknown')
      if (status === 404 || status === 410 || s.failure_count + 1 >= MAX_FAILURES) {
        await admin.from('push_subscriptions').delete().eq('id', s.id)
        result.removed++
      } else {
        await admin.from('push_subscriptions').update({ failure_count: s.failure_count + 1 }).eq('id', s.id)
      }
    }
  }))
  return result
}

const SUB_COLUMNS = 'id, endpoint, p256dh_key, auth_key, failure_count'

// Every device of the company's current OWNERs and ADMINs.
export async function sendWebPushToTenantAdmins(admin: SupabaseClient, tenantId: string, payload: PushPayload): Promise<PushResult> {
  try {
    const { data: roles } = await admin.from('user_roles').select('user_email').eq('tenant_id', tenantId).in('role', ['OWNER', 'ADMIN'])
    const emails = (roles ?? []).map((r) => r.user_email as string)
    if (emails.length === 0) return { ...EMPTY }
    const { data: subs } = await admin.from('push_subscriptions').select(SUB_COLUMNS).eq('tenant_id', tenantId).in('user_email', emails).limit(200)
    return await sendToSubscriptions(admin, (subs ?? []) as PushSub[], payload)
  } catch (e) {
    console.error('web push to admins failed', (e as Error).message)
    return { ...EMPTY }
  }
}

// One person's devices (used by the "send me a test" button).
export async function sendWebPushToUser(admin: SupabaseClient, tenantId: string, email: string, payload: PushPayload): Promise<PushResult & { devices: number }> {
  try {
    const { data: subs } = await admin.from('push_subscriptions').select(SUB_COLUMNS).eq('tenant_id', tenantId).eq('user_email', email).limit(50)
    const list = (subs ?? []) as PushSub[]
    return { devices: list.length, ...(await sendToSubscriptions(admin, list, payload)) }
  } catch (e) {
    console.error('web push to user failed', (e as Error).message)
    return { devices: 0, ...EMPTY }
  }
}
