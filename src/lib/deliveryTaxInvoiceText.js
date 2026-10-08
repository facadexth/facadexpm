// Thai text for the per-delivery tax invoice codes (migrations 2026-10-09-04 / -05).
// Leaf module: NO imports (supplierTaxInvoice.js and poReceiptErrors.js both spread these maps).

export const PO_MODE_LOCKED_TEXT = 'เปลี่ยนวิธีออกใบกำกับภาษีไม่ได้ — ใบสั่งซื้อนี้รับของหรือผูกใบกำกับแล้ว'
export const RECEIVE_DELIVERY_DISCOUNT_TEXT = 'ใบสั่งซื้อแบบใบกำกับต่อการส่งของมีรายการส่วนลด (ยอดติดลบ) รับของทีละล็อตไม่ได้ — เปลี่ยนเป็นใบกำกับต่อใบสั่งซื้อก่อนรับของ'
export const DELIVERY_NOT_READY_TEXT = 'ใบกำกับต่อการส่งของยังไม่พร้อมใช้งาน'
export const HANDOFF_RECEIPT_NOT_FOUND_TEXT = 'ไม่พบการรับของนี้ในรายการ — เปิดจากหน้าใบกำกับภาษีผู้ขาย (ใบรับของที่รอใบกำกับ) แทน'
export const NO_RECEIPTS_TEXT = 'ยังไม่ได้เลือกการส่งของ (ล็อต) — เลือกอย่างน้อย 1 ล็อต'
export const DELIVERY_PO_IN_PO_INVOICE_TEXT = 'ใบสั่งซื้อนี้ตั้งเป็นใบกำกับต่อการส่งของ จึงผูกทั้งใบไม่ได้ — เอาออก แล้วเลือก "ผูกกับ: การส่งของ"'
export const PO_DELIVERY_DISCOUNT_SAVE_TEXT = 'ใบสั่งซื้อแบบใบกำกับต่อการส่งของที่มีรายการส่วนลด (ยอดติดลบ) จะรับของไม่ได้ — ต้องการบันทึกต่อหรือไม่? (แนะนำเลือก "1 ใบต่อใบสั่งซื้อ")'

const LINKED_ELSEWHERE = 'การรับของนี้ผูกกับใบกำกับอื่นอยู่แล้ว'
const MIXED = 'ใบกำกับหนึ่งใบผูกได้แบบเดียว: ใบสั่งซื้อ หรือ การส่งของ — ไม่ผสมกัน'
const PO_IS_DELIVERY = 'ใบสั่งซื้อนี้ตั้งเป็นใบกำกับต่อการส่งของ — เลือก "ผูกกับ: การส่งของ" แทน'

export const DELIVERY_CHECK_TEXT = {
  receipt_not_found: 'ไม่พบการรับของ',
  receipt_wrong_supplier: 'การรับของเป็นของซัพพลายเออร์อื่น',
  receipt_po_not_delivery: 'ใบสั่งซื้อของการรับของนี้ไม่ได้ตั้งเป็นใบกำกับต่อการส่งของ',
  receipt_linked_elsewhere: LINKED_ELSEWHERE,
  receipt_already_reversed: 'สต็อกของการรับของนี้ถูกกลับรายการโดยใบกำกับอื่นแล้ว',
  receipt_stock_from_invoice: 'ใบสั่งซื้อนี้ตั้งให้สต็อกเข้าจากใบกำกับ (ล็อตนี้ไม่มีสต็อกให้กลับรายการ)',
  receipt_no_stock_movements: 'การรับของนี้ไม่มีรายการเข้าสต็อกให้กลับรายการ — สต็อกจะเพิ่มจากรายการในใบกำกับเท่านั้น',
  receipt_outside_month: 'การรับของอยู่นอกเดือนของใบกำกับ',
  receipt_has_deposit: 'การรับของนี้หักมัดจำ (เทียบด้วยมูลค่าสินค้า ไม่ใช่ยอดบิล)',
  receipt_no_expense: 'การรับของนี้ไม่มีบิล (หักมัดจำครบ) — ไม่มีรายจ่ายให้ประทับเลขที่',
  match_vat_inclusive: 'ยอดตรงเมื่อเทียบแบบรวม VAT (ยอดรวมใบกำกับ กับ มูลค่าที่รับรวม VAT)',
  vat_rate_mismatch: 'VAT ในใบกำกับไม่ตรงกับอัตรา VAT ปกติของยอดก่อน VAT — ตรวจตัวเลขหรืออัตราภาษีอีกครั้ง',
  invoice_mixed_links: MIXED,
  po_is_delivery_mode: PO_IS_DELIVERY,
}

export const DELIVERY_RPC_TEXT = {
  po_mode_locked: PO_MODE_LOCKED_TEXT,
  po_delivery_needs_receipt: 'ใบสั่งซื้อแบบใบกำกับต่อการส่งของ ต้องรับของผ่านเมนู "รับของ" (ทีละล็อต) เท่านั้น',
  receipt_not_eligible: 'การรับของที่เลือกใช้ไม่ได้ (ซัพพลายเออร์อื่น หรือใบสั่งซื้อไม่ได้ตั้งเป็นใบกำกับต่อการส่งของ)',
  receipt_linked_elsewhere: LINKED_ELSEWHERE,
  invoice_mixed_links: MIXED,
  po_is_delivery_mode: PO_IS_DELIVERY,
  no_receipts: NO_RECEIPTS_TEXT,
}
