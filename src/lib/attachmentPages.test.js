import { describe, it, expect } from 'vitest'
import { planAttachmentPages, hardwareSchedule, colourLegend, itemSpecRows, sanitizeSvg, itemViews } from './attachmentPages.js'

const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: 'i' + i, opening_no: 'W' + (i + 1), preview_svg_out: '<svg id="o' + i + '"></svg>', preview_svg_in: '<svg id="n' + i + '"></svg>', ...extra,
}))

describe('planAttachmentPages', () => {
  it('splits 10 items into 4,4,2 plus hardware and colours', () => {
    const r = planAttachmentPages({ items: mk(10), options: { view: 'both' }, firstPageNo: 3, totalQuotationPages: 2, hardwareRowCount: 4 })
    const kinds = r.pages.map(p => p.kind)
    expect(kinds).toEqual(['items', 'items', 'items', 'hardware'])
    expect(r.pages.filter(p => p.kind === 'items').map(p => p.items.length)).toEqual([4, 4, 2])
    expect(r.pages[0].items[0].id).toBe('i0')
  })
  it('colour legend shares the schedule page when rows <= 10', () => {
    const r = planAttachmentPages({ items: mk(1), options: {}, totalQuotationPages: 2, hardwareRowCount: 10 })
    expect(r.pages.map(p => p.kind)).toEqual(['items', 'hardware'])
    expect(r.pages[1].withColours).toBe(true)
  })
  it('colour legend gets own page when rows > 10', () => {
    const r = planAttachmentPages({ items: mk(1), options: {}, totalQuotationPages: 2, hardwareRowCount: 11 })
    expect(r.pages.map(p => p.kind)).toEqual(['items', 'hardware', 'colours'])
    expect(r.pages[1].withColours).toBe(false)
  })
  it('no hardware rows: only a colours page after items', () => {
    const r = planAttachmentPages({ items: mk(1), options: {}, totalQuotationPages: 1, hardwareRowCount: 0 })
    expect(r.pages.map(p => p.kind)).toEqual(['items', 'colours'])
  })
  it('continues page numbers from the quotation', () => {
    const r = planAttachmentPages({ items: mk(5), options: {}, totalQuotationPages: 2, hardwareRowCount: 3 })
    expect(r.pages.map(p => p.pageNo)).toEqual([3, 4, 5])
    expect(r.totalPages).toBe(5)
  })
  it('empty items gives no pages', () => {
    const r = planAttachmentPages({ items: [], options: {}, totalQuotationPages: 2, hardwareRowCount: 0 })
    expect(r.pages).toEqual([])
    expect(r.totalPages).toBe(2)
  })
  it('view out gives one view per frame; both gives two', () => {
    const it0 = mk(1)[0]
    expect(itemViews(it0, 'out').map(v => v.side)).toEqual(['out'])
    expect(itemViews(it0, 'in').map(v => v.side)).toEqual(['in'])
    expect(itemViews(it0, 'both').map(v => v.side)).toEqual(['out', 'in'])
    const r = planAttachmentPages({ items: [it0], options: { view: 'out' }, totalQuotationPages: 1 })
    expect(r.pages[0].items[0].views.length).toBe(1)
  })
  it('flags noPreview when no usable view', () => {
    const items = [{ id: 'a' }, { id: 'b', preview_svg_in: '<svg/>' }]
    const r = planAttachmentPages({ items, options: { view: 'out' }, totalQuotationPages: 1 })
    expect(r.pages[0].items[0].noPreview).toBe(true)
    expect(r.pages[0].items[1].noPreview).toBe(true)
    const r2 = planAttachmentPages({ items, options: { view: 'both' }, totalQuotationPages: 1 })
    expect(r2.pages[0].items[1].noPreview).toBe(false)
  })
})

