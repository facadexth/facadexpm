// ============================================================
// Supplier tax invoice (ใบกำกับภาษีผู้ขาย) -- pure logic.
// Mirrors supabase/migrations/2026-10-08-01/02 (_sti_tolerance, _sti_wac_after_in,
// _sti_wac_after_reversal, _sti_check). The RPCs are the authority; this is preview/UI.
// ============================================================
import { round2 } from './depositMath.js'
import { computePoItemBaseQty } from './inventoryCost.js'

const EPS = 0.005

/** Owner ruling R1: the smaller of 1% of the base or 5 baht. */
export function matchTolerance(base) {
  return Math.min(Math.abs(Number(base) || 0) * 0.01, 5)
}
export function withinTolerance(diff, base) {
  const d = Number(diff), b = Number(base)
  if (diff === null || diff === '' || base === null || base === '' || !Number.isFinite(d) || !Number.isFinite(b)) return false
  return Math.abs(d) <= matchTolerance(b) + EPS
}
const finiteNum = v => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v))

/** Ex-VAT line amount (ruling A8); the server recomputes and stores the same value. */
export function lineAmount({ qty, unit_price, discount_pct }) {
  const q = Number(qty) || 0, p = Number(unit_price) || 0, d = Number(discount_pct) || 0
  return round2(q * p * (1 - d / 100))
}

export function evaluateMatch({ netBeforeVat, poSubtotals, lineAmounts }) {
  const valid = finiteNum(netBeforeVat) && (poSubtotals || []).every(finiteNum) && (lineAmounts || []).every(finiteNum)
  if (!valid) {
    return { poSum: NaN, diff: NaN, tolerance: NaN, matchOk: false, linesSum: NaN, linesDiff: NaN, linesOk: false, invalid: true }
  }
  const net = round2(Number(netBeforeVat))
  const poSum = round2((poSubtotals || []).reduce((s, x) => s + Number(x), 0))
  const linesSum = round2((lineAmounts || []).reduce((s, x) => s + Number(x), 0))
  const diff = round2(net - poSum)
  const linesDiff = round2(linesSum - net)
  return {
    poSum, diff, tolerance: matchTolerance(poSum), matchOk: withinTolerance(diff, poSum),
    linesSum, linesDiff, linesOk: withinTolerance(linesDiff, net), invalid: false,
  }
}

/** = record_stock_movement purchase_in (new qty 0 -> WAC 0). */
export function wacAfterIn(q, w, a, c) {
  const n = q + a
  return n === 0 ? 0 : (q * w + a * (Number(c) || 0)) / n
}
/** Exact inverse of a receipt (ruling A2). Balance <= 0 keeps WAC; never negative. */
export function wacAfterReversal(q, w, r, c) {
  const n = q - r
  if (n <= 0) return w
  return Math.max((q * w - r * (Number(c) || 0)) / n, 0)
}

/** Same order as the RPC: all invoice lines first, then the PO receipt reversals. */
export function simulateStock({ balances, lines, reversals }) {
  const state = new Map()
  const get = (item, site) => {
    const k = `${item}|${site}`
    if (!state.has(k)) {
      const b = (balances || {})[k] || { qty: 0, wac: 0 }
      const qty = Number(b.qty) || 0, wac = Number(b.wac) || 0
      state.set(k, { inventory_item_id: item, site_id: site, beforeQty: qty, beforeWac: wac, addQty: 0, removeQty: 0, qty, wac })
    }
    return state.get(k)
  }
  for (const l of lines || []) {
    const a = Number(l.base_qty)
    if (l.base_qty == null || !(a > 0)) continue
    const s = get(l.inventory_item_id, l.site_id)
    s.wac = wacAfterIn(s.qty, s.wac, a, l.base_unit_cost); s.qty += a; s.addQty += a
  }
  for (const r of reversals || []) {
    const s = get(r.inventory_item_id, r.site_id), q = Number(r.quantity) || 0
    s.wac = wacAfterReversal(s.qty, s.wac, q, r.unit_cost); s.qty -= q; s.removeQty += q
  }
  return [...state.values()].map(s => ({
    inventory_item_id: s.inventory_item_id, site_id: s.site_id, beforeQty: s.beforeQty, beforeWac: s.beforeWac,
    addQty: s.addQty, removeQty: s.removeQty, afterQty: s.qty, afterWac: s.wac, negative: s.qty < -1e-9,
  }))
}

