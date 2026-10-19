// _shared/customer-push.ts -- push a message to a customer through the TENANT'S OWN LINE OA.
//
// Never goes through the crew bot (_shared/line.ts / LINE_PUSH_ENABLED). Order:
//   1. tenant setting customer_line_push_enabled (missing = ON, 'false' = OFF)
//   2. a recipient exists
//   3. the tenant's OA token exists (read before spending budget, so a tenant without an OA
//      does not burn its daily allowance)
//   4. consume_customer_push(p_tenant) -- 100 per Bangkok day per tenant; fails closed
//   5. POST https://api.line.me/v2/bot/message/push
//
// The result never carries the token, and nothing here logs it or the LINE user id.
// Deps are injected so vitest can test this without Deno or a database.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { parseToggle } from './push-settings.ts'

export const CUSTOMER_PUSH_SETTING = 'customer_line_push_enabled'
export const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'

export type PushSkip = 'off' | 'budget' | 'no_recipient' | 'error'
export type CustomerPushResult = { sent: boolean; skipped?: PushSkip; status?: number }

export type CustomerPushDeps = {
  pushEnabled: (tenantId: string) => Promise<boolean>
  consumeBudget: (tenantId: string) => Promise<boolean>
  accessToken: (tenantId: string) => Promise<string | null>
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>
}

export async function pushToCustomer(
  deps: CustomerPushDeps,
  tenantId: string,
  to: string | null | undefined,
  messages: unknown[],
): Promise<CustomerPushResult> {
  if (!(await deps.pushEnabled(tenantId))) return { sent: false, skipped: 'off' }
  const recipient = String(to ?? '').trim()
  if (!recipient) return { sent: false, skipped: 'no_recipient' }

  let token: string
  try {
    token = String((await deps.accessToken(tenantId)) ?? '').replace(/\s+/g, '')
  } catch {
    token = ''
  }
  if (!token) {
    console.error('customer push: tenant OA not configured', tenantId)
    return { sent: false, skipped: 'error' }
  }

  let allowed = false
  try {
    allowed = (await deps.consumeBudget(tenantId)) === true
  } catch {
    allowed = false
  }
  if (!allowed) return { sent: false, skipped: 'budget' }

  let res: { ok: boolean; status: number }
  try {
    res = await deps.fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipient, messages }),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(15000) : undefined,
    })
  } catch (e) {
    console.error('customer push: LINE unreachable', tenantId, (e as Error)?.name ?? 'Error')
    return { sent: false, skipped: 'error', status: 0 }
  }
  if (!res.ok) {
    console.error('customer push: LINE refused', tenantId, res.status)
    return { sent: false, skipped: 'error', status: res.status }
  }
  return { sent: true, status: res.status }
}

// Real deps from a service-role client.
export function customerPushDeps(
  admin: Pick<SupabaseClient, 'from' | 'rpc'>,
  fetchFn: CustomerPushDeps['fetch'] = (url, init) => fetch(url, init),
): CustomerPushDeps {
  return {
    async pushEnabled(tenantId) {
      const { data, error } = await admin.from('app_settings').select('value')
        .eq('tenant_id', tenantId).eq('key', CUSTOMER_PUSH_SETTING).maybeSingle()
      if (error) {
        // Fail toward the default (ON); the budget is what protects the quota.
        console.error('customer push setting lookup failed', tenantId, (error as { code?: string }).code ?? 'unknown')
        return true
      }
      return parseToggle((data as { value?: unknown } | null)?.value, true)
    },
    async consumeBudget(tenantId) {
      const { data, error } = await admin.rpc('consume_customer_push', { p_tenant: tenantId })
      if (error) {
        console.error('customer push budget check failed', tenantId, (error as { code?: string }).code ?? 'unknown')
        return false
      }
      return data === true
    },
    async accessToken(tenantId) {
      const { data, error } = await admin.rpc('customer_line_creds_by_tenant', { p_tenant: tenantId })
      if (error) return null
      const creds = Array.isArray(data) ? data[0] : data
      const t = (creds as { access_token?: unknown } | null | undefined)?.access_token
      return typeof t === 'string' && t ? t : null
    },
    fetch: fetchFn,
  }
}
