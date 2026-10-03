// The on/off switches for the LINE messages the system sends on its own
// (Settings -> การแจ้งเตือนทาง LINE). Keys and defaults must match
// supabase/functions/_shared/push-settings.ts -- linePushToggles.test.js checks.
//
// Every message here is a PUSH: it counts against the LINE bot's monthly
// message quota. Replies to something a person typed to the bot do not.

export const LINE_PUSH_TOGGLES = [
  {
    key: 'line_push_invoice_due', defaultOn: true, icon: '🧾',
    label: 'เตือนออกใบแจ้งหนี้ประจำเดือน',
    detail: 'วันที่ 1 ของทุกเดือน ส่งสรุปไซท์ที่ถึงกำหนดออกใบแจ้งหนี้ ถึงเจ้าของ (1 ข้อความต่อเจ้าของ 1 คน)',
  },
  {
    key: 'line_push_quotation_followup', defaultOn: true, icon: '📋',
    label: 'เตือนติดตามใบเสนอราคา',
    detail: 'เมื่อใบเสนอราคาที่ส่งแล้วถึงวันที่ตั้งให้ติดตาม ส่งถึงเจ้าของและผู้สร้างใบ (ใบละครั้งเดียว)',
  },
  {
    key: 'cheque_reminder_line_enabled', defaultOn: false, icon: '🏦', module: 'cheque_tracking',
    label: 'เตือนเช็คใกล้ครบกำหนด',
    detail: 'ทุกวัน ส่งทีละใบถึงเจ้าของและผู้สร้างเช็ค จำนวนวันล่วงหน้าตั้งที่ส่วน "แจ้งเตือนเช็คใกล้ครบกำหนด"',
  },
  {
    key: 'line_push_leave_request_admin', defaultOn: true, icon: '🏖️',
    label: 'แจ้งแอดมินเมื่อมีคำขอลา',
    detail: 'เมื่อพนักงานส่งคำขอลาจาก LINE แจ้งเจ้าของและแอดมินทุกคนที่เชื่อม LINE ไว้',
  },
  {
    key: 'line_push_leave_ack_worker', defaultOn: true, icon: '✅',
    label: 'ยืนยันกลับพนักงานว่าส่งคำขอลาแล้ว',
    detail: 'ส่งหาพนักงานที่ยื่นคำขอลา 1 ข้อความ',
  },
  {
    key: 'line_push_leave_result', defaultOn: true, icon: '📨',
    label: 'แจ้งผลอนุมัติ/ปฏิเสธคำขอลา',
    detail: 'เมื่อแอดมินตัดสินคำขอลา แจ้งพนักงานเจ้าของคำขอ 1 ข้อความต่อการตัดสินใจ',
  },
  {
    key: 'line_push_material_request_admin', defaultOn: true, icon: '📦',
    label: 'แจ้งแอดมินเมื่อมีคำขอเบิกของ',
    detail: 'เมื่อพนักงานขอเบิกของจาก LINE แจ้งเจ้าของและแอดมินทุกคนที่เชื่อม LINE ไว้',
  },
  {
    key: 'line_push_offboarding', defaultOn: true, icon: '⚠️',
    label: 'แจ้งเจ้าของเมื่อพนักงานพ้นสภาพ',
    detail: 'เมื่อเปลี่ยนสถานะพนักงานเป็นพ้นสภาพ เตือนให้ลบออกจากกลุ่มทีมงาน (ไม่เกินวันละครั้งต่อคน)',
  },
]

export function parseToggle(value, defaultOn) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return defaultOn
}