describe('hardwareSchedule', () => {
  const setsById = { s1: { id: 's1', name: 'ชุด A', provider_id: 'p1' }, s2: { id: 's2', name: 'ชุด B', provider_id: 'p2' }, s3: { id: 's3', name: 'ไม่ใช้', provider_id: 'p1' } }
  const partsBySet = {
    s1: [{ part_id: 'a', quantity: 2, part: { id: 'a', name: 'ล้อ', unit: 'ชุด', image_path: 'x/a.png' } }],
    s2: [{ part_id: 'b', quantity: 1, part: { id: 'b', name: 'บานพับ', unit: 'คู่' } }],
  }
  const providersById = { p1: { name: 'ยี่ห้อ A' }, p2: { name: 'ยี่ห้อ B' } }
  it('lists only used sets in first-use order with item numbers', () => {
    const items = [{ opening_no: 'D1', hardware_set_id: 's2' }, { opening_no: 'W1', hardware_set_id: 's1' }, { opening_no: 'D2', hardware_set_id: 's2' }, { opening_no: 'F1', no_hardware_set: true }]
    const r = hardwareSchedule({ items, setsById, partsBySet, providersById })
    expect(r.sets.map(s => s.setId)).toEqual(['s2', 's1'])
    expect(r.sets[0].itemNos).toEqual(['D1', 'D2'])
    expect(r.sets[0].brand).toBe('ยี่ห้อ B')
    expect(r.sets[1].parts[0]).toEqual({ partId: 'a', name: 'ล้อ', quantity: 2, unit: 'ชุด', imagePath: 'x/a.png' })
    expect(r.needsApprovalNote).toBe(true)
    expect(r.needsApprovalNote && r.approvalNote).toBe('ยี่ห้ออื่นที่เทียบเท่าต้องได้รับการอนุมัติ')
  })
  it('no sets used gives empty and no note', () => {
    const r = hardwareSchedule({ items: [{ opening_no: 'F1' }], setsById, partsBySet, providersById })
    expect(r.sets).toEqual([])
    expect(r.needsApprovalNote).toBe(false)
  })
})

describe('colourLegend', () => {
  it('merges items with the same finish', () => {
    const ctx = { finishesById: { f1: { name: 'ขาว', color_hex: '#fff' }, f2: { name: 'ดำ' } } }
    const items = [{ opening_no: 'W1', alu_finish_id: 'f1' }, { opening_no: 'W2', alu_finish_id: 'f2' }, { opening_no: 'W3', alu_finish_id: 'f1' }, { opening_no: 'X' }]
    const r = colourLegend(items, ctx)
    expect(r).toEqual([
      { finishId: 'f1', name: 'ขาว', hex: '#fff', itemNos: ['W1', 'W3'] },
      { finishId: 'f2', name: 'ดำ', hex: null, itemNos: ['W2'] },
    ])
  })
})

describe('itemSpecRows', () => {
  const ctx = { seriesById: { s: { name: 'ซีรีส์ 40' } }, finishesById: { f: { name: 'ขาว' } }, infillById: { g: { code: 'TP6', name: 'เทมเปอร์ 6 มม.' } }, setsById: { h: { name: 'ชุด A' } } }
  it('builds strings', () => {
    const r = itemSpecRows({ width_m: 1.8, height_m: 1.2, series_id: 's', alu_finish_id: 'f', infill_type_id: 'g', hardware_set_id: 'h', frame_thickness_mm: 1.2, sash_thickness_mm: 1.0 }, ctx)
    expect(r.size).toBe('1800 × 1200 มม.')
    expect(r.aluminium).toEqual({ series: 'ซีรีส์ 40', thickness: '1.2/1 มม.', colour: 'ขาว' })
    expect(r.glass).toEqual({ code: 'TP6', name: 'เทมเปอร์ 6 มม.' })
    expect(r.hardwareSet).toBe('ชุด A')
  })
  it('is null-safe', () => {
    const r = itemSpecRows({}, {})
    expect(r.size).toBe('—')
    expect(r.aluminium.thickness).toBe('—')
    expect(r.glass).toEqual({ code: '', name: '—' })
    expect(r.hardwareSet).toBe('—')
    const r2 = itemSpecRows({ infill_type_id: 'g' }, { infillById: { g: { name: 'กระจกใส' } } })
    expect(r2.glass).toEqual({ code: '', name: 'กระจกใส' })
    expect(itemSpecRows({ sash_thickness_mm: 1.5 }, {}).aluminium.thickness).toBe('1.5 มม.')
  })
})

describe('sanitizeSvg', () => {
  it('strips script, on* attributes, javascript: urls', () => {
    const dirty = '<svg onload="x()"><script>alert(1)</script><a href="javascript:alert(1)" xlink:href=" JavaScript:bad"><rect onclick=\'y()\' width="1"/></a><foreignObject><div>hi</div></foreignObject></svg>'
    const out = sanitizeSvg(dirty)
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/alert\(1\)/)
    expect(out).not.toMatch(/\son\w+\s*=/i)
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/foreignObject/i)
    expect(out).toContain('<rect')
    expect(out).toContain('width="1"')
  })
  it('handles empty and non-svg', () => {
    expect(sanitizeSvg(null)).toBe('')
    expect(sanitizeSvg('hello')).toBe('')
  })
})