const monthOf = d => String(d || '').slice(0, 7)

/** Ruling A10: propose by the PO's own date month. */
export function proposePos({ pos, supplierId, invoiceDate, activeLinks, invoiceId }) {
  const month = monthOf(invoiceDate)
  const monthValid = /^\d{4}-\d{2}$/.test(month)
  const inMonth = po => monthValid && monthOf(po.date) === month
  const elsewhere = po => {
    const l = activeLinks?.get?.(po.id)
    return l && l.invoice_id !== invoiceId ? l : null
  }
  const eligible = (pos || []).filter(po => po.supplier_id === supplierId && po.status === 'received')
  return {
    proposed: eligible.filter(po => inMonth(po) && !elsewhere(po)),
    outsideMonth: eligible.filter(po => !inMonth(po) && !elsewhere(po)),
    linkedElsewhere: eligible.filter(po => elsewhere(po)).map(po => ({ po, link: elsewhere(po) })),
  }
}

const normUnit = u => String(u || '').trim().toLowerCase()

/** Ruling A15. factor = the inventory_item_unit_factors row for (item, line.unit) or null. */
export function lineBase(line, invItem, factor) {
  if (!invItem) return { baseQty: null, unconverted: false }
  const qty = Number(line.qty) || 0
  if (line.unit && invItem.base_unit && normUnit(line.unit) === normUnit(invItem.base_unit)) return { baseQty: qty, unconverted: false }
  const r = computePoItemBaseQty({ quantity: qty, unit: line.unit }, invItem, null, factor || null)
  const special = invItem.unit_conversion_mode === 'aluminum_profile' || invItem.unit_conversion_mode === 'glass_dimension'
  const unitMismatch = !special && !factor && !!line.unit && !!invItem.base_unit
  return { baseQty: r.baseQty, unconverted: r.unconverted || unitMismatch }
}

/** Stable signature of everything the server preview depends on. */
export function formSignature(form) {
  const f = form || {}
  return JSON.stringify({
    s: f.supplier_id || '', n: String(f.invoice_no || '').trim(), d: f.invoice_date || '',
    net: String(f.net_before_vat ?? ''), vat: String(f.vat ?? ''), note: String(f.match_note || '').trim(),
    lines: (f.lines || []).map(l => [l.description, l.qty, l.unit, l.unit_price, l.discount_pct, l.inventory_item_id || '', l.site_id || '', l.base_qty ?? '']),
    pos: [...(f.po_ids || [])].sort(),
  })
}
export function previewIsCurrent(preview, form) {
  return !!preview && preview.signature === formSignature(form)
}

