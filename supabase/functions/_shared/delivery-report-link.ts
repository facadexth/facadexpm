// Pure rules for remote signing of a delivery report (รายงานส่งงาน, DR).
// Used by sign-link (Deno) and unit-tested from src/lib (vitest).

export type DeliveryReportLinkRow = { status?: string | null } | null | undefined

// What the sign page may do with this report.
//   'missing'  -> no report row (sign-link answers document_not_found)
//   'replaced' -> report was replaced by a newer one or voided: refuse
//   'ok'       -> show it / let the customer sign
export function linkState(report: DeliveryReportLinkRow): 'missing' | 'replaced' | 'ok' {
  if (!report) return 'missing'
  if (report.status === 'replaced' || report.status === 'void') return 'replaced'
  return 'ok'
}

// Only a draft or issued report may become signed (the DB trigger enforces the same).
export function canMarkSigned(report: DeliveryReportLinkRow): boolean {
  return !!report && (report.status === 'draft' || report.status === 'issued')
}
