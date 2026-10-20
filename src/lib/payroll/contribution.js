// เงินสมทบยกมา / เงินสมทบสะสม helpers. The running total itself is computed in
// the database (contribution_balance / contribution_balances, migration
// 2026-10-20-14) so the web slip, the HR grid and the LINE slip share one rule.

// Worker form → one contribution_openings row to upsert, { skip } or { error }.
// A saved row is never removed from the form: clearing the amount stores 0.
export function openingSave({ tenantId, workerId, amount, asOf, hadRow }) {
  const rawAmt = amount == null ? '' : String(amount).trim()
  const date = asOf ? String(asOf).trim() : ''
  if (rawAmt === '' && date === '' && !hadRow) return { skip: true }
  const n = rawAmt === '' ? 0 : Number(rawAmt)
  if (!Number.isFinite(n) || n < 0) return { error: 'เงินสมทบยกมาต้องเป็นตัวเลขไม่ติดลบ' }
  if (!date) return { error: 'กรุณาใส่วันที่ยอดเงินสมทบยกมา' }
  return { row: { tenant_id: tenantId, worker_id: workerId, amount: Math.round(n * 100) / 100, as_of: date } }
}

// contribution_balances rows → { worker_id: balance }.
export function balanceMap(rows) {
  return Object.fromEntries((rows || []).map(r => [r.worker_id, Number(r.balance)]))
}
