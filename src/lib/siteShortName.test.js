import { describe, it, expect } from 'vitest'
import { siteShortName, autoShortName } from './siteShortName.js'

const seg = new Intl.Segmenter('th', { granularity: 'grapheme' })
const graphemes = s => Array.from(seg.segment(s), x => x.segment)

describe('siteShortName', () => {
  it('uses the hand-set short_name, trimmed', () => {
    expect(siteShortName({ name: 'x', short_name: '  ศูนย์ฯ ' })).toBe('ศูนย์ฯ')
  })
  it('falls back to auto when short_name is empty/whitespace', () => {
    expect(siteShortName({ name: 'คอนโด สุขุมวิท 77', short_name: '   ' })).toBe('คอนโด')
    expect(siteShortName({ name: 'คอนโด สุขุมวิท 77', short_name: null })).toBe('คอนโด')
  })
  it('handles missing site', () => {
    expect(siteShortName({})).toBe('')
    expect(siteShortName(null)).toBe('')
  })
})

describe('autoShortName', () => {
  it('truncates on a grapheme boundary with an ellipsis', () => {
    const r = autoShortName('โครงการศูนย์เวชศาสตร์นิวเคลียร์และศูนย์รังษีรักษา')
    expect(r.startsWith('ศูนย์เวชศาสตร')).toBe(true)
    expect(r.endsWith('…')).toBe(true)
    const body = r.slice(0, -1)
    const g = graphemes(body)
    expect(g.length).toBeLessThanOrEqual(14)
    expect(graphemes(g[g.length - 1])).toEqual([g[g.length - 1]])
    expect(g.join('')).toBe(body)
  })
  it('never splits a base letter from its combining marks at any max', () => {
    const name = 'ศูนย์เวชศาสตร์นิวเคลียร์'
    for (let max = 1; max < 20; max++) {
      const r = autoShortName(name, max)
      const body = r.endsWith('…') ? r.slice(0, -1) : r
      expect(graphemes(body).join('')).toBe(body)
      expect(name.startsWith(body)).toBe(true)
      expect(graphemes(body).length).toBeLessThanOrEqual(max)
    }
  })
  it('strips leading โครงการ / งาน / บริษัท', () => {
    expect(autoShortName('โครงการ อาคารเอ')).toBe('อาคารเอ')
    expect(autoShortName('งาน ตกแต่งร้าน')).toBe('ตกแต่งร้าน')
    expect(autoShortName('บริษัท ซันไรส์')).toBe('ซันไรส์')
  })
  it('strips trailing (…) and จำกัด / (มหาชน)', () => {
    expect(autoShortName('อาคารเอ (เฟส 2)')).toBe('อาคารเอ')
    expect(autoShortName('ซันไรส์ จำกัด')).toBe('ซันไรส์')
    expect(autoShortName('ซันไรส์ จำกัด (มหาชน)')).toBe('ซันไรส์')
  })
  it('keeps the first word when it fits', () => {
    expect(autoShortName('คอนโด สุขุมวิท 77')).toBe('คอนโด')
  })
  it('keeps more words when the first is shorter than 4 graphemes', () => {
    expect(autoShortName('บ้าน คุณสมชาย')).toBe('บ้าน คุณสมชาย')
    expect(autoShortName('บ้าน คุณสมชาย ลาดพร้าว')).toBe('บ้าน คุณสมชาย')
    expect(autoShortName('NCP Tower B')).toBe('NCP Tower B')
  })
  it('keeps ส่วนกลาง and handles empty', () => {
    expect(autoShortName('ส่วนกลาง')).toBe('ส่วนกลาง')
    expect(autoShortName('')).toBe('')
    expect(autoShortName(null)).toBe('')
  })
})
