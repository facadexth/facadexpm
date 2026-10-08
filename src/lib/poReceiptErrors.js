// src/lib/poReceiptErrors.js
// Thai text for the receipt / deposit / split RPCs and triggers (2026-10-09-01..02), PO money locks, and the
// pure summary behind the PO popup. Pure; no Supabase calls here.
import { RPC_ERROR_TEXT, PO_DEPOSIT_LOCKED_TEXT, openDeposits } from './receiveDeposits.js'
import { depositRemaining, round2 } from './depositMath.js'
import { poTaxInvoiceErrorText } from './poTaxInvoiceStatus.js'
import { RECEIVE_DELIVERY_DISCOUNT_TEXT } from './deliveryTaxInvoiceText.js'

export const PO_RECEIPT_LOCKED_TEXT = 'ใบสั่งซื้อนี้รับของแล้ว แก้ไขหรือยกเลิกไม่ได้ — แจ้งผู้ดูแลระบบ'
export const DB_NOT_UPDATED_TEXT = 'ระบบยังไม่ได้อัปเดตฐานข้อมูล — แจ้งผู้ดูแลระบบ'
export const PO_HAS_DEPOSIT_TEXT ='ใบสั่งซื้อนี้มีใบมัดจำแล้ว แก้ไขหรือยกเลิกไม่ได้ — แจ้งผู้ดูแลระบบ'

export const PO_RECEIPT_ERROR_TEXT = {
  ...RPC_ERROR_TEXT,
  po_not_receivable: 'ใบสั่งซื้อนี้รับของครบแล้วหรือยกเลิกแล้ว กรุณาเปิดใหม่',
  po_has_deposit_applications: PO_DEPOSIT_LOCKED_TEXT,
  bad_received_date: 'กรุณาเลือกวันที่รับสินค้า',
  received_date_in_future: 'วันที่รับสินค้าต้องไม่เกินวันนี้',
  bad_lines: 'รายการที่เลือกไม่ถูกต้อง กรุณาเปิดใหม่',
  line_already_received: 'บางรายการถูกรับไปแล้ว (อาจกดซ้ำหรือมีคนรับพร้อมกัน) กรุณาเปิดใหม่',
  bad_deduction: 'ยอดหักมัดจำไม่ถูกต้อง',
  deposit_exceeds_receipt: 'ยอดหักมัดจำเกินมูลค่าที่รับครั้งนี้',
  deposit_vat_exceeds_receipt: 'VAT ที่หักเกิน VAT ของการรับครั้งนี้',
  bad_stock_plan: 'ข้อมูลลงสต็อกไม่ครบหรือไม่ถูกต้อง กรุณาเปิดใหม่',
  stock_cost_mismatch: 'ต้นทุนลงสต็อกไม่ตรงกับยอดรายการ กรุณาเปิดใหม่',
  po_not_ordered: 'สร้างมัดจำได้เฉพาะใบสั่งซื้อที่สั่งแล้วและยังไม่ได้รับของ',
  po_no_supplier: 'ใบสั่งซื้อนี้ยังไม่มี Supplier',
  po_has_deposit: PO_HAS_DEPOSIT_TEXT,
  po_has_receipts: PO_RECEIPT_LOCKED_TEXT,
  po_status_rpc_only: 'เปลี่ยนสถานะเป็นรับบางส่วนได้จากปุ่มรับของเท่านั้น',
  deposit_invoice_no_required: 'กรุณากรอกเลขที่ใบเสร็จ/ใบกำกับมัดจำ',
  deposit_invoice_no_taken: 'เลขที่มัดจำนี้มีในระบบแล้ว',
  bad_deposit_date: 'วันที่จ่ายมัดจำต้องไม่เกินวันนี้',
  bad_payment_method: 'วิธีชำระไม่ถูกต้อง',
  bad_deposit_status: 'สถานะไม่ถูกต้อง',
  bad_deposit_value: 'ยอดมัดจำไม่ถูกต้อง',
  expense_not_found: 'ไม่พบรายจ่ายนี้ กรุณาเปิดใหม่',
  not_a_po_bill: 'จ่ายบางส่วนได้เฉพาะบิลจากใบสั่งซื้อ',
  bill_is_credit_note: 'รายการนี้เป็นใบลดหนี้ จ่ายบางส่วนไม่ได้',
  bill_is_deposit: 'รายการนี้เป็นมัดจำ จ่ายบางส่วนไม่ได้',
  bill_is_cheque: 'บิลนี้ผูกกับเช็คแล้ว จ่ายบางส่วนไม่ได้',
  bill_not_pending: 'จ่ายบางส่วนได้เฉพาะบิลสถานะค้างจ่าย',
  bad_paid_date: 'วันที่จ่ายต้องไม่เกินวันนี้',
  bad_split_amount: 'ยอดที่จ่ายต้องมากกว่า 0 และน้อยกว่ายอดบิล',
  bill_bad_split: 'ยอดก่อน VAT + VAT ของบิลไม่เท่ากับยอดรวม — แก้ที่หน้ารายจ่ายก่อน',
  expense_is_receipt_bill: 'ลบไม่ได้ — รายจ่ายนี้เป็นบิลรับของของใบสั่งซื้อ',
  expense_is_split_part: 'ลบไม่ได้ — รายจ่ายนี้แยกมาจากการจ่ายบางส่วน',
  insufficient_privilege: 'ไม่มีสิทธิ์ทำรายการนี้',
  deposit_other_po: 'มัดจำนี้ผูกกับใบสั่งซื้ออื่นแล้ว ใช้กับใบสั่งซื้อนี้ไม่ได้',
  deposit_linked_to_po: 'ลบไม่ได้ — มัดจำนี้ผูกกับใบสั่งซื้อ',
  bill_changed: 'บิลนี้เปลี่ยนไประหว่างทำรายการ กรุณาเปิดใหม่',
  deposit_in_use: 'มัดจำนี้ถูกใช้หักแล้ว แก้ไขหรือลบไม่ได้',
  cross_tenant_reference: 'ข้อมูลที่อ้างถึงไม่ถูกต้อง กรุณาเปิดใหม่',
  deposit_expense_is_po_generated: 'รายจ่ายนี้เป็นมัดจำที่สร้างจากใบสั่งซื้อ ลบหรือแก้ไขไม่ได้',
  po_tax_invoiced: 'ใบสั่งซื้อนี้ผูกกับใบกำกับภาษีแล้ว ทำรายการไม่ได้',
}

