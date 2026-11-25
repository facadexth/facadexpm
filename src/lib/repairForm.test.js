import { describe, it, expect } from 'vitest'
import {
  LOCATIONS, SYMPTOMS, LIMITS, SLOTS,
  validateItem, validateRepairForm, preferredDayBounds, itemsDescription,
} from '../../supabase/functions/_shared/repair-form.ts'

const img = (n = 1) => ({ path: `t1/x/${n}.jpg`, mediaType: 'image', bytes: 1000 })
const vid = (seconds = 10) => ({ path: 't1/x/v.mp4', mediaType: 'video', bytes: 5000, seconds })
const okItem = (over = {}) => ({ location: 'ห้องนอน', symptom: 'รั่วซึม', files: [img()], ...over })
const okForm = (over = {}) => ({
  siteId: 's1', items: [okItem()], preferredDays: [], preferredSlot: null, ...over,
})
const TODAY = '2026-11-25'

describe('constants', () => {
  it('chips are exact', () => {
    expect(LOCATIONS).toEqual(['ห้องนอน', 'ห้องนั่งเล่น', 'ครัว', 'ห้องน้ำ', 'ระเบียง', 'ภายนอก', 'อื่นๆ'])
    expect(SYMPTOMS).toEqual(['รั่วซึม', 'เปิดปิดยาก', 'กระจกร้าว-แตก', 'ซีลยางหลุด', 'มือจับ-กลอนเสีย', 'อื่นๆ'])
  })
  it('limits and slots', () => {
    expect(LIMITS).toEqual({
      maxItems: 20, maxImages: 5, maxVideos: 1, maxVideoSeconds: 30,
      maxBytes: 50 * 1024 * 1024, maxPreferredDays: 3, maxDaysAhead: 60,
    })
    expect(SLOTS).toEqual({ morning: 'เช้า', afternoon: 'บ่าย', all_day: 'ทั้งวัน' })
  })
})

describe('validateItem', () => {
  it('valid item → []', () => {
    expect(validateItem(okItem())).toEqual([])
    expect(validateItem(okItem({ files: [img(1), img(2), img(3), img(4), img(5), vid(30)] }))).toEqual([])
  })
  it('no image', () => {
    expect(validateItem(okItem({ files: [] }))).toEqual(['ต้องมีรูปอย่างน้อย 1 รูป'])
  })
  it('video only still needs an image', () => {
    expect(validateItem(okItem({ files: [vid()] }))).toEqual(['ต้องมีรูปอย่างน้อย 1 รูป'])
  })
  it('6 images', () => {
    expect(validateItem(okItem({ files: [1, 2, 3, 4, 5, 6].map(img) }))).toContain('รูปได้ไม่เกิน 5 รูป')
  })
  it('2 videos', () => {
    expect(validateItem(okItem({ files: [img(), vid(), vid()] }))).toContain('วิดีโอได้ 1 คลิป')
  })
  it('video 31 s', () => {
    expect(validateItem(okItem({ files: [img(), vid(31)] }))).toContain('วิดีโอยาวได้ไม่เกิน 30 วินาที')
  })
  it('file too big', () => {
    const big = { ...img(), bytes: 50 * 1024 * 1024 + 1 }
    expect(validateItem(okItem({ files: [big] }))).toContain('ไฟล์ใหญ่เกิน 50 MB')
    expect(validateItem(okItem({ files: [{ ...img(), bytes: 50 * 1024 * 1024 }] }))).toEqual([])
  })
  it('unknown mediaType is rejected', () => {
    expect(validateItem(okItem({ files: [img(), { path: 't1/x/z', mediaType: 'x', bytes: 10 }] }))).toContain('ไฟล์ชนิดนี้ใช้ไม่ได้')
  })
  it('NaN or negative bytes rejected', () => {
    expect(validateItem(okItem({ files: [{ ...img(), bytes: NaN }] }))).toContain('ไฟล์ใหญ่เกิน 50 MB')
    expect(validateItem(okItem({ files: [{ ...img(), bytes: -1 }] }))).toContain('ไฟล์ใหญ่เกิน 50 MB')
  })
  it('bad location', () => {
    expect(validateItem(okItem({ location: 'หลังคา' }))).toContain('เลือกตำแหน่ง')
  })
  it('bad symptom', () => {
    expect(validateItem(okItem({ symptom: '' }))).toEqual(['เลือกอาการ'])
  })
  it('อื่นๆ symptom needs a note', () => {
    expect(validateItem(okItem({ symptom: 'อื่นๆ', note: '  ' }))).toContain('อาการอื่นๆ กรุณาพิมพ์รายละเอียด')
    expect(validateItem(okItem({ symptom: 'อื่นๆ' }))).toContain('อาการอื่นๆ กรุณาพิมพ์รายละเอียด')
    expect(validateItem(okItem({ symptom: 'อื่นๆ', note: 'ประตูบานเลื่อนตก' }))).toEqual([])
  })
  it('อื่นๆ location needs no room', () => {
    expect(validateItem(okItem({ location: 'อื่นๆ' }))).toEqual([])
  })
  it('returns all errors together', () => {
    const errs = validateItem({ location: 'x', symptom: 'y', files: [] })
    expect(errs).toEqual(expect.arrayContaining(['เลือกตำแหน่ง', 'เลือกอาการ', 'ต้องมีรูปอย่างน้อย 1 รูป']))
  })
})

