// _shared/push-budget.ts -- every tenant-driven LINE push goes through here.
//
// All tenants share one LINE bot and so one monthly push quota (replies are
// free, pushes are not). consume_line_push() (migration 2026-10-03-05) spends
// one message from the tenant's daily budget and says no once it is used up.
//
// It fails closed: if the budget cannot be checked, nothing is sent. A missed
// notification is recoverable; an unbounded quota burn is not.
//
// `send` is passed in (rather than imported) so this file has no dependency on
// the LINE credentials and can be unit-tested.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type PushResult = { ok: boolean; status: number; skipped?: 'budget' | 'budget_error' }

export async function withPushBudget(
  admin: Pick<SupabaseClient, 'rpc'>,
  tenantId: string,
  send: () => Promise<{ ok: boolean; status: number }>,
): Promise<PushResult> {
  const { data, error } = await admin.rpc('consume_line_push', { p_tenant: tenantId, p_n: 1 })
  if (error) {
    // Log the code only: PostgREST error details can carry row data.
    console.error('line push budget check failed', tenantId, (error as { code?: string }).code ?? 'unknown')
    return { ok: false, status: 0, skipped: 'budget_error' }
  }
  if (data !== true) {
    console.error('line push budget exhausted', tenantId)
    return { ok: false, status: 429, skipped: 'budget' }
  }
  return await send()
}