export const CHECK_TEXT = {
  invoice_not_found: 'ไม่พบใบกำกับภาษี',
  not_draft: 'ใบกำกับนี้ไม่ใช่ฉบับร่างแล้ว (บันทึกหรือยกเลิกไปแล้ว)',
  not_posted: 'ใบกำกับนี้ยังไม่ได้บันทึก หรือถูกยกเลิกไปแล้ว',
  no_items: 'ยังไม่มีรายการในใบกำกับ',
  no_pos: 'ยังไม่ได้เลือกใบสั่งซื้อ',
  invoice_date_in_future: 'วันที่ใบกำกับอยู่ในอนาคต',
  po_not_found: 'ไม่พบใบสั่งซื้อ',
  po_wrong_supplier: 'ใบสั่งซื้อเป็นของซัพพลายเออร์อื่น',
  po_not_received: 'ใบสั่งซื้อยังไม่ได้รับของ',
  po_linked_elsewhere: 'ใบสั่งซื้อนี้ผูกกับใบกำกับอื่นอยู่แล้ว',
  po_already_reversed: 'สต็อกของใบสั่งซื้อนี้ถูกกลับรายการโดยใบกำกับอื่นแล้ว',
  stock_line_invalid: 'รายการสต็อกไม่ถูกต้อง (สินค้าหรือไซท์งาน)',
  lines_total_mismatch: 'ผลรวมรายการไม่ตรงกับยอดก่อน VAT ของใบกำกับ',
  match_note_required: 'ยอดใบกำกับต่างจากมูลค่าสินค้าในใบสั่งซื้อเกินเกณฑ์ — ต้องกรอกเหตุผล',
  match_outside_tolerance: 'ยอดต่างจากใบสั่งซื้อเกินเกณฑ์ (กรอกเหตุผลแล้ว)',
  po_has_credit_note: 'ใบสั่งซื้อนี้มีใบลดหนี้ — ตรวจว่าใบกำกับหักของที่คืนแล้วหรือยัง',
  po_no_receipt_movements: 'ใบสั่งซื้อนี้ไม่มีการลงสต็อกตอนรับของ (ไม่มีสต็อกให้กลับรายการ)',
  po_stock_from_invoice: 'ใบสั่งซื้อนี้ตั้งให้สต็อกเข้าจากใบกำกับ (ไม่ต้องกลับรายการ)',
  po_stock_flag_but_received_stock: 'ตั้งให้สต็อกเข้าจากใบกำกับ แต่มีการลงสต็อกตอนรับของ — จะถูกกลับรายการ',
  po_outside_month: 'ใบสั่งซื้อนอกเดือนของใบกำกับ',
  po_has_deposit: 'ใบสั่งซื้อนี้หักมัดจำ (เทียบด้วยมูลค่าสินค้า ไม่ใช่ยอดรายจ่าย)',
  po_no_expense: 'ใบสั่งซื้อนี้ไม่มีรายจ่าย (หักมัดจำครบ) — ไม่มีรายจ่ายให้ประทับเลขที่',
  expense_changed: 'เลขที่ใบกำกับในรายจ่ายถูกแก้หลังบันทึก — ไม่ได้คืนเลขเดิม',
  po_data_not_finite: 'ข้อมูลใบสั่งซื้อหรือการรับของมีค่าที่ไม่ใช่ตัวเลข — แก้ข้อมูลก่อนจึงจะบันทึกได้',
  expense_missing: 'ไม่พบรายจ่ายของใบสั่งซื้อนี้ — ไม่ได้ประทับเลขที่ใบกำกับ',
  void_inexact: 'สต็อกมีการเคลื่อนไหวหลังบันทึกใบกำกับ — ยกเลิกแล้ว แต่ต้นทุนเฉลี่ยอาจไม่เท่าเดิมทุกบาท',
  bad_header: 'ข้อมูลหัวใบกำกับไม่ครบหรือไม่ถูกต้อง',
}

const RPC_TEXT = {
  ...CHECK_TEXT,
  insufficient_privilege: 'ไม่มีสิทธิ์ทำรายการนี้ (หรือแพ็กเกจหมดอายุ)',
  void_reason_required: 'กรุณากรอกเหตุผลที่ยกเลิก',
  bad_item: 'ข้อมูลรายการไม่ถูกต้อง',
  stock_line_incomplete: 'รายการที่ผูกสต็อกต้องมีไซท์งานและจำนวนในหน่วยหลักมากกว่า 0',
  po_not_eligible: 'ใบสั่งซื้อที่เลือกใช้ไม่ได้ (ซัพพลายเออร์อื่น หรือยังไม่รับของ)',
  cross_tenant_reference: 'ข้อมูลอ้างอิงไม่ถูกต้อง',
  po_tax_invoiced: 'ใบสั่งซื้อนี้ผูกกับใบกำกับภาษีที่บันทึกแล้ว — ยกเลิกใบกำกับก่อนจึงจะแก้ได้',
  po_stock_flag_locked: 'เปลี่ยน "สต็อกเข้าจากใบกำกับ" หลังรับของไม่ได้',
}
const CODES_LONGEST_FIRST = Object.keys(RPC_TEXT).sort((a, b) => b.length - a.length)

