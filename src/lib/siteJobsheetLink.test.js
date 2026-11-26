import { describe, it, expect } from 'vitest'
import { installSitesToday, jobSheetLines, jobSheetRunText } from '../../supabase/functions/_shared/site-jobsheet-link.ts'
import { runAtSite } from '../../supabase/functions/_shared/site-jobsheet.ts'

const FAIL = 'เปิดไม่ได้ตอนนี้ ลองใหม่'
const row = (over = {}) => ({ site_id: 's1', type: 'site', repair_ticket_id: null, sites: { name: 'AVAIN' }, ...over })

describe('installSitesToday', () => {
  it('one entry per install site, morning + evening de-duplicated', () => {
    expect(installSitesToday([row(), row()])).toEqual([{ siteId: 's1', siteName: 'AVAIN' }])
  })
  it('skips repair assignments and non-site types', () => {
    expect(installSitesToday([row({ repair_ticket_id: 'r1' }), row({ site_id: 's2', type: 'leave' })])).toEqual([])
  })
  it('skips rows without a site', () => {
    expect(installSitesToday([row({ site_id: null })])).toEqual([])
  })
  it('accepts the join as a one-element array, keeps first-seen order', () => {
    const out = installSitesToday([
      row({ site_id: 's2', sites: [{ name: 'บ้านคุณบิ๊ก' }] }),
      row(),
    ])
    expect(out).toEqual([{ siteId: 's2', siteName: 'บ้านคุณบิ๊ก' }, { siteId: 's1', siteName: 'AVAIN' }])
  })
  it('missing join -> fallback name', () => {
    expect(installSitesToday([row({ sites: null })])).toEqual([{ siteId: 's1', siteName: 'ไซต์' }])
  })
})

describe('jobSheetLines', () => {
  it('no rows -> no lines', () => {
    expect(jobSheetLines([])).toEqual([])
  })
  it('link with the run, after a blank line', () => {
    expect(jobSheetLines([{ siteName: 'AVAIN', runText: 'วันที่ 2/5', url: 'https://changpm.app/j/abc' }]))
      .toEqual(['', '📋 ใบงานวันนี้ AVAIN (วันที่ 2/5): https://changpm.app/j/abc'])
  })
  it('unknown run -> no bracket', () => {
    expect(jobSheetLines([{ siteName: 'AVAIN', runText: null, url: 'https://changpm.app/j/abc' }]))
      .toEqual(['', '📋 ใบงานวันนี้ AVAIN: https://changpm.app/j/abc'])
  })
  it('failed token -> visible retry text', () => {
    expect(jobSheetLines([{ siteName: 'AVAIN', runText: 'วันที่ 1/1', url: null }]))
      .toEqual(['', `📋 ใบงานวันนี้ AVAIN (วันที่ 1/1): ${FAIL}`])
  })
})

describe('jobSheetRunText', () => {
  it('null run -> null', () => {
    expect(jobSheetRunText(null)).toBe(null)
  })
  it('x/y', () => {
    expect(jobSheetRunText({ index: 3, total: 5, from: '2026-11-24', to: '2026-11-28' })).toBe('วันที่ 3/5')
  })
})

describe('runAtSite (shared with the job-sheet loader)', () => {
  const a = (date, site_id = 's1') => ({ date, site_id })
  it('Mon-Fri at one site, today Wed -> 3/5', () => {
    const rows = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'].map((d) => a(d))
    expect(runAtSite(rows, 's1', '2026-11-25')).toMatchObject({ index: 3, total: 5 })
  })
  it('a day at another site breaks the run', () => {
    const rows = [a('2026-11-23'), a('2026-11-24', 's2'), a('2026-11-25'), a('2026-11-26')]
    expect(runAtSite(rows, 's1', '2026-11-25')).toMatchObject({ index: 1, total: 2 })
  })
  it('half a day elsewhere today does not break today', () => {
    const rows = [a('2026-11-24'), a('2026-11-25'), a('2026-11-25', 's2')]
    expect(runAtSite(rows, 's1', '2026-11-25')).toMatchObject({ index: 2, total: 2 })
  })
  it('not booked here today -> null', () => {
    expect(runAtSite([a('2026-11-24')], 's1', '2026-11-25')).toBe(null)
  })
})
