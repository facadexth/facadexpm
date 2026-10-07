// src/lib/poReceiptMath.js
// Pure maths for receiving a PO in parts (รับของบางส่วน) and deducting a deposit per receipt (หักมัดจำ).
// Mirrored by _po_receipt_value / receive_po_lines in supabase/migrations/2026-10-09-02-po-receipt-rpcs.sql,
// which are the authority (they may differ by one satang on exact .5 ties; the server value is stored).
import { round2, splitDeduction, computeReceivePlan } from './depositMath.js'
import { calcPoTotals } from './poTotals.js'

const EPS = 0.005

export const DEDUCTION_INPUT_TEXT = {
  not_positive: 'ยอดต้องมากกว่า 0',
  bad_percent: 'เปอร์เซ็นต์ต้องไม่เกิน 100',
  exceeds_remaining: 'เกินยอดมัดจำคงเหลือ',
  exceeds_receipt: 'เกินมูลค่าที่รับครั้งนี้',
  wrong_supplier: 'มัดจำของซัพพลายเออร์อื่น',
  bad_deposit: 'ข้อมูลมัดจำไม่ถูกต้อง (VAT คงเหลือติดลบ)',
}

export function outstandingItems(items, receivedItemIds) {
  const got = receivedItemIds || new Set()
  return (items || []).filter(it => !got.has(it.id))
}

/** Value of one receipt. Non-final: calcPoTotals of the chosen lines, rounded to satang.
 *  Final (nothing outstanding after it): PO totals minus every earlier receipt, so the receipts add up to the PO exactly. */
export function receiptValue({ items, hasVat, priceIncludesVat, lineIds, receivedItemIds, priorReceipts }) {
  const ids = new Set(lineIds || [])
  const chosen = (items || []).filter(it => ids.has(it.id))
  const left = outstandingItems(items, receivedItemIds).filter(it => !ids.has(it.id))
  const isFinal = chosen.length > 0 && left.length === 0
  let subtotal
  let vat
  if (isFinal) {
    const po = calcPoTotals(items, hasVat, priceIncludesVat)
    const prevSub = (priorReceipts || []).reduce((s, r) => s + Number(r.goods_subtotal || 0), 0)
    const prevVat = (priorReceipts || []).reduce((s, r) => s + Number(r.goods_vat || 0), 0)
    subtotal = round2(round2(po.subtotal) - prevSub)
    vat = round2(po.vat - prevVat)
  } else {
    const t = calcPoTotals(chosen, hasVat, priceIncludesVat)
    subtotal = round2(t.subtotal)
    vat = round2(t.vat)
  }
  // priorCount: each earlier receipt is rounded to satang, so a FINAL remainder may sit up to 0.01 x priorCount below 0
  // (e.g. a last delivery of free lines); receive_po_lines tolerates that only without deductions (receiptBillPlan)
  return { subtotal, vat, total: round2(subtotal + vat), isFinal, priorCount: isFinal ? (priorReceipts || []).length : 0 }
}

/** Is this receipt value acceptable, and is it a tolerated negative final remainder? (= receive_po_lines' bad_lines rule)
 *  Non-final, or with deductions: neither part may be negative. Final without deductions: down to -0.01 per earlier receipt. */
export function receiptRange(receipt, hasDeductions) {
  const tol = receipt.isFinal && !hasDeductions ? 0.01 * Number(receipt.priorCount || 0) : 0
  const bad = Number(receipt.subtotal) < -(tol + EPS) || Number(receipt.vat) < -(tol + EPS)
  const tolerated = !bad && receipt.isFinal && !hasDeductions && (Number(receipt.subtotal) < 0 || Number(receipt.vat) < 0)
  return { bad, tolerated }
}

/** Bill for a tolerated negative final remainder (no deductions): the payable total exactly, never a negative field,
 *  no bill when it is worth <= 0. Same shape as computeReceivePlan. */
export function toleratedReceiptPlan({ subtotal, vat }) {
  let net = round2(subtotal)
  let v = round2(vat)
  if (round2(net + v) <= 0) { net = 0; v = 0 }
  else if (v < 0) { net = round2(net + v); v = 0 }
  else if (net < 0) { v = round2(v + net); net = 0 }
  return { netToPay: net, vatToPay: v, total: round2(net + v), createExpense: net > EPS || v > EPS, overNet: false, overVat: false }
}

