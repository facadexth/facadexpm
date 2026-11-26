import { describe, it, expect } from 'vitest'
import { companyInitial } from './companyInitial.js'

describe('companyInitial', () => {
  const cases = [
    ['บริษัท เฟซาด เอ็กซ์ จำกัด', 'ฟ'],
    ['บจก. สร้างดี คอนสตรัคชั่น', 'ส'],
    ['หจก.ช่างดี', 'ช่'],
    ['ห้างหุ้นส่วนจำกัด  ทองไทย', 'ท'],
    ['บมจ. ที่ดีที่สุด', 'ที่'],
    ['ไทยอลูมิเนียม', 'ท'],
    ['FacadeX Co.', 'F'],
    ['บริษัท', 'บ'],
    ['', ''],
    [null, ''],
  ]
  for (const [name, want] of cases) {
    it(`${JSON.stringify(name)} -> ${JSON.stringify(want)}`, () => {
      expect(companyInitial(name)).toBe(want)
    })
  }

  it('the result is one grapheme and never starts with a combining mark', () => {
    for (const [name] of cases) {
      const r = companyInitial(name)
      if (!r) continue
      expect(/^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(r)).toBe(false)
      expect([...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(r)].length).toBe(1)
    }
  })

  it('fallback without Intl.Segmenter keeps the consonant with its marks', () => {
    const Seg = Intl.Segmenter
    try {
      Intl.Segmenter = undefined
      expect(companyInitial('บมจ. ที่ดี')).toBe('ที่')
      expect(companyInitial('บริษัท เฟซาด')).toBe('ฟ')
    } finally {
      Intl.Segmenter = Seg
    }
  })
})
