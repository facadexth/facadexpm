import { describe, it, expect } from 'vitest'
import { mergeSiteLists, repairSiteOptions, repairTicketOnSiteToday } from '../../supabase/functions/_shared/material-sites.ts'

describe('mergeSiteLists', () => {
  it('merges, dedupes by id and sorts by name', () => {
    const out = mergeSiteLists(
      [{ id: 'b', name: 'บ้านบี' }, { id: 'a', name: 'บ้านเอ' }],
      [{ id: 'a', name: 'บ้านเอ' }, { id: 'c', name: 'บ้านซี' }],
    )
    const sorted = ['บ้านเอ', 'บ้านบี', 'บ้านซี'].sort((x, y) => x.localeCompare(y, 'th'))
    expect(out.map(s => s.name)).toEqual(sorted)
    expect(out).toHaveLength(3)
  })
  it('handles null / empty inputs', () => {
    expect(mergeSiteLists(null, undefined)).toEqual([])
    expect(mergeSiteLists([{ id: 'x', name: 'X' }], [])).toEqual([{ id: 'x', name: 'X' }])
    expect(mergeSiteLists(null, [{ id: 'y', name: 'Y' }])).toEqual([{ id: 'y', name: 'Y' }])
  })
  it('keeps one entry when a site has several tickets', () => {
    expect(mergeSiteLists([], [{ id: 'a', name: 'A' }, { id: 'a', name: 'A' }])).toHaveLength(1)
  })
})

describe('repairSiteOptions', () => {
  it('reads the joined site, object or array shape, skips missing', () => {
    expect(repairSiteOptions([
      { sites: { id: 'a', name: 'A' } }, { sites: [{ id: 'b', name: 'B' }] }, { sites: null }, {},
    ])).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    expect(repairSiteOptions(null)).toEqual([])
  })
})

describe('repairTicketOnSiteToday (multi-day jobs)', () => {
  const today = '2026-10-20'
  it('scheduled tickets count only on their date', () => {
    expect(repairTicketOnSiteToday({ status: 'scheduled', scheduled_date: '2026-10-20' }, today)).toBe(true)
    expect(repairTicketOnSiteToday({ status: 'scheduled', scheduled_date: '2026-10-19' }, today)).toBe(false)
    expect(repairTicketOnSiteToday({ status: 'scheduled', scheduled_date: '2026-10-21' }, today)).toBe(false)
  })
  it('in-progress tickets count from their date on', () => {
    expect(repairTicketOnSiteToday({ status: 'in_progress', scheduled_date: '2026-10-20' }, today)).toBe(true)
    expect(repairTicketOnSiteToday({ status: 'in_progress', scheduled_date: '2026-10-15' }, today)).toBe(true)
    expect(repairTicketOnSiteToday({ status: 'in_progress', scheduled_date: '2026-10-21' }, today)).toBe(false)
    expect(repairTicketOnSiteToday({ status: 'in_progress', scheduled_date: null }, today)).toBe(false)
  })
  it('other statuses never count', () => {
    for (const status of ['pending_review', 'received', 'done', 'declined']) {
      expect(repairTicketOnSiteToday({ status, scheduled_date: today }, today)).toBe(false)
    }
    expect(repairTicketOnSiteToday(null, today)).toBe(false)
  })
})
