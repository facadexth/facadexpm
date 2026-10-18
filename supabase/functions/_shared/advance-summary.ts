// _shared/advance-summary.ts -- a worker's advances plus deductions from CLOSED payroll
// periods, summarized with the shared rules. Used by line-webhook (status reply) and
// field-form (advance form: outstanding / pendingOther). Moved out of line-webhook so the
// query lives in one place.
//
// Same join and same rule as useAdvances in src/hooks/usePayroll.js: sum every closed
// line; summarizeAdvances counts an installment only where amount > 0.
// Returns the raw summary plus requestedAtById; null on a lookup error (onError gets it).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { summarizeAdvances } from './advance-logic.ts'

export async function loadAdvanceSummary(
  admin: SupabaseClient,
  tenantId: string,
  workerId: string,
  onError: (msg: string, err: unknown) => void = (m, e) => console.error(m, (e as { message?: string })?.message),
) {
  const { data: advances, error } = await admin.from('salary_advances')
    .select('id, title, amount, installments, status, reject_reason, requested_at')
    .eq('tenant_id', tenantId).eq('worker_id', workerId)
    .order('requested_at', { ascending: false })
  if (error) { onError('salary_advances lookup failed', error); return null }
  const rows = (advances ?? []) as Array<Record<string, any>>
  const ids = rows.filter((r) => r.status === 'approved' || r.status === 'settled').map((r) => r.id as string)
  const closedLines: Array<{ advance_id: string; amount: number }> = []
  if (ids.length) {
    const { data: lines, error: linesError } = await admin.from('salary_record_lines')
      .select('advance_id, amount, salary_records!inner(period_id, payroll_periods!inner(status))')
      .eq('tenant_id', tenantId).in('advance_id', ids)
    if (linesError) { onError('salary_record_lines lookup failed', linesError); return null }
    for (const l of (lines ?? []) as Array<Record<string, any>>) {
      const rec = Array.isArray(l.salary_records) ? l.salary_records[0] : l.salary_records
      const period = Array.isArray(rec?.payroll_periods) ? rec.payroll_periods[0] : rec?.payroll_periods
      if (period?.status === 'closed') closedLines.push({ advance_id: l.advance_id as string, amount: Number(l.amount) })
    }
  }
  const summary = summarizeAdvances(rows, closedLines)
  const requestedAtById = Object.fromEntries(rows.map((r) => [r.id as string, r.requested_at as string | null]))
  return { summary, requestedAtById }
}
