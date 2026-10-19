import { describe, it, expect } from 'vitest'
import { todaysSites, shiftLabel, pickSiteForNow, sitesNeedingLinks, multiSiteReplyText } from '../../supabase/functions/_shared/todays-sites.ts'

const AVAIN = { site_id: 's-avain', site_name: 'The nest - AVAIN บางนา กม.5', shift: 'morning', type: 'site' }
const BIG = { site_id: 's-big', site_name: 'บ้านคุณบิ๊ก', shift: 'evening', type: 'factory' }

describe('todaysSites', () => {
  it('ชัย: morning AVAIN + evening บ้านคุณบิ๊ก gives two sites, morning first', () => {
    // evening row first, as an unordered query could return it
    const sites = todaysSites([BIG, AVAIN], [])
    expect(sites).toEqual([
      { siteId: 's-avain', siteName: 'The nest - AVAIN บางนา กม.5', shifts: ['morning'], nextAction: 'check_in' },
      { siteId: 's-big', siteName: 'บ้านคุณบิ๊ก', shifts: ['evening'], nextAction: 'check_in' },
    ])
  })

  it('same site morning + evening is ONE site with both shifts', () => {
    const sites = todaysSites([{ ...AVAIN, shift: 'evening' }, AVAIN], [])
    expect(sites).toHaveLength(1)
    expect(sites[0].shifts).toEqual(['morning', 'evening'])
    expect(shiftLabel(sites[0].shifts)).toBe('ทั้งวัน')
  })

  it('checked in but not out gives check_out for that site only', () => {
    const sites = todaysSites([AVAIN, BIG], [{ site_id: 's-avain', checkin_at: '2026-10-19T01:00:00Z', checkout_at: null }])
    expect(sites.map((s) => s.nextAction)).toEqual(['check_out', 'check_in'])
  })

  it('all done', () => {
    const sites = todaysSites([AVAIN, BIG], [
      { site_id: 's-avain', checkin_at: 'a', checkout_at: 'b' },
      { site_id: 's-big', checkin_at: 'c', checkout_at: 'd' },
    ])
    expect(sites.every((s) => s.nextAction === 'done')).toBe(true)
    expect(sitesNeedingLinks(sites, 'auto')).toEqual([])
  })

  it('single site', () => {
    const sites = todaysSites([AVAIN], [])
    expect(sites).toHaveLength(1)
    expect(pickSiteForNow(sites, 15)).toBe(sites[0])
  })

  it('no sites, and rows without site_id are ignored', () => {
    expect(todaysSites([], [])).toEqual([])
    expect(todaysSites([{ site_id: null, site_name: null, shift: 'morning' }], [])).toEqual([])
    expect(pickSiteForNow([], 9)).toBeNull()
  })

  it('same earliest shift sorts by name', () => {
    const sites = todaysSites([{ site_id: 'b', site_name: 'ข', shift: 'morning' }, { site_id: 'a', site_name: 'ก', shift: 'morning' }], [])
    expect(sites.map((s) => s.siteId)).toEqual(['a', 'b'])
  })
})

describe('shiftLabel', () => {
  it('labels', () => {
    expect(shiftLabel(['morning'])).toBe('เช้า')
    expect(shiftLabel(['evening'])).toBe('บ่าย')
    expect(shiftLabel(['morning', 'evening'])).toBe('ทั้งวัน')
    expect(shiftLabel([])).toBe('ทั้งวัน')
  })
})

describe('pickSiteForNow', () => {
  const sites = todaysSites([AVAIN, BIG], [])
  it('before 12:00 the morning site, from 12:00 the evening site', () => {
    expect(pickSiteForNow(sites, 6).siteId).toBe('s-avain')
    expect(pickSiteForNow(sites, 11).siteId).toBe('s-avain')
    expect(pickSiteForNow(sites, 12).siteId).toBe('s-big')
    expect(pickSiteForNow(sites, 20).siteId).toBe('s-big')
  })
  it('falls back to the first site when no site has the wanted shift', () => {
    const morningOnly = todaysSites([AVAIN], [])
    expect(pickSiteForNow(morningOnly, 18).siteId).toBe('s-avain')
  })
})

describe('sitesNeedingLinks', () => {
  const sites = todaysSites([AVAIN, BIG], [{ site_id: 's-avain', checkin_at: 'a', checkout_at: null }])
  it('auto gives every site that is not done', () => {
    expect(sitesNeedingLinks(sites, 'auto').map((s) => s.siteId)).toEqual(['s-avain', 's-big'])
  })
  it('typed commands filter by action', () => {
    expect(sitesNeedingLinks(sites, 'check_in').map((s) => s.siteId)).toEqual(['s-big'])
    expect(sitesNeedingLinks(sites, 'check_out').map((s) => s.siteId)).toEqual(['s-avain'])
  })
  it('a disabled action is dropped', () => {
    expect(sitesNeedingLinks(sites, 'auto', { check_in: true, check_out: false }).map((s) => s.siteId)).toEqual(['s-big'])
  })
})

describe('multiSiteReplyText', () => {
  it('ชัย, morning site done, evening site to check in', () => {
    const sites = todaysSites([AVAIN, BIG], [{ site_id: 's-avain', checkin_at: 'a', checkout_at: 'b' }])
    expect(multiSiteReplyText(sites, { 's-big': 'https://changpm.app/f/t2' })).toBe([
      '📍 วันนี้คุณมี 2 ไซท์ — กดลิงก์ของไซท์ที่คุณอยู่ตอนนี้',
      '',
      '✅ เช้า · The nest - AVAIN บางนา กม.5 — ครบแล้ว',
      '🌇 บ่าย · บ้านคุณบิ๊ก → เช็คอิน',
      'https://changpm.app/f/t2',
    ].join('\n'))
  })
  it('both to check in, full-day site uses 📍, unlinked pending site left out', () => {
    const sites = todaysSites([AVAIN, BIG, { site_id: 's-c', site_name: 'Zeta', shift: null }], [{ site_id: 's-big', checkin_at: 'a', checkout_at: null }])
    const text = multiSiteReplyText(sites, { 's-avain': 'L1', 's-c': 'L3' })
    expect(text).toBe([
      '📍 วันนี้คุณมี 3 ไซท์ — กดลิงก์ของไซท์ที่คุณอยู่ตอนนี้',
      '',
      '🌅 เช้า · The nest - AVAIN บางนา กม.5 → เช็คอิน',
      'L1',
      '📍 ทั้งวัน · Zeta → เช็คอิน',
      'L3',
    ].join('\n'))
  })
})
