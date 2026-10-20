// เงินสมทบยกมา / เงินสมทบสะสม helpers. The running total itself is computed in
// the database (contribution_balance / contribution_balances, migration
// 2026-10-20-14) so the web slip, the HR grid and the LINE slip share one rule.

// Opening date offered when a worker has no saved row (FacadeX: end of September 2026).
export const OPENING_DEFAULT_AS_OF = '2026-09-30'

// Worker form → one contribution_openings row to upsert, { skip } or { error }.
// Commas and spaces are stripped ("4,400.38"). Anything else non-numeric is an
// error, never 0. Empty with no saved row writes nothing; empty on a saved row
// stores 0 (rows are never removed from the form).
export function openingSave({ tenantId, workerId, amount, asOf, hadRow }) {
  const rawAmt = amount == null ? '' : String(amount).replace(/[,\s]/g, '')
  const date = asOf ? String(asOf).trim() : ''
  if (rawAmt === '' && !hadRow) return { skip: true }
  const n = rawAmt === '' ? 0 : Number(rawAmt)
  if (!Number.isFinite(n) || n < 0) return { error: 'เงินสมทบยกมาต้องเป็นตัวเลขไม่ติดลบ' }
  if (!date) return { error: 'กรุณาใส่วันที่ยอดเงินสมทบยกมา' }
  return { row: { tenant_id: tenantId, worker_id: workerId, amount: Math.round(n * 100) / 100, as_of: date } }
}

// contribution_balances rows → { worker_id: balance }.
export function balanceMap(rows) {
  return Object.fromEntries((rows || []).map(r => [r.worker_id, Number(r.balance)]))
}
