// Which events also send a free notification to admins' phones/computers (Web Push).
// Settings -> แจ้งเตือนบนเครื่องนี้. Keys and defaults must match
// supabase/functions/_shared/push-settings.ts (linePushToggles.test.js checks).
// Each event can use LINE, the device notification, both or neither: LINE counts against
// the monthly message quota, the device notification is free.
export const WEB_PUSH_TOGGLES = [
  { key: 'web_push_leave_request', defaultOn: true, icon: '🏖️', label: 'คำขอลาใหม่', detail: 'เมื่อพนักงานส่งคำขอลา' },
  { key: 'web_push_material_request', defaultOn: true, icon: '📦', label: 'คำขอเบิกของใหม่', detail: 'เมื่อพนักงานขอเบิกของจาก LINE' },
  { key: 'web_push_issue_report', defaultOn: true, icon: '🚧', label: 'แจ้งปัญหาหน้างาน', detail: 'เมื่อมีคนแจ้งปัญหาจาก LINE (ยังไม่มีการส่งทาง LINE ให้แอดมิน)' },
  { key: 'web_push_quotation_expiry', defaultOn: true, icon: '⏳', label: 'ใบเสนอราคาใกล้หมดวันยืนราคา', detail: 'ก่อนวันยืนราคา 7 วัน' },
]
