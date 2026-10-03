import { describe, it, expect } from 'vitest'
import { todayMenuOptions } from '../../supabase/functions/_shared/today-menu.ts'

const base = { hasCheckedIn: false, hasCheckedOut: false, hasOpenTasks: true, tomorrowPhrase: 'งานวันพรุ่งนี้' }

describe('todayMenuOptions (the sub-menu under งานวันนี้)', () => {
  it('before check-in: เช็คอิน, งานเสร็จ, แจ้งปัญหา, งานวันพรุ่งนี้', () => {
    expect(todayMenuOptions(base)).toEqual(['เช็คอิน', 'งานเสร็จ', 'แจ้งปัญหา', 'งานวันพรุ่งนี้'])
  })
  it('after check-in it offers เช็คเอาท์ instead of เช็คอิน', () => {
    expect(todayMenuOptions({ ...base, hasCheckedIn: true })).toEqual(['เช็คเอาท์', 'งานเสร็จ', 'แจ้งปัญหา', 'งานวันพรุ่งนี้'])
  })
  it('after check-out it offers neither', () => {
    const o = todayMenuOptions({ ...base, hasCheckedIn: true, hasCheckedOut: true })
    expect(o).not.toContain('เช็คอิน')
    expect(o).not.toContain('เช็คเอาท์')
    expect(o).toEqual(['งานเสร็จ', 'แจ้งปัญหา', 'งานวันพรุ่งนี้'])
  })
  it('hides งานเสร็จ when the worker has no open task', () => {
    expect(todayMenuOptions({ ...base, hasOpenTasks: false })).toEqual(['เช็คอิน', 'แจ้งปัญหา', 'งานวันพรุ่งนี้'])
  })
  it('leaves out tomorrow when that command is disabled', () => {
    expect(todayMenuOptions({ ...base, tomorrowPhrase: null })).toEqual(['เช็คอิน', 'งานเสร็จ', 'แจ้งปัญหา'])
  })
  it('uses the company\'s own phrase for tomorrow if they renamed it', () => {
    expect(todayMenuOptions({ ...base, tomorrowPhrase: 'พรุ่งนี้ไปไหน' }).at(-1)).toBe('พรุ่งนี้ไปไหน')
  })
  it('never offers the old photo chip (photos are filed automatically)', () => {
    for (const hasCheckedIn of [false, true]) {
      expect(todayMenuOptions({ ...base, hasCheckedIn })).not.toContain('รูปภาพหน้างาน')
    }
  })
})