/** VAT-inclusive input (value in baht, or percent of this receipt incl. VAT) -> stored split.
 *  gross -> net by the deposit's own net/gross ratio, then VAT by R5 (splitDeduction): exact remainder when used up. */
export function deductionFromInput({ mode, value, receiptTotal, deposit, remaining }) {
  const v = Number(value)
  if (value === '' || value == null || !Number.isFinite(v) || v <= 0) return { code: 'not_positive' }
  if (mode === 'percent' && v > 100) return { code: 'bad_percent' }
  const gross = mode === 'percent' ? round2((v / 100) * Number(receiptTotal)) : round2(v)
  if (gross <= 0) return { code: 'not_positive' }
  const remGross = round2(Number(remaining.net) + Number(remaining.vat))
  if (gross > remGross + EPS) return { code: 'exceeds_remaining', gross }
  if (gross > round2(receiptTotal) + EPS) return { code: 'exceeds_receipt', gross }
  if (Math.abs(gross - remGross) < EPS) return { code: null, gross, net: round2(remaining.net), vat: round2(remaining.vat) }
  const dNet = Number(deposit.amount_no_vat)
  const dVat = Number(deposit.vat || 0)
  let net = round2((gross * dNet) / (dNet + dVat))
  if (net > Number(remaining.net)) net = round2(remaining.net)
  if (net <= 0) return { code: 'not_positive', gross }
  const { vat } = splitDeduction(deposit, remaining, net)
  return { code: null, gross, net, vat }
}

/** Default VAT-inclusive deduction (R4) as an input string ('' = nothing to deduct). */
export function defaultDeduction({ own, depositGross, poTotal, remaining, receiptTotal, isFinal, alreadyCovered = 0 }) {
  const remGross = round2(Number(remaining.net) + Number(remaining.vat))
  const room = round2(Number(receiptTotal) - Number(alreadyCovered || 0))
  let g
  if (own && isFinal) g = remGross
  else if (own && Number(poTotal) > 0) g = round2((Number(depositGross) * Number(receiptTotal)) / Number(poTotal))
  else g = remGross
  g = Math.max(0, round2(Math.min(g, remGross, room)))
  return g > 0 ? String(g) : ''
}

/** Aggregates the dialog's deposit rows into the RPC payload, the per-deposit split and the bill preview. */
export function computeReceiveDeductions({ deposits, supplierId, selection, receipt }) {
  const errors = {}
  const lines = {}
  const deductions = []
  const forPlan = []
  let covered = 0
  for (const d of deposits || []) {
    const s = selection?.[d.id]
    if (!s?.checked) continue
    if (d.supplier_id !== supplierId) { errors[d.id] = 'wrong_supplier'; continue }
    if (Number(d.remaining.vat) < 0) { errors[d.id] = 'bad_deposit'; continue }
    const r = deductionFromInput({ mode: s.mode, value: s.value, receiptTotal: receipt.total, deposit: d.expense, remaining: d.remaining })
    if (r.code) { errors[d.id] = r.code; continue }
    if (r.gross > round2(receipt.total - covered) + EPS) { errors[d.id] = 'exceeds_receipt'; continue }
    covered = round2(covered + r.gross)
    lines[d.id] = { gross: r.gross, net: r.net, vat: r.vat }
    forPlan.push({ id: d.id, net: r.net, vat: r.vat, remVat: Number(d.remaining.vat) })
    deductions.push({ deposit_id: d.id, mode: s.mode, value: Number(s.value) })
  }
  const range = receiptRange(receipt, forPlan.length > 0)
  const plan = range.tolerated
    ? toleratedReceiptPlan({ subtotal: receipt.subtotal, vat: receipt.vat })
    : computeReceivePlan({ subtotal: receipt.subtotal, vat: receipt.vat }, forPlan)
  const valid = Object.keys(errors).length === 0 && !range.bad && !plan.overNet && !plan.overVat
  return { deductions, lines, errors, plan, valid, receiptBad: range.bad }
}
