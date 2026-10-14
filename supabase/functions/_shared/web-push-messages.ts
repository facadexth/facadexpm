// _shared/web-push-messages.ts -- what each Web Push notification says and where a tap goes.
// Pure wording, no network: kept apart from the sender so it can be unit-tested.
//
// `tab` is the id of the app page to open when the notification is tapped (see TABS in
// src/App.jsx); `pending` is the key of the bell item it belongs to (src/lib/pendingItems.js),
// so the page opens filtered to the rows that notification counted. Notifications carry no
// tag, so two requests arriving close together show as two notifications instead of the
// second replacing the first.

export type PushPayload = { title: string; body: string; tab: string; pending?: string }

const clip = (s: string, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

export function leaveRequestPush(workerName: string, leaveLabel: string, shiftLabel: string, dateLabel: string): PushPayload {
  return { title: '🏖️ คำขอลาใหม่', body: `${workerName} ขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel}`, tab: 'hr', pending: 'leave_pending' }
}

export function materialRequestPush(workerName: string, siteName: string): PushPayload {
  return { title: '📦 คำขอเบิกของใหม่', body: `${workerName} ขอเบิกที่ไซต์ ${siteName}`, tab: 'purchase_orders', pending: 'po_draft' }
}

// A short snippet only: the text shows on a lock screen.
export function issueReportPush(workerName: string, message: string): PushPayload {
  return { title: '🚧 แจ้งปัญหาหน้างาน', body: `${workerName}: ${clip(message, 80)}`, tab: 'sites', pending: 'issues_open' }
}

export function workerOffboardedPush(workerName: string): PushPayload {
  return { title: '⚠️ ช่างพ้นสภาพ ยังอยู่ในกลุ่ม LINE', body: `${clip(workerName, 60)} พ้นสภาพแล้ว กรุณาลบออกจากกลุ่ม LINE`, tab: 'communication_center', pending: 'offboarded_in_group' }
}

export function testPush(): PushPayload {
  return { title: '✅ ทดสอบแจ้งเตือน', body: 'แจ้งเตือนบนเครื่องนี้ใช้งานได้ปกติ', tab: 'settings' }
}

export function quotationExpiryPush(quotationNumber: string, validUntil: string, daysLeft: number): PushPayload {
  const when = daysLeft > 0 ? `อีก ${daysLeft} วัน` : daysLeft === 0 ? 'วันนี้' : 'เลยกำหนดแล้ว'
  return { title: '⏳ ใบเสนอราคาใกล้หมดวันยืนราคา', body: `${quotationNumber} ยืนราคาถึง ${validUntil} (${when})`, tab: 'quotations', pending: 'quotations_followup' }
}
