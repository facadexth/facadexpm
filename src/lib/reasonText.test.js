import { describe, it, expect } from 'vitest'
import { reasonText, unresolvedText } from './reasonText.js'

describe('reasonText for the part-model expander issues', () => {
  it('gives Thai text (not the raw code) for every expander reason', () => {
    for (const code of ['no_butt_distance', 'no_butt_target', 'no_profile_family', 'corner_violation', 'no_model']) {
      const t = reasonText(code)
      expect(t).not.toBe(code)
      expect(t).toMatch(/[฀-๿]/)
      expect(unresolvedText({ name: 'x', reason: code, source: 'joint' })).toBe(t)
    }
  })
})

describe('reasonText for the inline add-on (ช่องแสง) reasons', () => {
  it('gives the exact Thai text for the five add-on codes', () => {
    const want = {
      addon_conflict: 'มีชุดต่อเติมแบบเดิมอยู่แล้ว ลบหรือแปลงก่อนจึงใช้ช่องแสงแบบใหม่',
      addon_not_loaded: 'โหลดข้อมูลช่องแสงไม่สำเร็จ ยังไม่ได้คิดราคาช่องแสง',
      addon_needs_layout: 'template นี้ไม่ได้ใช้ part editor จึงใส่ช่องแสงไม่ได้',
      addon_out_of_range: 'ช่องแสงยาวหรือเยื้องเกินขอบบานหลัก',
      addon_piece_too_small: 'ชิ้นส่วนช่องแสงสั้นกว่าระยะหัก',
      addon_deduction_zero: 'ระยะหักของชิ้นช่องแสงยังเป็น 0 ตรวจใน template',
    }
    for (const [code, text] of Object.entries(want)) {
      expect(reasonText(code)).toBe(text)
      expect(unresolvedText({ name: 'ช่องแสง', reason: code, source: 'addon' })).toBe(text)
    }
  })
})
