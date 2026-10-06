import { describe, it, expect } from 'vitest'
import { parseDbdText, isValidThaiId13, normalizeDigits } from './dbdCompanyParse.js'

// 0105564000012 / 0105550123451 คำนวณด้วยสูตรเอง (ถูกต้อง); 0105564000013 ผิด check digit
describe('isValidThaiId13', () => {
  it('accepts valid numbers', () => {
    expect(isValidThaiId13('0105564000012')).toBe(true)
    expect(isValidThaiId13('0105550123451')).toBe(true)
  })
  it('rejects bad check digit, wrong length, junk', () => {
    expect(isValidThaiId13('0105564000013')).toBe(false)
    expect(isValidThaiId13('010556400001')).toBe(false)
    expect(isValidThaiId13('')).toBe(false)
    expect(isValidThaiId13(null)).toBe(false)
  })
  it('accepts hyphens, spaces and Thai digits', () => {
    expect(isValidThaiId13('0-1055-64000-01-2')).toBe(true)
    expect(isValidThaiId13('๐๑๐๕๕๖๔๐๐๐๐๑๒')).toBe(true)
  })
})

describe('normalizeDigits', () => {
  it('converts Thai digits', () => expect(normalizeDigits('๑๐๑๑๐')).toBe('10110'))
})

describe('parseDbdText', () => {
  it('label-based sample', () => {
    const r = parseDbdText(`ข้อมูลนิติบุคคล
เลขทะเบียนนิติบุคคล: 0105564000012
ชื่อนิติบุคคล: บริษัท กระจกไทย จำกัด
สถานะ: ยังดำเนินกิจการอยู่
ที่ตั้งสำนักงานแห่งใหญ่: 99/1 หมู่ 2 ตำบลบางพลีใหญ่ อำเภอบางพลี จังหวัดสมุทรปราการ 10540
ทุนจดทะเบียน: 1,000,000 บาท`)
    expect(r.taxId).toBe('0105564000012')
    expect(r.taxIdValid).toBe(true)
    expect(r.name).toBe('บริษัท กระจกไทย จำกัด')
    expect(r.address).toBe('99/1 หมู่ 2 ตำบลบางพลีใหญ่ อำเภอบางพลี จังหวัดสมุทรปราการ 10540')
    expect(r.multiple).toBe(false)
  })

  it('value on the next line, multi-line address stops at next label', () => {
    const r = parseDbdText(`ชื่อนิติบุคคล
บริษัท เอ บี ซี จำกัด (มหาชน)

เลขทะเบียน
0105550123451

ที่ตั้ง
123 ถนนสุขุมวิท
แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110
สถานะ: ยังดำเนินกิจการอยู่`)
    expect(r.name).toBe('บริษัท เอ บี ซี จำกัด (มหาชน)')
    expect(r.taxId).toBe('0105550123451')
    expect(r.address).toBe('123 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110')
  })

  it('Thai digits and hyphenated ID, different order, no name label', () => {
    const r = parseDbdText(`ที่อยู่ : ๕๕ ซอยลาดพร้าว ๑๐ แขวงจอมพล เขตจตุจักร กรุงเทพมหานคร ๑๐๙๐๐
บจก. เอ็กซ์ ดีไซน์ จำกัด
เลขทะเบียนนิติบุคคล ๐-๑๐๕๕-๖๔๐๐๐-๐๑-๒`)
    expect(r.taxId).toBe('0105564000012')
    expect(r.taxIdValid).toBe(true)
    expect(r.name).toBe('บจก. เอ็กซ์ ดีไซน์ จำกัด')
    expect(r.address).toBe('55 ซอยลาดพร้าว 10 แขวงจอมพล เขตจตุจักร กรุงเทพมหานคร 10900')
  })

  it('partnership names', () => {
    expect(parseDbdText('ชื่อนิติบุคคล: ห้างหุ้นส่วนจำกัด สยามอลูมิเนียม').name).toBe('ห้างหุ้นส่วนจำกัด สยามอลูมิเนียม')
    expect(parseDbdText('หจก. สยามกระจก\n').name).toBe('หจก. สยามกระจก')
    expect(parseDbdText('ห้างหุ้นส่วนสามัญ นิติบุคคล สมชาย').name).toBe('ห้างหุ้นส่วนสามัญ นิติบุคคล สมชาย')
  })

  it('trims trailing text after จำกัด on same line', () => {
    expect(parseDbdText('บริษัท โชคดี จำกัด ยังดำเนินกิจการอยู่').name).toBe('บริษัท โชคดี จำกัด')
  })

  it('heuristic address without label', () => {
    const r = parseDbdText(`บริษัท ทดสอบ จำกัด
เลขนิติบุคคล 0105564000013
88 หมู่ 3 ตำบลบางเมือง อำเภอเมืองสมุทรปราการ จังหวัดสมุทรปราการ 10270`)
    expect(r.address).toBe('88 หมู่ 3 ตำบลบางเมือง อำเภอเมืองสมุทรปราการ จังหวัดสมุทรปราการ 10270')
    expect(r.taxId).toBe('0105564000013')
    expect(r.taxIdValid).toBe(false)
  })

  it('missing address returns null, keeps others', () => {
    const r = parseDbdText('ชื่อนิติบุคคล: บริษัท ไม่มีที่อยู่ จำกัด\nเลขทะเบียน: 0105564000012')
    expect(r.address).toBeNull()
    expect(r.name).toBe('บริษัท ไม่มีที่อยู่ จำกัด')
  })

  it('multiple companies returns first with warning', () => {
    const r = parseDbdText(`ผลการค้นหา
1. บริษัท กระจกไทย จำกัด เลขทะเบียน 0105564000012
2. บริษัท กระจกสยาม จำกัด เลขทะเบียน 0105550123451`)
    expect(r.name).toBe('บริษัท กระจกไทย จำกัด')
    expect(r.taxId).toBe('0105564000012')
    expect(r.multiple).toBe(true)
  })

  it('never throws, nulls when nothing found', () => {
    for (const v of [undefined, null, '', '   ', 'hello world', 123, {}]) {
      const r = parseDbdText(v)
      expect(r).toEqual({ name: null, address: null, taxId: null, taxIdValid: null, multiple: false })
    }
  })

  it('does not take a 14-digit run as an ID', () => {
    expect(parseDbdText('เลขทะเบียน 01055640000123').taxId).toBeNull()
  })
})
