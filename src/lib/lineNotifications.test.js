import { describe, it, expect } from 'vitest'
import {
  isQuotationFollowupDue, isChequeReminderDue, isSiteInvoiceDueThisMonth,
  formatDailyAssignmentsPushMessage, formatQuotationFollowupMessage,
  formatChequeReminderMessage, formatInvoiceDueMessage,
} from './lineNotifications.js'

describe('isQuotationFollowupDue', () => {
  it('is due when sent_at + follow_up_after_days has passed and no follow-up sent yet', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-09-08')).toBe(true)
  })

  it('is not due yet the day before the threshold', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-09-07')).toBe(false)
  })

  it('is not due once already sent, even if the date condition still holds', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: '2026-09-08T00:00:00Z' }
    expect(isQuotationFollowupDue(qt, '2026-09-10')).toBe(false)
  })

  it('is not due when the quotation was never given a follow-up window (skipped at send time)', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: null, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-12-01')).toBe(false)
  })

  it('is not due once the quotation has moved past "sent" (accepted/rejected/expired)', () => {
    const qt = { status: 'accepted', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-09-08')).toBe(false)
  })
})

describe('isChequeReminderDue', () => {
  it('is due when check_date is within the threshold and not yet cleared', () => {
    const cheque = { check_date: '2026-09-10', status: 'issued' }
    expect(isChequeReminderDue(cheque, 3, '2026-09-08')).toBe(true)
  })

  it('is not due when check_date is further out than the threshold', () => {
    const cheque = { check_date: '2026-09-20', status: 'issued' }
    expect(isChequeReminderDue(cheque, 3, '2026-09-08')).toBe(false)
  })

  it('is not due once the cheque has already cleared', () => {
    const cheque = { check_date: '2026-09-10', status: 'cashed' }
    expect(isChequeReminderDue(cheque, 3, '2026-09-08')).toBe(false)
  })
})

describe('isSiteInvoiceDueThisMonth', () => {
  it('is due for an ongoing, not-fully-billed site with no invoice issued this month', () => {
    const site = { status: 'Ongoing', billing_pct: 60, last_invoice_date: '2026-08-15' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(true)
  })

  it('is not due if an invoice was already issued this month', () => {
    const site = { status: 'Ongoing', billing_pct: 60, last_invoice_date: '2026-09-05' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(false)
  })

  it('is not due once the site is fully billed', () => {
    const site = { status: 'Ongoing', billing_pct: 100, last_invoice_date: '2026-08-15' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(false)
  })

  it('is not due for a non-Ongoing site', () => {
    const site = { status: 'Completed', billing_pct: 60, last_invoice_date: '2026-08-15' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(false)
  })
})

describe('message formatters', () => {
  it('formats one combined daily-assignments push covering every site, not one per worker', () => {
    const msg = formatDailyAssignmentsPushMessage('2026-09-28', [
      { siteName: 'SOAP OPERA', siteNumber: 'FX-2026-001', morning: ['ลิด', 'ซัง'], evening: [] },
      { siteName: 'บ้านคุณนัตตี้', siteNumber: '', morning: [], evening: ['กร'] },
    ])
    expect(msg).toContain('SOAP OPERA')
    expect(msg).toContain('FX-2026-001')
    expect(msg).toContain('ลิด, ซัง')
    expect(msg).toContain('บ้านคุณนัตตี้')
    expect(msg).toContain('กร')
    // one message, not fanned out per worker
    expect(msg.split('🏗️').length - 1).toBe(2)
  })

  it('omits an empty morning/evening line rather than showing "— ว่าง —" in the push', () => {
    const msg = formatDailyAssignmentsPushMessage('2026-09-28', [
      { siteName: 'SOAP OPERA', siteNumber: '', morning: ['ลิด'], evening: [] },
    ])
    expect(msg).toContain('🌅 เช้า: ลิด')
    expect(msg).not.toContain('🌆 บ่าย')
  })

  it('formats a quotation follow-up reminder with the quotation number and days elapsed', () => {
    const msg = formatQuotationFollowupMessage({ quotation_number: 'QT2609-017', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7 })
    expect(msg).toContain('QT2609-017')
    expect(msg).toContain('7')
  })

  it('formats a cheque reminder with the cheque number and check date', () => {
    const msg = formatChequeReminderMessage({ cheque_no: '00579873', check_date: '2026-09-10', bank: 'กสิกรไทย' })
    expect(msg).toContain('00579873')
    expect(msg).toContain('2026-09-10')
  })

  it('formats an invoice-due reminder with the site name and billing %', () => {
    const msg = formatInvoiceDueMessage({ name: 'SOAP OPERA', site_number: 'FX-2026-138', billing_pct: 60 })
    expect(msg).toContain('SOAP OPERA')
    expect(msg).toContain('60')
  })
})
