// ============================================================
// Deposit (หักมัดจำ) math -- pure; mirrored in the receive_po_with_deposits
// RPC (supabase/migrations/2026-10-07-02-...sql), which is the authority.
// The client preview and the server value can differ by one satang on exact
// .5 rounding ties; the server value is the one stored.
// ============================================================

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100 || 0

const EPS = 0.005

export function depositRemaining(deposit, applications) {
  const usedNet = (applications || []).reduce((s, a) => s + Number(a.amount_no_vat || 0), 0)
  const usedVat = (applications || []).reduce((s, a) => s + Number(a.vat || 0), 0)
  return { net: round2(Number(deposit.amount_no_vat) - usedNet), vat: round2(Number(deposit.vat || 0) - usedVat) }
}

export function splitDeduction(deposit, remaining, amountNoVat) {
  const net = round2(amountNoVat)
  if (Math.abs(net - remaining.net) < EPS) return { net, vat: round2(remaining.vat) }
  const depositAmount = Number(deposit.amount_no_vat)
  const vat = depositAmount > 0 ? round2((net * Number(deposit.vat)) / depositAmount) : 0
  return { net, vat: Math.min(vat, remaining.vat) }
}

export function computeReceivePlan({ subtotal, vat }, deductions) {
  const n = (deductions || []).length
  const dNet = (deductions || []).reduce((s, d) => s + Number(d.net || 0), 0)
  const dVat = (deductions || []).reduce((s, d) => s + Number(d.vat || 0), 0)
  const netRaw = round2(subtotal - dNet)
  let vatRaw = round2(vat - dVat)
  // Deductions cover the whole net: a VAT gap of up to 0.01 per deduction is per-line
  // rounding, not money (the server adjusts the last application) -> no dust expense.
  // Like the RPC, the fold lands on the LAST application (ordered by deposit id when ids are given) and
  // is refused when it would push that application's VAT below zero (the RPC then raises deposit_vat_exceeds_po).
  if (n > 0 && Math.abs(netRaw) <= EPS && Math.abs(vatRaw) > EPS && Math.abs(vatRaw) <= 0.01 * n + 1e-9) {
    const ordered = deductions.every(d => d && d.id != null) ? [...deductions].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) : deductions
    const last = ordered[n - 1]
    if (round2(Number(last.vat || 0) + vatRaw) >= 0) vatRaw = 0
  }
  const netToPay = Math.max(0, netRaw)
  const vatToPay = Math.max(0, vatRaw)
  const total = round2(netToPay + vatToPay)
  const overNet = netRaw < -EPS
  const overVat = vatRaw < -EPS
  return { netToPay, vatToPay, total, createExpense: netToPay > EPS || vatToPay > EPS, overNet, overVat }
}

export function validateDeduction({ supplierOk, remainingNet, amountNoVat, uncoveredNet }) {
  if (!supplierOk) return 'wrong_supplier'
  if (!Number.isFinite(Number(amountNoVat)) || Number(amountNoVat) <= 0) return 'not_positive'
  if (!Number.isFinite(Number(remainingNet)) || !Number.isFinite(Number(uncoveredNet))) return 'bad_limits'
  const amount = round2(amountNoVat)
  if (amount > remainingNet + EPS) return 'exceeds_remaining'
  if (amount > uncoveredNet + EPS) return 'exceeds_po'
  return null
}

/** Map<expense_id, {id, deposit_invoice_no, remaining, used, applied, fullyUsed}> from useSupplierDeposits rows. */
export function buildDepositMap(rows) {
  const m = new Map()
  for (const d of rows || []) {
    const exp = d.expense
    if (!exp) continue
    const apps = d.applications || []
    const remaining = depositRemaining(exp, apps)
    const used = {
      net: round2(apps.reduce((s, a) => s + Number(a.amount_no_vat || 0), 0)),
      vat: round2(apps.reduce((s, a) => s + Number(a.vat || 0), 0)),
    }
    m.set(d.expense_id, { id: d.id, deposit_invoice_no: d.deposit_invoice_no, remaining, used, applied: apps.length > 0, fullyUsed: remaining.net <= EPS })
  }
  return m
}

export const normalizeDepositRef = s => String(s || '').toLowerCase().replace(/[\s\-_./#:()]/g, '')

export function matchDepositByRef(ref, deposits, supplierId) {
  const n = normalizeDepositRef(ref)
  if (!n) return null
  const candidates = (deposits || []).filter(d => {
    if (!d.deposit_invoice_no) return false
    if (normalizeDepositRef(d.deposit_invoice_no) !== n) return false
    if (supplierId !== undefined && d.supplier_id !== supplierId) return false
    return true
  })
  if (candidates.length !== 1) return null
  return candidates[0]
}
