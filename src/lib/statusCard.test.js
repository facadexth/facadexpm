import { describe, it, expect } from 'vitest'
import { statusFlex, ganttSpan, barPercents, noPhotosText } from '../../supabase/functions/_shared/status-card.ts'
import { statusText } from '../../supabase/functions/_shared/customer-line-replies.ts'

function walk(node, fn, path = '') {
  fn(node, path)
  if (Array.isArray(node)) node.forEach((c, i) => walk(c, fn, `${path}[${i}]`))
  else if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => walk(v, fn, `${path}.${k}`))
}

const SIZES = ['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', '3xl', '4xl', '5xl']
const LENGTH = /^(\d+(\.\d+)?(px|%))$/
const KEYS = new Set(['type', 'layout', 'contents', 'text', 'size', 'color', 'weight', 'flex', 'wrap', 'align', 'gravity', 'margin',
  'spacing', 'backgroundColor', 'paddingAll', 'paddingTop', 'paddingBottom', 'paddingStart', 'paddingEnd', 'cornerRadius', 'width',
  'height', 'position', 'offsetStart', 'offsetTop', 'offsetBottom', 'offsetEnd', 'action', 'style', 'header', 'body', 'footer',
  'maxLines', 'borderColor', 'borderWidth', 'url', 'justifyContent', 'alignItems'])
function checkFlex(msg) {
  expect(msg.type).toBe('flex')
  expect(msg.altText.length).toBeLessThanOrEqual(400)
  expect(msg.altText.length).toBeGreaterThan(0)
  expect(msg.contents.type).toBe('carousel')
  expect(msg.contents.contents.length).toBeLessThanOrEqual(10)
  walk(msg.contents, (n) => {
    if (n === undefined) throw new Error('undefined node')
    if (n && typeof n === 'object' && !Array.isArray(n)) {
      if (n.type === 'text') {
        expect(typeof n.text).toBe('string')
        expect(n.text.length).toBeGreaterThan(0)
        expect(n.text).not.toContain('undefined')
        expect(n.text).not.toContain('NaN')
        if (n.size) expect(SIZES).toContain(n.size)
      }
      if (n.type === 'box') {
        expect(n.layout).toBeTruthy()
        expect(Array.isArray(n.contents)).toBe(true)
      }
      if (n.type === 'button') {
        const label = n.action.label
        expect(label.length).toBeLessThanOrEqual(20)
        expect(n.action.text.length).toBeGreaterThan(0)
      }
      if (n.type === 'image') expect(n.url.startsWith('https://')).toBe(true)
      for (const k of ['width', 'height', 'offsetStart', 'offsetTop', 'offsetBottom', 'offsetEnd', 'paddingAll', 'cornerRadius']) {
        if (n[k] === undefined) continue
        if (n.type === 'button' && k === 'height') expect(['sm', 'md']).toContain(n[k])
        else expect(String(n[k]), k).toMatch(LENGTH)
      }
      if (typeof n.type === 'string' && n.type !== 'message') for (const k of Object.keys(n)) expect(KEYS.has(k), `unknown key ${k}`).toBe(true)
      if (n.position !== undefined) expect(['relative', 'absolute']).toContain(n.position)
    }
  })
}

const ph = (name, start_date, end_date, status = 'not_started') => ({ name, start_date, end_date, status })
const site = {
  name: 'SOAP OPERA', status: 'Ongoing', pct: 29, endDate: '2026-11-30', handoverDate: null, warrantyMonths: 12,
  phases: [
    ph('ทำแบบขออนุมัติ', '2026-09-01', '2026-09-30', 'done'),
    ph('ผลิต', '2026-10-01', '2026-10-31', 'in_progress'),
    ph('ติดตั้ง', '2026-11-01', '2026-11-30'),
    ph('ส่งมอบงาน', null, null),
  ],
}
const today = '2026-10-20'
const bubbles = (m) => m.contents.contents
const texts = (node) => { const out = []; walk(node, (n) => { if (n && n.type === 'text') out.push(n.text) }); return out }
const BAR_COLOURS = ['#2F6B3F', '#2B6CB0', '#CFC8BE']
const bars = (node) => { const out = []; walk(node, (n) => { if (n && n.type === 'box' && n.position === 'absolute' && BAR_COLOURS.includes(n.backgroundColor)) out.push(n) }); return out }
const todayLine = (b) => { let hit = null; walk(b, (n) => { if (!hit && n && n.type === 'box' && n.position === 'absolute' && n.backgroundColor === '#B04A38') hit = n }); return hit }
const months = (b) => b.body.contents[0]