/** Thai message for an RPC / trigger error; unknown codes fall back to the raw message. */
export function mapPoReceiptRpcError(err) {
  const tax = poTaxInvoiceErrorText(err)   // po_tax_invoiced, po_stock_flag_locked, 40P01 deadlock
  if (tax) return tax
  const msg = String(err?.message || err || '')
  // the RPC is not deployed yet (migration not applied): PostgREST PGRST202 "Could not find the function ..."
  if (err?.code === 'PGRST202' || /could not find the function/i.test(msg)) return DB_NOT_UPDATED_TEXT
  const codes = Object.keys(PO_RECEIPT_ERROR_TEXT).sort((a, b) => b.length - a.length)
  // message first, then details, then hint
  for (const hay of [msg, err?.details, err?.hint]) {
    if (!hay) continue
    for (const code of codes) if (String(hay).includes(code)) return PO_RECEIPT_ERROR_TEXT[code]
  }
  return msg
}

/** schemaReady = false when the receipt tables / po_id column are missing (pre-migration soft fail): the index is
 *  then empty and the new receive dialog must not be offered (receive_po_lines does not exist yet). */
export function buildPoMoneyIndex({ receiptItems, deposits, bills, schemaReady = true }) {
  const m = new Map()
  m.schemaReady = !!schemaReady
  const get = id => { if (!m.has(id)) m.set(id, { receivedItemIds: new Set(), receiptIds: new Set(), depositId: null, billCount: 0 }); return m.get(id) }
  for (const r of receiptItems || []) { const poId = r.po_receipts?.po_id; if (poId) { const e = get(poId); e.receivedItemIds.add(r.po_item_id); if (r.receipt_id) e.receiptIds.add(r.receipt_id) } }
  for (const d of deposits || []) if (d.po_id) get(d.po_id).depositId = d.id
  for (const b of bills || []) if (b.po_id) get(b.po_id).billCount += 1
  return m
}

export const SWAP_MULTI_BILL_TEXT = 'ใบสั่งซื้อนี้มีหลายบิล (รับของหลายครั้ง หรือแยกบิลจ่ายบางส่วน) สลับใบกำกับภาษีจากที่นี่ไม่ได้ — แจ้งผู้ดูแลระบบ'

/** True when the PO's bills are not one single bill: several receipts, or more than one expense row (a split). */
export function poHasMultipleBills(po, index) {
  const e = index && po ? index.get(po.id) : null
  return !!e && ((e.receiptIds?.size || 0) > 1 || (e.billCount || 0) > 1)
}

/** '' or why a PO's edit / cancel is locked by its receipts or its own deposit. */
export function poMoneyLockText(po, index) {
  const e = index && po ? index.get(po.id) : null
  if (!e) return ''
  if (e.receivedItemIds.size > 0) return PO_RECEIPT_LOCKED_TEXT
  if (e.depositId) return PO_HAS_DEPOSIT_TEXT
  return ''
}

