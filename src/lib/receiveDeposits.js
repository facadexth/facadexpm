// Pure logic behind the receive dialog's deposit block (หักมัดจำ).
// The receive_po_with_deposits RPC stays the authority; this is the preview.
import { round2, depositRemaining, splitDeduction, computeReceivePlan, validateDeduction, matchDepositByRef, normalizeDepositRef } from './depositMath.js'

const EPS = 0.005

export const DEDUCTION_ERROR_TEXT = {
  wrong_supplier: 'มัดจำของซัพพลายเออร์อื่น',
  not_positive: 'ยอดต้องมากกว่า 0',
  exceeds_remaining: 'เกินยอดมัดจำคงเหลือ',
  exceeds_po: 'เกินยอดสินค้าที่เหลือ',
  bad_limits: 'ยอดไม่ถูกต้อง',
  bad_deposit: 'ข้อมูลมัดจำไม่ถูกต้อง (VAT คงเหลือติดลบ)',
}

export const RPC_ERROR_TEXT = {
  not_ordered: 'ใบสั่งซื้อนี้รับของไปแล้ว',
  deposit_exceeds_remaining: 'ยอดหักเกินมัดจำคงเหลือ (อาจมีการใช้มัดจำไปแล้ว) กรุณาเปิดใหม่',
  deposit_exceeds_po: 'ยอดหักมัดจำเกินยอดใบสั่งซื้อ',
  deposit_wrong_supplier: 'มัดจำเป็นของซัพพลายเออร์อื่น',
  totals_mismatch: 'ยอดใบสั่งซื้อเปลี่ยนไป กรุณาเปิดใหม่',
  deposit_not_found: 'ไม่พบมัดจำที่เลือก',
  deposit_vat_exceeds_po: 'VAT ของมัดจำเกิน VAT ของใบสั่งซื้อ',
  deposit_expense_needs_vat_split: 'รายจ่ายมัดจำยังไม่แยก VAT — แก้ไขที่หน้ารายจ่ายก่อน',
  bad_application: 'ข้อมูลการหักมัดจำไม่ถูกต้อง',
  insufficient_privilege: 'ไม่มีสิทธิ์รับของ',
  po_not_found: 'ไม่พบใบสั่งซื้อ',
}

/** Thai message for an RPC error; unknown codes fall back to the raw message. */
export function mapReceiveRpcError(err) {
  const msg = String(err?.message || err || '')
  // longest code first so a code that contains another is never shadowed
  for (const code of Object.keys(RPC_ERROR_TEXT).sort((a, b) => b.length - a.length)) if (msg.includes(code)) return RPC_ERROR_TEXT[code]
  return msg
}

const hasSplit = d => d.expense && d.expense.amount_no_vat != null && d.expense.vat != null

/** Deposits (useSupplierDeposits rows) with remaining net > 0 (split-less expenses are excluded; see unavailableDeposits). */
export function openDeposits(rows) {
  const out = []
  for (const d of rows || []) {
    if (!hasSplit(d)) continue
    const remaining = depositRemaining(d.expense, d.applications)
    if (remaining.net > EPS) out.push({ ...d, supplier_id: d.expense.supplier_id, remaining })
  }
  return out
}

export const NO_VAT_SPLIT_TEXT = 'ใบมัดจำนี้ยังไม่แยก VAT — แก้ที่หน้ารายจ่ายก่อน'

/** Deposits that cannot be used because their expense has no VAT split: [{id, no, reason}]. */
export function unavailableDeposits(rows) {
  return (rows || []).filter(d => d.expense && !hasSplit(d)).map(d => ({ id: d.id, no: d.deposit_invoice_no, reason: NO_VAT_SPLIT_TEXT }))
}

/** Is the receive dialog allowed to confirm? sel is what ReceiveDepositBlock reported. */
export const canConfirmReceive = sel => !!sel && sel.ready !== false && sel.valid !== false

/** The deposit query has settled (loaded, failed, or table missing) -> receiving may proceed. */
export const isDepositQuerySettled = (rows, error) => rows != null || !!error

/**
 * Initial selection from po.deposit_hint: { selection, unmatched: [{ref, reason}] }.
 * reason: 'used' (matches one fully used deposit), 'ambiguous' (several), 'missing'.
 * allRows (optional) are the unfiltered useSupplierDeposits rows, used only to explain a miss.
 */
export function selectionFromHint(hint, deposits, supplierId, allRows) {
  const selection = {}
  const unmatched = []
  const all = (allRows || deposits || []).map(d => ({ ...d, supplier_id: d.supplier_id ?? d.expense?.supplier_id }))
  for (const h of Array.isArray(hint) ? hint : []) {
    if (!h?.ref) continue
    const n = normalizeDepositRef(h.ref)
    const same = all.filter(d => d.supplier_id === supplierId && normalizeDepositRef(d.deposit_invoice_no) === n && n)
    const m = same.length <= 1 ? matchDepositByRef(h.ref, deposits, supplierId) : null
    if (m && !selection[m.id]) selection[m.id] = { checked: true, amount: String(h.amount_no_vat ?? '') }
    else if (!m) unmatched.push({ ref: h.ref, reason: same.length > 1 ? 'ambiguous' : same.length === 1 ? 'used' : 'missing' })
  }
  return { selection, unmatched }
}

export function unmatchedHintText({ ref, reason }) {
  if (reason === 'used') return `มัดจำเลขที่ ${ref} ใช้หมดแล้ว`
  if (reason === 'ambiguous') return `มัดจำเลขที่ ${ref} ตรงหลายใบ — เลือกเอง`
  return `ไม่พบมัดจำเลขที่ ${ref} ในระบบ — เลือกเอง หรือลงทะเบียนมัดจำที่หน้ารายจ่ายก่อน`
}

/** Default ex-VAT amount for a freshly ticked deposit. */
export function defaultAmount(remainingNet, uncoveredNet) {
  return String(Math.max(0, round2(Math.min(remainingNet, uncoveredNet))))
}

/**
 * deposits: openDeposits() output; selection: {[depositId]: {checked, amount}}.
 * Returns { applications, plan, valid, errors: {[depositId]: code}, lines: {[depositId]: {net, vat}} }.
 */
export function computeReceiveSelection({ deposits, supplierId, totals, selection }) {
  const errors = {}
  const lines = {}
  const applications = []
  const deductions = []
  let coveredNet = 0
  for (const d of deposits || []) {
    const sel = selection?.[d.id]
    if (!sel?.checked) continue
    const amount = Number(sel.amount)
    const uncoveredNet = round2(totals.subtotal - coveredNet)
    const err = validateDeduction({
      supplierOk: d.supplier_id === supplierId, remainingNet: d.remaining.net, amountNoVat: sel.amount === '' ? NaN : amount, uncoveredNet,
    })
    if (err) { errors[d.id] = err; continue }
    if (d.remaining.vat < 0) { errors[d.id] = 'bad_deposit'; continue }
    const split = splitDeduction(d.expense, d.remaining, amount)
    lines[d.id] = split
    deductions.push(split)
    applications.push({ deposit_id: d.id, amount_no_vat: split.net })
    coveredNet = round2(coveredNet + split.net)
  }
  const plan = computeReceivePlan({ subtotal: totals.subtotal, vat: totals.vat }, deductions)
  const valid = Object.keys(errors).length === 0 && !plan.overNet && !plan.overVat
  return { applications, plan, valid, errors, lines }
}