describe('ganttSpan / barPercents', () => {
  it('pads to whole months and includes today', () => {
    expect(ganttSpan(site.phases, today)).toMatchObject({ start: '2026-09-01', end: '2026-11-30', days: 91 })
    // today later than every phase end: span stretches to today's month
    expect(ganttSpan([ph('a', '2026-08-10', '2026-08-20')], today)).toMatchObject({ start: '2026-08-01', end: '2026-10-31', days: 92 })
    // no dated phase: today's month only
    expect(ganttSpan([ph('a', null, null)], today)).toMatchObject({ start: '2026-10-01', end: '2026-10-31', days: 31 })
  })
  it('turns dates into offset / width percents', () => {
    const span = ganttSpan(site.phases, today)
    expect(barPercents('2026-09-01', '2026-09-30', span)).toEqual({ offset: 0, width: 33 })
    expect(barPercents('2026-10-01', '2026-10-31', span)).toEqual({ offset: 33, width: 34 })
    expect(barPercents('2026-11-01', '2026-11-30', span)).toEqual({ offset: 67, width: 33 })
    // a one-day phase still shows at least 1%
    expect(barPercents('2026-10-05', '2026-10-05', span).width).toBeGreaterThanOrEqual(1)
  })
})

describe('statusFlex', () => {
  it('is valid Flex with one bubble per ongoing site', () => {
    const m = statusFlex([site, { ...site, name: 'B', status: 'On Hold' }, { ...site, name: 'C', status: 'Completed' }], today, 'แชงค์')
    checkFlex(m)
    expect(bubbles(m).length).toBe(2)
  })
  it('header shows update date, site name and overall %', () => {
    const b = bubbles(statusFlex([site], today, 'แชงค์'))[0]
    expect(b.header.backgroundColor).toBe('#2B6CB0')
    const t = texts(b.header)
    expect(t).toContain('สถานะงาน · อัปเดต 20/10/2569')
    expect(t).toContain('SOAP OPERA')
    expect(t).toContain('29%')
  })
  it('positions bars and colours them by status', () => {
    const b = bubbles(statusFlex([site], today, 'แชงค์'))[0]
    const bs = bars(b)
    expect(bs.map((x) => [x.offsetStart, x.width, x.backgroundColor])).toEqual([
      ['0%', '33%', '#2F6B3F'], ['33%', '34%', '#2B6CB0'], ['67%', '33%', '#CFC8BE'],
    ])
    bs.forEach((x) => expect(x.position).toBe('absolute'))
  })
  it('month labels across the top', () => {
    const b = bubbles(statusFlex([site], today, 'แชงค์'))[0]
    expect(texts(months(b))).toEqual(['ก.ย.', 'ต.ค.', 'พ.ย.'])
  })
  it('red today line at today\'s position', () => {
    const b = bubbles(statusFlex([site], today, 'แชงค์'))[0]
    const line = todayLine(b)
    expect(line.position).toBe('absolute')
    expect(line.backgroundColor).toBe('#B04A38')
    expect(line.offsetStart).toBe('54%')
  })
  it('undated phase shows ยังไม่กำหนดวัน instead of a bar', () => {
    const b = bubbles(statusFlex([site], today, 'แชงค์'))[0]
    expect(texts(b.body)).toContain('ยังไม่กำหนดวัน')
    expect(bars(b).length).toBe(3)
    expect(texts(b.body)).toContain('ส่งมอบงาน')
  })
  it('legend line', () => {
    const b = bubbles(statusFlex([site], today, 'แชงค์'))[0]
    expect(texts(b.body)).toContain('เส้นแดง = วันนี้ · ฟ้า = กำลังทำ · เขียว = เสร็จ')
  })
  it('due date row only when the end date is today or later', () => {
    const due = (s) => texts(bubbles(statusFlex([s], today, 'แชงค์'))[0].body)
    expect(due(site)).toContain('กำหนดส่งมอบ')
    expect(due(site)).toContain('30/11/2569')
    expect(due({ ...site, endDate: today })).toContain('กำหนดส่งมอบ')
    expect(due({ ...site, endDate: '2026-10-19' })).not.toContain('กำหนดส่งมอบ')
    expect(due({ ...site, endDate: null })).not.toContain('กำหนดส่งมอบ')
  })
  it('caps the rows at 12 with +N ขั้นตอน', () => {
    const many = Array.from({ length: 15 }, (_, i) => ph(`ขั้น ${i + 1}`, '2026-10-01', '2026-10-10'))
    const b = bubbles(statusFlex([{ ...site, phases: many }], today, 'แชงค์'))[0]
    expect(bars(b).length).toBe(12)
    expect(texts(b.body)).toContain('+3 ขั้นตอน')
    expect(texts(b.body)).not.toContain('ขั้น 13')
    const twelve = bubbles(statusFlex([{ ...site, phases: many.slice(0, 12) }], today, 'แชงค์'))[0]
    expect(texts(twelve.body).some((t) => t.includes('ขั้นตอน'))).toBe(false)
  })
  it('no phases: still valid, says no plan yet', () => {
    const m = statusFlex([{ ...site, phases: [] }], today, 'แชงค์')
    checkFlex(m)
    expect(todayLine(bubbles(m)[0])).toBe(null)
  })
  it('photo button only when the site has photos', () => {
    const actions = (s) => bubbles(statusFlex([s], today, 'แชงค์'))[0].footer.contents.map((c) => c.action)
    expect(actions({ ...site, hasPhotos: true })).toEqual([
      { type: 'message', label: 'ดูรูปหน้างาน', text: 'รูปหน้างาน' },
      { type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' },
    ])
    expect(actions(site)).toEqual([{ type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' }])
  })
  it('no ongoing site -> plain statusText message', () => {
    expect(statusFlex([], today, 'แชงค์')).toEqual({ type: 'text', text: statusText([], today, 'แชงค์') })
    expect(statusFlex([{ ...site, status: 'Completed' }], today, 'แชงค์')).toEqual({ type: 'text', text: statusText([], today, 'แชงค์') })
  })
  it('altText is statusText cut to 400 UTF-16 units', () => {
    const m = statusFlex([site], today, 'แชงค์')
    expect(m.altText).toBe(statusText([site], today, 'แชงค์'))
    const big = Array.from({ length: 10 }, (_, i) => ({ ...site, name: `ไซต์ ${i} ${'ก'.repeat(80)}` }))
    const m2 = statusFlex(big, today, 'แชงค์')
    expect(m2.altText.length).toBe(400)
    expect(statusText(big, today, 'แชงค์').startsWith(m2.altText)).toBe(true)
  })
  it('10 sites max, long names, many phases: stays under LINE size limits', () => {
    const many = Array.from({ length: 30 }, (_, i) => ph(`ขั้นตอนที่ยาวมาก ${'ข'.repeat(60)} ${i}`, '2025-01-01', '2027-06-30', 'in_progress'))
    const sites = Array.from({ length: 12 }, (_, i) => ({ ...site, name: `ไซต์ ${i} ${'ก'.repeat(200)}`, phases: many, hasPhotos: true }))
    const m = statusFlex(sites, today, 'แชงค์')
    checkFlex(m)
    expect(bubbles(m).length).toBe(10)
    expect(new TextEncoder().encode(JSON.stringify(m.contents)).length).toBeLessThan(50000)
    for (const b of bubbles(m)) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(30000)
    // busy carousel: fewer rows per card, with +N for the rest
    for (const b of bubbles(m)) {
      const n = bars(b).length
      expect(n).toBeGreaterThanOrEqual(3)
      expect(texts(b.body)).toContain(`+${30 - n} ขั้นตอน`)
    }
    // a few sites keep all 12 rows
    const few = statusFlex(sites.slice(0, 3), today, 'แชงค์')
    for (const b of bubbles(few)) expect(bars(b).length).toBe(12)
    // a 30-month span keeps its month labels readable (at most 6)
    expect(texts(months(bubbles(m)[0])).length).toBeLessThanOrEqual(6)
  })
  it('customer-facing only: no money or internal fields leak', () => {
    const s = { ...site, contract_value: 123456, notes: 'ภายใน', worker: 'สมชาย' }
    const json = JSON.stringify(statusFlex([s], today, 'แชงค์'))
    expect(json).not.toContain('123456')
    expect(json).not.toContain('ภายใน')
    expect(json).not.toContain('สมชาย')
  })
  it('noPhotosText', () => {
    expect(noPhotosText().length).toBeGreaterThan(0)
  })
})
