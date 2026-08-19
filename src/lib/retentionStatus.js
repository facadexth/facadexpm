// ============================================================
// Retention status label + badge class -- shared between the Retention
// summary tab and the Site Overview modal so both agree on what each
// status means and which badge class it maps to.
// ============================================================
export function retentionStatusFor(row) {
  if (row.retention_released) return { label: 'คืนแล้ว', cls: 'badge-paid' }
  if (!row.end_date) return { label: 'รอจบงาน', cls: 'badge-pending' }
  if (!row.due_date) return { label: 'ยังไม่ได้ตั้งระยะเวลา', cls: 'badge-pending' }
  const today = new Date().toISOString().slice(0, 10)
  if (row.due_date < today) return { label: 'เกินกำหนด', cls: 'badge-status-cancelled' }
  const in30 = new Date()
  in30.setDate(in30.getDate() + 30)
  if (row.due_date <= in30.toISOString().slice(0, 10)) return { label: 'ใกล้ครบกำหนด', cls: 'badge-po-ordered' }
  return { label: 'รอครบกำหนด', cls: 'badge-pending' }
}