export function poLedgerSummary(po, ledger) {
  const receipts = ledger?.receipts || []
  const byItem = new Map()
  for (const r of receipts) for (const it of r.po_receipt_items || []) byItem.set(it.po_item_id, r)
  const legacy = receipts.length === 0 && po.status === 'received'
  const lines = (po.purchase_order_items || []).map(it => {
    const r = byItem.get(it.id)
    return { ...it, received: legacy || !!r, receivedDate: r ? r.received_date : (legacy ? po.received_date || null : null), receiptSeq: r ? r.seq : null }
  })
  let deposit = null
  const d = ledger?.deposit
  if (d?.expenses) {
    const rem = depositRemaining(d.expenses, d.po_deposit_applications || [])
    const gross = round2(Number(d.expenses.amount_no_vat) + Number(d.expenses.vat || 0))
    const remainingGross = round2(rem.net + rem.vat)
    deposit = { id: d.id, no: d.deposit_invoice_no, gross, pct: d.pct_of_po, usedGross: round2(gross - remainingGross), remainingGross, status: d.expenses.status }
  }
  return { lines, receipts, deposit, applications: ledger?.applications || [], bills: ledger?.bills || [], outstandingCount: lines.filter(l => !l.received).length, legacy }
}

export const RECEIVE_NOT_READY_TEXT = 'กำลังโหลดข้อมูลการรับของ… (ถ้าไม่หายไป กรุณาโหลดหน้าใหม่)'
export const RECEIVE_DISCOUNT_PARTIAL_TEXT = 'ใบสั่งซื้อนี้มีรายการส่วนลด (ยอดติดลบ) รับของบางส่วนต่อไม่ได้ — แจ้งผู้ดูแลระบบ'

/** Which receive flow the ⋯ menu opens: {kind:'new'} (ReceivePoLinesModal), {kind:'old'} (receive_po_with_deposits),
 *  {kind:'disabled', reason}, or null (not receivable). The new flow needs the 2026-10-09 schema (index.schemaReady);
 *  a PO with a discount line (line_total < 0) always uses the old flow (receive_po_lines raises bad_lines for it). */
export function receiveRoute(po, index) {
  if (!po || !['ordered', 'partially_received'].includes(po.status)) return null
  const discount = (po.purchase_order_items || []).some(it => Number(it.line_total) < 0)
  // null = loading or a non-soft query failure: we cannot tell which schema is live, so offer nothing yet
  if (!index) return { kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT }
  // a 'delivery' PO is received lot by lot only (receive_po_lines): the server refuses the old whole-PO receive
  // (po_delivery_needs_receipt) because no po_receipts row would exist to link an invoice to
  if (po.tax_invoice_mode === 'delivery') {
    if (index.schemaReady === false) return { kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT }
    if (discount) return { kind: 'disabled', reason: RECEIVE_DELIVERY_DISCOUNT_TEXT }
    return { kind: 'new' }
  }
  if (index.schemaReady === false) return po.status === 'ordered' ? { kind: 'old' } : { kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT }
  if (po.status === 'ordered') return discount ? { kind: 'old' } : { kind: 'new' }
  if (discount) return { kind: 'disabled', reason: RECEIVE_DISCOUNT_PARTIAL_TEXT }
  return { kind: 'new' }
}

/** May the ⋯ menu offer "create deposit"? Only on the live schema (create_po_deposit exists) and never for a PO with a
 *  discount line (it always uses the old receive, which does not pre-tick the PO's own deposit). */
export function canOfferCreateDeposit(po, index) {
  if (!po || po.status !== 'ordered' || !index || index.schemaReady === false) return false
  return !(po.purchase_order_items || []).some(it => Number(it.line_total) < 0)
}

/** Deposits listed in the receive dialog: open (remaining > 0, VAT split), not tied to another PO (R6), own deposit first. */
export function receiveDialogDeposits(rows, poId, ownId) {
  const list = openDeposits((rows || []).filter(d => depositSelectableForPo(d, poId)))
  return [...list].sort((a, b) => (a.id === ownId ? -1 : b.id === ownId ? 1 : 0))
}

/** Old deposit picker: hide deposits tied to a different PO (server refuses them: deposit_other_po).
 *  po_id NULL (legacy / registered by hand) and po_id === this PO stay selectable. */
export function depositSelectableForPo(deposit, poId) {
  const linked = deposit?.po_id
  return !linked || linked === poId
}

/** True only for Postgres/PostgREST 'undefined column' errors naming `column` (e.g. before a migration adds it). */
export function isMissingColumnError(err, column) {
  const msg = String(err?.message || '')
  if (err?.code === '42703') return true
  return new RegExp(column, 'i').test(msg) && /does not exist|column/i.test(msg)
}

/** True for "table/relation does not exist" errors (Postgres 42P01, PostgREST PGRST205 / schema-cache miss), e.g. before a migration. */
export function isMissingRelationError(err) {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = `${err.message || ''} ${err.details || ''}`
  return /relation .* does not exist/i.test(msg) || /Could not find the table/i.test(msg)
}

/** True when PostgREST cannot find the embedded relationship to `table` (PGRST200), e.g. before the migration creates it. */
export function isMissingEmbedError(err, table) {
  if (!err) return false
  const msg = `${err.message || ''} ${err.details || ''} ${err.hint || ''}`
  return (err.code === 'PGRST200' || /could not find a relationship/i.test(msg)) && msg.includes(table)
}