export const DEADLOCK_TEXT = 'ระบบกำลังประมวลผลรายการเดียวกันอยู่ — ข้อมูลไม่เสียหาย กรุณาลองใหม่อีกครั้ง'
export const FEATURE_NOT_READY_TEXT = 'ฟีเจอร์ใบกำกับภาษียังไม่พร้อมใช้งาน'

export const GENERIC_ERROR_TEXT = 'บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือแจ้งผู้ดูแลระบบ'
export const TIMEOUT_TEXT = 'ใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง'
export const SESSION_EXPIRED_TEXT = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'

const NOT_READY_CODES = ['PGRST202', 'PGRST205', '42883', '42P01']
// A bad embed (PGRST200 "Could not find a relationship ... in the schema cache") or an undefined column
// (42703 / PGRST204) is a code bug, NOT a missing migration: those are excluded before the message patterns run.
const NOT_READY_EXCLUDED_CODES = ['PGRST200', 'PGRST204', '42703']
const NOT_READY_EXCLUDED_TEXT = /relationship|\bcolumn\b/i
const NOT_READY_PATTERN = /could not find the (table|function)|schema cache|(relation|function|table) [^|]*does not exist/i
const errText = err => (typeof err === 'string' ? err : [err?.message, err?.details, err?.hint].filter(Boolean).join(' | '))

/** True when the error means the feature's table/function is missing (migration not applied yet).
 *  Accepts a Supabase error object or a plain string (useQuery keeps only err.message). */
export function isTaxInvoiceNotReady(err) {
  if (!err) return false
  const code = typeof err === 'object' ? err.code : null
  if (NOT_READY_EXCLUDED_CODES.includes(code)) return false
  if (NOT_READY_CODES.includes(code)) return true
  const text = errText(err)
  if (NOT_READY_EXCLUDED_TEXT.test(text)) return false
  return NOT_READY_PATTERN.test(text)
}

const CONSTRAINT_TEXT = {
  sti_total_sum_check: 'ยอดรวมไม่เท่ากับยอดก่อน VAT + VAT',
  sti_finite_check: 'ยอดเงินในใบกำกับไม่ถูกต้อง',
  stii_finite_check: 'ตัวเลขในรายการไม่ถูกต้อง',
  stii_stock_fields_check: 'รายการที่ผูกสต็อกต้องมีสินค้า ไซท์งาน และจำนวนในหน่วยหลักครบ',
}

/** Thai text for any error from the tax invoice RPCs/hooks. Unknown errors get a generic Thai text;
 *  the raw text goes to console.error only. */
export function mapTaxInvoiceRpcError(err) {
  const msg = errText(err)
  if (err?.code === '40P01' || /deadlock detected/i.test(msg)) return DEADLOCK_TEXT
  if (isTaxInvoiceNotReady(err)) return FEATURE_NOT_READY_TEXT
  if (err?.code === '23505' || msg.includes('duplicate key')) {
    if (msg.includes('sti_invoice_no_active_uq')) return 'เลขที่ใบกำกับนี้มีอยู่แล้วสำหรับซัพพลายเออร์นี้'
    if (msg.includes('stip_po_active_uq')) return CHECK_TEXT.po_linked_elsewhere
  }
  if (err?.code === '23514' || msg.includes('violates check constraint')) {
    for (const [name, text] of Object.entries(CONSTRAINT_TEXT)) if (msg.includes(name)) return text
  }
  for (const code of CODES_LONGEST_FIRST) if (msg.includes(code)) return RPC_TEXT[code]
  if (err?.code === '42501') return RPC_TEXT.insufficient_privilege
  if (err?.code === '55P03' || err?.code === '40001') return DEADLOCK_TEXT
  if (err?.code === '57014') return TIMEOUT_TEXT
  if (err?.code === 'PGRST301') return SESSION_EXPIRED_TEXT
  console.error('[supplier tax invoice] unmapped error:', err)
  return GENERIC_ERROR_TEXT
}