describe('validateRepairForm', () => {
  it('valid form, no days and slot null → ok', () => {
    expect(validateRepairForm(okForm(), TODAY)).toEqual([])
  })
  it('valid form with days', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2026-11-26', '2027-01-24'], preferredSlot: 'morning' }), TODAY)).toEqual([])
  })
  it('0 items', () => {
    expect(validateRepairForm(okForm({ items: [] }), TODAY)).toContain('ยังไม่มีรายการ')
  })
  it('21 items', () => {
    const items = Array.from({ length: 21 }, () => okItem())
    expect(validateRepairForm(okForm({ items }), TODAY)).toContain('ได้ไม่เกิน 20 รายการ')
    expect(validateRepairForm(okForm({ items: items.slice(0, 20) }), TODAY)).toEqual([])
  })
  it('today is not allowed', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2026-11-25'], preferredSlot: 'morning' }), TODAY))
      .toContain('เลือกวันตั้งแต่พรุ่งนี้')
  })
  it('61 days ahead', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2027-01-25'], preferredSlot: 'morning' }), TODAY))
      .toContain('เลือกได้ไม่เกิน 60 วัน')
  })
  it('4 days', () => {
    const days = ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']
    expect(validateRepairForm(okForm({ preferredDays: days, preferredSlot: 'all_day' }), TODAY))
      .toContain('เลือกได้ไม่เกิน 3 วัน')
  })
  it('duplicate days', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2026-11-26', '2026-11-26'], preferredSlot: 'afternoon' }), TODAY))
      .toContain('วันซ้ำกัน')
  })
  it('days without slot', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2026-11-26'], preferredSlot: null }), TODAY))
      .toContain('เลือกช่วงเวลา')
  })
  it('slot must be a real key', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2026-11-26'], preferredSlot: 'toString' }), TODAY)).toContain('เลือกช่วงเวลา')
  })
  it('invalid date strings', () => {
    expect(validateRepairForm(okForm({ preferredDays: ['2026-02-30'], preferredSlot: 'morning' }), TODAY))
      .toContain('วันที่ไม่ถูกต้อง')
    expect(validateRepairForm(okForm({ preferredDays: ['26/11/2026'], preferredSlot: 'morning' }), TODAY))
      .toContain('วันที่ไม่ถูกต้อง')
  })
  it('item errors are prefixed with 1-based index', () => {
    const errs = validateRepairForm(okForm({ items: [okItem(), okItem({ files: [] })] }), TODAY)
    expect(errs).toEqual(['รายการ 2: ต้องมีรูปอย่างน้อย 1 รูป'])
  })
})

describe('preferredDayBounds', () => {
  it('crosses year end', () => {
    expect(preferredDayBounds('2026-12-31')).toEqual({ min: '2027-01-01', max: '2027-03-01' })
  })
  it('normal day', () => {
    expect(preferredDayBounds('2026-11-25')).toEqual({ min: '2026-11-26', max: '2027-01-24' })
  })
})

describe('itemsDescription', () => {
  it('two items', () => {
    expect(itemsDescription([
      okItem({ location: 'ห้องนอน', room: 'ห้องนอนใหญ่', symptom: 'รั่วซึม', note: 'น้ำซึมตอนฝนตก' }),
      okItem({ location: 'ครัว', symptom: 'เปิดปิดยาก' }),
    ])).toBe('1. ห้องนอน (ห้องนอนใหญ่) — รั่วซึม: น้ำซึมตอนฝนตก\n2. ครัว — เปิดปิดยาก')
  })
  it('blank room and note are left out', () => {
    expect(itemsDescription([okItem({ room: '  ', note: '' })])).toBe('1. ห้องนอน — รั่วซึม')
  })
})
