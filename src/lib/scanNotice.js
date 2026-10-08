// ============================================================
// User-facing text for a PO document scan that could not be read
// automatically. Codes come from the extract-po-document edge function
// (see docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md).
// Every message ends the same way: the user can still type the lines in,
// using the document preview shown above the item list.
// ============================================================

export const SCAN_REMINDER = 'ตรวจรายการทุกครั้งก่อนบันทึก'

// Shown after a successful scan whose line items added up to the printed
// grand total (VAT included) rather than the pre-VAT subtotal.
export const SCAN_VAT_INCLUSIVE_NOTICE = 'ราคาในเอกสารนี้รวม VAT แล้ว — ตั้งใบสั่งซื้อเป็น ราคารวม VAT ให้อัตโนมัติ — ตรวจสอบ'

const NOTICES = {
  quota_exhausted: 'โควต้าสแกนเอกสารเดือนนี้ครบแล้ว กรอกรายการเองจากเอกสารด้านบนได้เลย หรืออัปเกรดแพ็กเกจที่เมนูตั้งค่า',
  ai_unavailable: 'ระบบอ่านเอกสารอัตโนมัติใช้ไม่ได้ในตอนนี้ ลองใหม่ภายหลัง หรือกรอกรายการเองจากเอกสารด้านบน',
  unreadable: 'อ่านเอกสารไม่ออก ลองถ่ายใหม่ให้ชัดขึ้น หรือกรอกรายการเองจากเอกสารด้านบน',
  too_long: 'เอกสารนี้มีรายการเยอะเกินไป ลองสแกนทีละหน้า หรือกรอกรายการเองจากเอกสารด้านบน',
}

export function scanErrorNotice(code, message) {
  if (code && NOTICES[code]) return { text: NOTICES[code] }
  return { text: message || 'อ่านเอกสารไม่สำเร็จ กรอกรายการเองได้' }
}
