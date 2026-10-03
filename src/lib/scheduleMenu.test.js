import { describe, it, expect } from 'vitest'
import { timeClockStep, scheduleMenuChips, TIME_CLOCK_PHRASE, SCHEDULE_MENU_PHRASE } from '../../supabase/functions/_shared/schedule-menu.ts'
import { RESERVED_PHRASES, phrasesCollide } from './lineCommandSettings.js'

describe('timeClockStep (one button for check-in and check-out)', () => {
  it('no site today -> no_site, whatever else is true', () => {
    expect(timeClockStep({ hasSite: false, hasCheckedIn: false, hasCheckedOut: false })).toBe('no_site')
    expect(timeClockStep({ hasSite: false, hasCheckedIn: true, hasCheckedOut: true })).toBe('no_site')
  })
  it('not checked in yet -> check_in', () => {
    expect(timeClockStep({ hasSite: true, hasCheckedIn: false, hasCheckedOut: false })).toBe('check_in')
  })
  it('checked in, not out -> check_out', () => {
    expect(timeClockStep({ hasSite: true, hasCheckedIn: true, hasCheckedOut: false })).toBe('check_out')
  })
  it('checked in and out -> done', () => {
    expect(timeClockStep({ hasSite: true, hasCheckedIn: true, hasCheckedOut: true })).toBe('done')
  })
})

describe('scheduleMenuChips', () => {
  const all = [
    { phrase: 'งานวันนี้', enabled: true }, { phrase: 'งานวันพรุ่งนี้', enabled: true },
    { phrase: 'งานอาทิตย์นี้', enabled: true }, { phrase: 'งานอาทิตย์หน้า', enabled: true },
  ]
  it('lists the four views in order', () => {
    expect(scheduleMenuChips(all)).toEqual(['งานวันนี้', 'งานวันพรุ่งนี้', 'งานอาทิตย์นี้', 'งานอาทิตย์หน้า'])
  })
  it('leaves out a view the company turned off', () => {
    const c = all.map((x, i) => (i === 2 ? { ...x, enabled: false } : x))
    expect(scheduleMenuChips(c)).toEqual(['งานวันนี้', 'งานวันพรุ่งนี้', 'งานอาทิตย์หน้า'])
  })
  it('uses a renamed phrase and skips a missing one', () => {
    expect(scheduleMenuChips([{ phrase: 'วันนี้ไปไหน', enabled: true }, { phrase: undefined, enabled: true }])).toEqual(['วันนี้ไปไหน'])
  })
  it('is empty when everything is off', () => {
    expect(scheduleMenuChips(all.map((x) => ({ ...x, enabled: false })))).toEqual([])
  })
})

describe('the new phrases cannot be taken over by a custom command name', () => {
  it('"ตารางงาน" is reserved', () => {
    expect(RESERVED_PHRASES).toContain(SCHEDULE_MENU_PHRASE)
  })
  it('the combined check-in/out phrase collides with a reserved phrase', () => {
    expect(RESERVED_PHRASES.some((r) => phrasesCollide(TIME_CLOCK_PHRASE, r))).toBe(true)
  })
  it('none of the four schedule phrases contains the new menu phrase (they must not collide)', () => {
    for (const p of ['งานวันนี้', 'งานวันพรุ่งนี้', 'งานอาทิตย์นี้', 'งานอาทิตย์หน้า']) {
      expect(phrasesCollide(p, SCHEDULE_MENU_PHRASE)).toBe(false)
    }
  })
})
