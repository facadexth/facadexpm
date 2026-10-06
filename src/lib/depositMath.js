// ============================================================
// Deposit (หักมัดจำ) math -- pure; mirrored in the receive_po_with_deposits
// RPC (supabase/migrations/2026-10-07-02-...sql), which is the authority.
// ============================================================

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100

const EPS = 0.005

export function depositRemaining(deposit, applications) {
  const usedNet = (applications || []).reduce((s, a) => s + Number(a.amount_no_vat || 0), 0)
  const usedVat = (applications || []).reduce((s, a) => s + Number(a.vat || 0), 0)
  return { net: round2(Number(deposit.amount_no_vat) - usedNet), vat: round2(Number(deposit.vat || 0) - usedVat) }
}

export function splitDeduction(deposit, remaining, amountNoVat) {
  const net = round2(amountNoVat)
  if (Math.abs(net - remaining.net) < EPS) return { net, vat: round2(remaining.vat) }
  const rate = Number(deposit.amount_no_vat) > 0 ? Number(deposit.vat || 0) / Number(deposit.amount_no_vat) : 0
  return { net, vat: round2(net * rate) }
}

export function computeReceivePlan({ subtotal, vat }, deductions) {
  const dNet = (deductions || []).reduce((s, d) => s + d.net, 0)
  const dVat = (deductions || []).reduce((s, d) => s + d.vat, 0)
  const netToPay = Math.max(0, round2(subtotal - dNet))
  const vatToPay = Math.max(0, round2(vat - dVat))
  const total = round2(netToPay + vatToPay)
  return { netToPay, vatToPay, total, createExpense: netToPay > EPS || vatToPay > EPS }
}

export function validateDeduction({ supplierOk, remainingNet, amountNoVat, uncoveredNet }) {
  if (!supplierOk) return 'wrong_supplier'
  if (!Number.isFinite(Number(amountNoVat)) || Number(amountNoVat) <= 0) return 'not_positive'
  if (Number(amountNoVat) > remainingNet + EPS) return 'exceeds_remaining'
  if (Number(amountNoVat) > uncoveredNet + EPS) return 'exceeds_po'
  return null
}

export const normalizeDepositRef = s => String(s || '').toLowerCase().replace(/[\s\-_./]/g, '')

export function matchDepositByRef(ref, deposits) {
  const n = normalizeDepositRef(ref)
  if (!n) return null
  return (deposits || []).find(d => normalizeDepositRef(d.deposit_invoice_no) === n) || null
}
