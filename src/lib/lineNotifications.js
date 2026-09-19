// ============================================================
// Pure date-math and message-formatting for LINE crew comms + office
// reminders -- no Supabase/React dependency. This is the module Task
// 4's scheduled Edge Functions port their logic from (Deno can't
// import a Vite-bundled file directly) -- keep this file the single
// source of truth for the RULES; Task 4's TS re-expresses the same
// rules, not different ones.
// ============================================================

const DAY_MS = 86400000

function daysBetween(fromISO, toISO) {
  return Math.floor((new Date(toISO) - new Date(fromISO)) / DAY_MS)
}

/** A sent quotation is due a follow-up once `follow_up_after_days` have
 *  elapsed since it was sent -- only once (guarded by follow_up_sent_at),
 *  only if a window was actually set (skipped at send time -> null,
 *  never due), and only while the quotation is still sitting at 'sent'
 *  (moved to accepted/rejected/expired -> no longer relevant). */
export function isQuotationFollowupDue(quotation, todayISO) {
  if (quotation.status !== 'sent') return false
  if (quotation.follow_up_after_days == null) return false
  if (quotation.follow_up_sent_at) return false
  if (!quotation.sent_at) return false
  return daysBetween(quotation.sent_at, todayISO) >= quotation.follow_up_after_days
}

/** A cheque is due a reminder once its check_date is within
 *  `thresholdDays` of today, as long as it hasn't already cleared. */
export function isChequeReminderDue(cheque, thresholdDays, todayISO) {
  if (cheque.status === 'cashed') return false
  return daysBetween(todayISO, cheque.check_date) <= thresholdDays
}

/** An Ongoing, not-fully-billed site is due its next progress invoice
 *  once a full calendar month has passed without a new one -- "due this
 *  month" means no invoice has been issued in the current calendar
 *  month yet, not a fixed day-of-month. */
export function isSiteInvoiceDueThisMonth(site, todayISO) {
  if (site.status !== 'Ongoing') return false
  if ((site.billing_pct ?? 0) >= 100) return false
  if (!site.last_invoice_date) return true
  const today = new Date(todayISO)
  const last = new Date(site.last_invoice_date)
  return !(last.getFullYear() === today.getFullYear() && last.getMonth() === today.getMonth())
}

export function formatAssignmentPushMessage(workerName, assignments) {
  const lines = assignments.map((a) => a.zone ? `• ${a.siteName} (${a.zone})` : `• ${a.siteName}`)
  return `📋 พรุ่งนี้ ${workerName} ทำงานที่:\n${lines.join('\n')}`
}

export function formatQuotationFollowupMessage(quotation) {
  return `📤 ติดตามใบเสนอราคา ${quotation.quotation_number} — ส่งไปแล้ว ${quotation.follow_up_after_days} วัน ยังไม่มีการตอบรับ`
}

export function formatChequeReminderMessage(cheque) {
  return `🏦 เช็ค ${cheque.cheque_no} (${cheque.bank}) ครบกำหนด ${cheque.check_date}`
}

export function formatInvoiceDueMessage(site) {
  return `🧾 ${site.name} (${site.site_number}) เบิกไปแล้ว ${site.billing_pct}% — ถึงกำหนดออกใบแจ้งหนี้งวดถัดไปเดือนนี้`
}
