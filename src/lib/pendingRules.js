// Which individual rows are "waiting for action": the row-level twin of the counts shown on
// the tabs and the bell. A row gets the 🔔 mark exactly when it is one of the rows that
// pending_counts() (migration 2026-10-04-03) counts, so the number on the tab always equals
// the number of marked rows. If a rule changes here, change it in that SQL function too.
//
//   leave request   status = 'pending'
//   purchase order  status = 'draft'
//   problem report  status = 'open'
//   quotation       status 'sent', not on hold, valid_until is today or within the next 7 days (or past)
//   cheque          not cashed, and its date is today or within cheque_reminder_days (past due included)
import { isChequeReminderDue } from './lineNotifications.js'

export const isLeavePending = (request) => request?.status === 'pending'
export const isPoDraft = (po) => po?.status === 'draft'
export const isIssueOpen = (report) => report?.status === 'open'

// A sent quotation whose price validity ends within 7 days (past due included until the
// nightly job puts it on hold). `todayISO` is the Bangkok date, YYYY-MM-DD.
export function isQuotationExpiring(quotation, todayISO) {
  if (quotation?.status !== 'sent' || quotation.on_hold || !quotation.valid_until) return false
  const limit = new Date(`${todayISO}T00:00:00Z`)
  limit.setUTCDate(limit.getUTCDate() + 7)
  return quotation.valid_until <= limit.toISOString().slice(0, 10)
}

// thresholdDays: the company's cheque_reminder_days setting (3 when never set).
export function isChequeAwaitingAction(cheque, thresholdDays, todayISO) {
  if (!cheque?.check_date) return false
  return isChequeReminderDue(cheque, thresholdDays, todayISO)
}

export function parseChequeWindowDays(settingValue, fallback = 3) {
  return /^[0-9]+$/.test(String(settingValue ?? '').trim()) ? Number(String(settingValue).trim()) : fallback
}
