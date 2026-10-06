// Pure logic behind the receive dialog's deposit block (หักมัดจำ).
// The receive_po_with_deposits RPC stays the authority; this is the preview.
import { round2, depositRemaining, splitDeduction, computeReceivePlan, validateDeduction, matchDepositByRef } from './depositMath.js'

const EPS = 0.005

export const DEDUCTION_ERROR_TEXT = {
  wrong_supplier: 'มัดจำของซัพพลายเออร์อื่น',
  not_positive: 'ยอดต้องมากกว่า 0',
  exceeds_remaining: 'เกินยอดมัดจำคงเหลือ',
  exceeds_po: 'เกินยอดสินค้าที่เหลือ',
  bad_limits: 'ยอดไม่ถูกต้อง',
  bad_deposit: 'ข้อมูลมัดจำไม่ถูกต้อง (VAT คงเหลือติดลบ)',
}

const RPC_ERROR_TEXT = {
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
  for (const code of Object.keys(RPC_ERROR_TEXT)) if (msg.includes(code)) return RPC_ERROR_TEXT[code]
  return msg
}

/** Deposits (useSupplierDeposits rows) with remaining net > 0. */
export function openDeposits(rows) {
  const out = []
  for (const d of rows || []) {
    if (!d.expense) continue
    const remaining = depositRemaining(d.expense, d.applications)
    if (remaining.net > EPS) out.push({ ...d, supplier_id: d.expense.supplier_id, remaining })
  }
  return out
}

/** Initial selection from po.deposit_hint: { selection, unmatched: [ref...] }. */
export function selectionFromHint(hint, deposits, supplierId) {
  const selection = {}
  const unmatched = []
  for (const h of Array.isArray(hint) ? hint : []) {
    const m = matchDepositByRef(h?.ref, deposits, supplierId)
    if (m && !selection[m.id]) selection[m.id] = { checked: true, amount: String(h.amount_no_vat ?? '') }
    else if (!m && h?.ref) unmatched.push(h.ref)
  }
  return { selection, unmatched }
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
