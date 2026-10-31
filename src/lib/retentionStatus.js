// ============================================================
// Retention status label + badge class -- shared between the Retention
// summary tab and the Site Overview modal so both agree on what each
// status means and which badge class it maps to.
//
// Since 2026-10-20 the due date (site_retention_summary.due_date) is the
// warranty end: handover_date + warranty_months. The view has no status or
// handover column, so callers merge `status` and `handover_date` from
// `sites` into the row (see useSiteRetentionSummary / useSiteOverview).
// A row without them counts as not handed over.
// ============================================================

const bkkToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** True when the site is Completed and has a handover date (warranty has started). */
export function retentionHandedOver(row) {
  return row?.status === 'Completed' && !!row?.handover_date
}

export function retentionStatusFor(row, today = bkkToday()) {
  if (row.retention_released) return { label: 'คืนแล้ว', cls: 'badge-paid' }
  if (!row.due_date) {
    // Handed over but no due date means warranty_months = 0
    if (retentionHandedOver(row)) return { label: 'ไม่มีระยะประกัน', cls: 'badge-pending' }
    return { label: 'รอจบงาน', cls: 'badge-pending' }
  }
  if (row.due_date < today) return { label: 'เกินกำหนด', cls: 'badge-status-cancelled' }
  if (row.due_date <= addDays(today, 30)) return { label: 'ใกล้ครบกำหนด', cls: 'badge-po-ordered' }
  return { label: 'รอครบกำหนด', cls: 'badge-pending' }
}

/** Text for the "วันครบกำหนด" cell: the formatted due date, else why there is none. */
export function retentionDueText(row, fmtDate) {
  if (row.due_date) return fmtDate(row.due_date)
  return retentionHandedOver(row) ? 'ไม่มีระยะประกัน' : 'รอจบงาน'
}
