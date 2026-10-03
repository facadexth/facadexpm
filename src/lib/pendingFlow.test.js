import { describe, it, expect } from 'vitest'
import { isMenuButtonText, MENU_BUTTON_PHRASES, pendingWaitMinutes } from '../../supabase/functions/_shared/pending-flow.ts'

const sched = ['งานวันนี้', 'งานวันพรุ่งนี้', 'งานอาทิตย์นี้', 'งานอาทิตย์หน้า']

describe('isMenuButtonText', () => {
  it('recognises every Rich Menu button text exactly', () => {
    for (const p of ['เช็คอิน/เช็คเอาท์', 'ตารางงาน', 'งานเสร็จ', 'แจ้งปัญหา', 'ขอเบิกของ', 'ขอลา']) {
      expect(isMenuButtonText(p, sched)).toBe(true)
    }
  })
  it('recognises the schedule chips, including a renamed one', () => {
    expect(isMenuButtonText('งานวันพรุ่งนี้', sched)).toBe(true)
    expect(isMenuButtonText('วันนี้ไปไหน', ['วันนี้ไปไหน'])).toBe(true)
  })
  it('ignores spaces around the text', () => {
    expect(isMenuButtonText('  ขอลา \n', sched)).toBe(true)
  })
  it('does NOT treat a real report that merely contains a menu word as a menu tap', () => {
    expect(isMenuButtonText('ท่อรั่วที่ชั้น 2 ต้องเบิกปูนเพิ่ม', sched)).toBe(false)
    expect(isMenuButtonText('มีปัญหาเรื่องกระจกแตก', sched)).toBe(false)
    expect(isMenuButtonText('ขอลาไม่ได้ เพราะงานด่วน', sched)).toBe(false)
    expect(isMenuButtonText('เช็คอินแล้วแต่ลิงก์ไม่ขึ้น', sched)).toBe(false)
  })
  it('is false for empty or missing text', () => {
    expect(isMenuButtonText('', sched)).toBe(false)
    expect(isMenuButtonText(null, sched)).toBe(false)
    expect(isMenuButtonText(undefined)).toBe(false)
  })
  it('lists no duplicates', () => {
    expect(new Set(MENU_BUTTON_PHRASES).size).toBe(MENU_BUTTON_PHRASES.length)
  })
})

describe('pendingWaitMinutes', () => {
  it('is short for a free-text problem report', () => {
    expect(pendingWaitMinutes('issue_report')).toBe(10)
  })
  it('keeps the longer window for the photo steps', () => {
    for (const a of ['job_done', 'job_done_pick', 'site_photo']) expect(pendingWaitMinutes(a)).toBe(30)
  })
})
