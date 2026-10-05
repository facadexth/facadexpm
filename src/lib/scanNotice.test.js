import { describe, it, expect } from 'vitest'
import { scanErrorNotice, SCAN_REMINDER } from './scanNotice.js'

describe('scanErrorNotice', () => {
  it('tells the user to type the lines themselves for every known code', () => {
    for (const code of ['quota_exhausted', 'ai_unavailable', 'unreadable', 'too_long']) {
      expect(scanErrorNotice(code).text).toMatch(/กรอก/)
    }
  })
  it('points a quota-exhausted tenant at the package settings', () => {
    expect(scanErrorNotice('quota_exhausted').text).toMatch(/ตั้งค่า/)
  })
  it('suggests retaking the photo when the document is unreadable', () => {
    expect(scanErrorNotice('unreadable').text).toMatch(/ถ่ายใหม่/)
  })
  it('falls back to the server message for an unknown or missing code', () => {
    expect(scanErrorNotice(null, 'Error: boom').text).toBe('Error: boom')
    expect(scanErrorNotice('something_new', 'custom').text).toBe('custom')
  })
  it('has a generic fallback when there is no message either', () => {
    expect(scanErrorNotice(undefined).text).toMatch(/กรอก/)
  })
  it('exposes the reminder shown after a scan', () => {
    expect(SCAN_REMINDER).toBe('ตรวจรายการทุกครั้งก่อนบันทึก')
  })
})
