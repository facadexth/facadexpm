// Pure helpers for the customer LINE OA connection (Settings card + invite links).
export function buildWebhookUrl(supabaseUrl, key) {
  return `${String(supabaseUrl || '').replace(/\/+$/, '')}/functions/v1/customer-line-webhook?t=${key}`
}

export function buildOaInviteLink(basicId, code) {
  return `https://line.me/R/oaMessage/@${String(basicId || '').replace(/^@/, '')}/?${code}`
}

// create_customer_invite raises these messages; map them to Thai for staff.
export function inviteErrorText(message) {
  const m = String(message || '')
  if (m.includes('site_has_no_client')) return 'ไซท์นี้ยังไม่ได้ผูก client — แก้ไขไซท์แล้วเลือก client ก่อน'
  if (m.includes('not_allowed')) return 'ไม่มีสิทธิ์เชิญลูกค้า'
  if (m.includes('site_not_found')) return 'ไม่พบไซท์นี้'
  return 'สร้างรหัสเชิญไม่สำเร็จ: ' + m
}

// dd/mm/yyyy in Bangkok time (en-GB gives dd/mm/yyyy).
export function formatBkkDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
}
