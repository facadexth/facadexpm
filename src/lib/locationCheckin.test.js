import { describe, it, expect } from 'vitest'
import { pickTimeClockTarget, locationNextAction, locationLinkReplyText, locationTokenPayload, pickCheckinLocationFromRole } from '../../supabase/functions/_shared/location-checkin.ts'

const SITE = { siteId: 's1', siteName: 'บ้านคุณบิ๊ก', shifts: ['morning'], nextAction: 'check_in', atFactory: false }
const OFFICE = { id: 'loc-office', name: 'สำนักงาน FacadeX' }

describe('pickTimeClockTarget', () => {
  it('a site assignment today wins, even when a location is also assigned', () => {
    expect(pickTimeClockTarget([SITE], OFFICE)).toEqual({ kind: 'site' })
  })
  it('no site + assigned location gives the location', () => {
    expect(pickTimeClockTarget([], OFFICE)).toEqual({ kind: 'location', location: OFFICE })
  })
  it('no site + no location gives none (the existing "no work" reply)', () => {
    expect(pickTimeClockTarget([], null)).toEqual({ kind: 'none' })
    expect(pickTimeClockTarget([], undefined)).toEqual({ kind: 'none' })
  })
})

describe('pickCheckinLocationFromRole', () => {
  it('ADMIN with an assigned location gets that location', () => {
    expect(pickCheckinLocationFromRole({ role: 'ADMIN', checkin_locations: OFFICE }, null)).toEqual(OFFICE)
  })
  it('ADMIN/OWNER/PM without an assignment falls back to the office location', () => {
    for (const role of ['ADMIN', 'OWNER', 'PM']) {
      expect(pickCheckinLocationFromRole({ role, checkin_locations: null }, OFFICE)).toEqual(OFFICE)
    }
  })
  it('WORKER role or no user_roles row gets nothing', () => {
    expect(pickCheckinLocationFromRole({ role: 'WORKER', checkin_locations: OFFICE }, OFFICE)).toBeNull()
    expect(pickCheckinLocationFromRole(null, OFFICE)).toBeNull()
  })
})

describe('locationNextAction', () => {
  it('no row today -> check_in; open row -> check_out; closed row -> done', () => {
    expect(locationNextAction(null)).toBe('check_in')
    expect(locationNextAction({ checkin_at: '2026-10-21T01:00:00Z', checkout_at: null })).toBe('check_out')
    expect(locationNextAction({ checkin_at: '2026-10-21T01:00:00Z', checkout_at: '2026-10-21T10:00:00Z' })).toBe('done')
  })
})

describe('locationLinkReplyText', () => {
  it('follows the site link reply style, naming the location', () => {
    expect(locationLinkReplyText('check_in', OFFICE, 'https://x/f/abc')).toBe(
      '📍 กดลิงก์นี้เพื่อเช็คอินที่ สำนักงาน FacadeX ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\nhttps://x/f/abc',
    )
    expect(locationLinkReplyText('check_out', OFFICE, 'https://x/f/abc')).toContain('เช็คเอาท์ที่ สำนักงาน FacadeX')
  })
})

describe('locationTokenPayload', () => {
  it('names the location (not a site) on the token row', () => {
    expect(locationTokenPayload({ tenantId: 't1', workerId: 'w1', actionType: 'check_out', locationId: 'loc-office' }))
      .toEqual({ tenant_id: 't1', worker_id: 'w1', action_type: 'check_out', checkin_location_id: 'loc-office' })
  })
})
