// _shared/quotation-expiry.ts -- when a sent quotation gets the "price validity ends soon"
// notice, and what it says. Pure (no network) so it can be unit-tested.
//
// A quotation is noticed once its valid_until is 7 days away or closer, while it is still
// 'sent' and not on hold. The notice is sent once per valid_until value: snoozing moves the
// date, so a fresh notice goes out at the new 7-days-before point.

export const EXPIRY_NOTICE_DAYS = 7

export type ExpiringQuotation = {
  id: string
  quotation_number: string
  status: string
  on_hold: boolean
  valid_until: string | null
  expiry_notified_for: string | null
  created_by: string | null
}

const DAY_MS = 86400000
export function daysUntil(todayISO: string, dateISO: string): number {
  return Math.round((new Date(`${dateISO}T00:00:00Z`).getTime() - new Date(`${todayISO}T00:00:00Z`).getTime()) / DAY_MS)
}

export function isExpiryNoticeDue(q: ExpiringQuotation, todayISO: string): boolean {
  if (q.status !== 'sent' || q.on_hold || !q.valid_until) return false
  if (q.expiry_notified_for === q.valid_until) return false
  return daysUntil(todayISO, q.valid_until) <= EXPIRY_NOTICE_DAYS
}

export function formatExpiryMessage(q: Pick<ExpiringQuotation, 'quotation_number' | 'valid_until'>, todayISO: string): string {
  const left = daysUntil(todayISO, q.valid_until as string)
  const when = left > 0 ? `อีก ${left} วัน` : left === 0 ? 'วันนี้' : 'เลยกำหนดแล้ว'
  return `⏳ ใบเสนอราคา ${q.quotation_number} ยืนราคาถึง ${q.valid_until} (${when})\nเลื่อนอีก 7 วันได้ที่เมนู ⋮ ของใบนั้น ถ้าไม่ตอบรับก่อนครบกำหนด ระบบจะพักใบไว้ให้`
}
