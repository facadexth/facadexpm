import { describe, it, expect } from 'vitest'
import { planAttachmentPages, hardwareSchedule, colourLegend, itemSpecRows, safeSvgDataUri, itemViews } from './attachmentPages.js'
import { buildFramePreview, previewSvgString } from './framePreview.js'

const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: 'i' + i, opening_no: 'W' + (i + 1), preview_svg_out: '<svg width="360" height="300" id="o' + i + '"></svg>', preview_svg_in: '<svg width="360" height="300" id="n' + i + '"></svg>', ...extra,
}))

const sched = (...rowsPerSet) => ({
  sets: rowsPerSet.map((n, i) => ({ setId: 's' + i, name: 'S' + i, brand: 'B', parts: Array.from({ length: n }, (_, k) => ({ partId: `p${i}-${k}`, name: 'x', quantity: 1, unit: 'ชิ้น' })), uses: [], itemNos: [] })),
  noSetItemNos: [], needsApprovalNote: true, approvalNote: 'n',
})
const leg = n => Array.from({ length: n }, (_, i) => ({ finishId: 'f' + i, name: 'c' + i, hex: null, itemNos: [] }))
const kindsOf = r => r.pages.map(p => p.kind)

describe('planAttachmentPages', () => {
  it('splits 10 items into 4,4,2 plus hardware', () => {
    const r = planAttachmentPages({ items: mk(10), options: { view: 'both' }, firstPageNo: 3, totalQuotationPages: 2, schedule: sched(4), legend: [] })
    expect(kindsOf(r)).toEqual(['items', 'items', 'items', 'hardware'])
    expect(r.pages.filter(p => p.kind === 'items').map(p => p.items.length)).toEqual([4, 4, 2])
    expect(r.pages[0].items[0].id).toBe('i0')
  })
  it('hardware paging by rows: 5, 14, 15, 30', () => {
    const hw = n => planAttachmentPages({ items: mk(1), totalQuotationPages: 2, schedule: sched(n), legend: [] }).pages.filter(p => p.kind === 'hardware').length
    // weights now honest: header row + intro (2) on page 1 + notes (2) on the last page, so 14 rows no longer fit on one page
    expect([hw(5), hw(14), hw(15), hw(30)]).toEqual([1, 2, 2, 3])
  })
  it('keeps sets whole: 8+8 parts go on two pages', () => {
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(8, 8), legend: [] })
    expect(r.pages.filter(p => p.kind === 'hardware').map(p => p.hardwareSets.length)).toEqual([1, 1])
    const r2 = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(3, 4), legend: [] })
    expect(r2.pages.filter(p => p.kind === 'hardware').map(p => p.hardwareSets.length)).toEqual([2])
  })
  it('legend shares the last hardware page when it fits', () => {
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 2, schedule: sched(3), legend: leg(4) })
    expect(kindsOf(r)).toEqual(['items', 'hardware'])
    expect(r.pages[1].withColours).toBe(true)
    expect(r.pages[1].colours.length).toBe(4)
  })
  it('legend gets its own page (counted in total) when the last hardware page is full', () => {
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 2, schedule: sched(9), legend: leg(4) })
    expect(kindsOf(r)).toEqual(['items', 'hardware', 'colours'])
    expect(r.pages[1].withColours).toBe(false)
    expect(r.pages.map(p => p.pageNo)).toEqual([3, 4, 5])
    expect(r.totalPages).toBe(5)
  })
  it('empty legend: no colours page; no sets: no hardware page; legend only', () => {
    expect(kindsOf(planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(3), legend: [] }))).toEqual(['items', 'hardware'])
    expect(kindsOf(planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: { sets: [] }, legend: leg(2) }))).toEqual(['items', 'colours'])
    expect(kindsOf(planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: { sets: [] }, legend: [] }))).toEqual(['items'])
  })
  it('continues page numbers from the quotation', () => {
    const r = planAttachmentPages({ items: mk(5), totalQuotationPages: 2, schedule: sched(3), legend: [] })
    expect(r.pages.map(p => p.pageNo)).toEqual([3, 4, 5])
    expect(r.totalPages).toBe(5)
  })
  it('empty items gives no pages', () => {
    const r = planAttachmentPages({ items: [], totalQuotationPages: 2, schedule: sched(3), legend: leg(2) })
    expect(r.pages).toEqual([])
    expect(r.totalPages).toBe(2)
  })
  it('view out gives one view per frame; both gives two', () => {
    const it0 = mk(1)[0]
    expect(itemViews(it0, 'out').map(v => v.side)).toEqual(['out'])
    expect(itemViews(it0, 'in').map(v => v.side)).toEqual(['in'])
    expect(itemViews(it0, 'both').map(v => v.side)).toEqual(['out', 'in'])
    const r = planAttachmentPages({ items: [it0], options: { view: 'out' }, totalQuotationPages: 1, schedule: { sets: [] }, legend: [] })
    expect(r.pages[0].items[0].views.length).toBe(1)
  })
  it('flags noPreview when no usable view', () => {
    const items = [{ id: 'a' }, { id: 'b', preview_svg_in: '<svg width="1" height="1"/>' }]
    const r = planAttachmentPages({ items, options: { view: 'out' }, totalQuotationPages: 1 })
    expect(r.pages[0].items[0].noPreview).toBe(true)
    expect(r.pages[0].items[1].noPreview).toBe(true)
    const r2 = planAttachmentPages({ items, options: { view: 'both' }, totalQuotationPages: 1 })
    expect(r2.pages[0].items[1].noPreview).toBe(false)
  })
})

describe('hardware page weights', () => {
  const hwPages = r => r.pages.filter(p => p.kind === 'hardware')
  it('14 single-part sets: headers count, so they need several pages', () => {
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(...Array(14).fill(1)), legend: [] })
    expect(hwPages(r).map(p => p.hardwareSets.length)).toEqual([6, 7, 1])
  })
  it('a set used by 30 items weighs by its use-list text', () => {
    const useText = Array.from({ length: 30 }, (_, i) => `W${i + 1} (2 ชุด)`).join(', ')
    const s1 = sched(2)
    s1.sets[0].useText = useText
    expect(Math.ceil(useText.length / 36)).toBeGreaterThanOrEqual(8)
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: { ...s1, sets: [s1.sets[0], { ...sched(2).sets[0], setId: 'z' }, { ...sched(2).sets[0], setId: 'y' }] }, legend: [] })
    expect(hwPages(r).map(p => p.hardwareSets.length)).toEqual([1, 2])
  })
  it('intro only on the first page; notes only on the last', () => {
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: { ...sched(11), noSetItemNos: ['F1'], unselectedItemNos: ['X1'] }, legend: [] })
    const h = hwPages(r)
    expect(h.length).toBe(2)
    expect(h.map(p => p.schedule.intro)).toEqual([true, false])
    expect(h.map(p => p.schedule.needsApprovalNote)).toEqual([false, true])
    expect(h[1].schedule.noSetItemNos).toEqual(['F1'])
    expect(h[1].schedule.unselectedItemNos).toEqual(['X1'])
  })
  it('notes that do not fit move the last set down or get their own page', () => {
    const two = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(4, 4), legend: [] })
    expect(hwPages(two).map(p => p.hardwareSets.length)).toEqual([2])
    const tight = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(4, 6), legend: [] })
    expect(hwPages(tight).map(p => p.hardwareSets.length)).toEqual([1, 1])
  })
  it('continued chunks repeat the header and drop the use list', () => {
    const r = planAttachmentPages({ items: mk(1), totalQuotationPages: 1, schedule: sched(30), legend: [] })
    const h = hwPages(r)
    expect(h[0].hardwareSets[0].continued).toBe(false)
    expect(h[1].hardwareSets[0].continued).toBe(true)
    expect(h.reduce((n, p) => n + p.hardwareSets[0].parts.length, 0)).toBe(30)
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
    expect(r.sets[0].uses).toEqual([{ no: 'D1', quantity: null, typeName: '' }, { no: 'D2', quantity: null, typeName: '' }])
    expect(r.noSetItemNos).toEqual(['F1'])
    expect(r.unselectedItemNos).toEqual([])
    expect(r.sets[0].useText).toBe('D1, D2')
    expect(r.sets[1].parts[0]).toEqual({ partId: 'a', name: 'ล้อ', quantity: 2, unit: 'ชุด', imagePath: 'x/a.png' })
    expect(r.needsApprovalNote).toBe(true)
    expect(r.needsApprovalNote && r.approvalNote).toBe('ยี่ห้ออื่นที่เทียบเท่าต้องได้รับการอนุมัติ')
  })
  it('separates fixed panels from unselected and dangling sets; nothing vanishes', () => {
    const items = [{ opening_no: 'F1', no_hardware_set: true }, { opening_no: 'U1' }, { opening_no: 'U2', hardware_set_id: 'gone' }, { opening_no: 'W1', hardware_set_id: 's1', quantity: 4 }]
    const r = hardwareSchedule({ items, setsById, partsBySet, providersById })
    expect(r.noSetItemNos).toEqual(['F1'])
    expect(r.unselectedItemNos).toEqual(['U1', 'U2'])
    expect(r.sets[0].useText).toBe('W1 (4 ชุด)')
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
  const ctx = { seriesById: { s: { name: 'ซีรีส์ 40' } }, finishesById: { f: { name: 'ขาว' } }, infillById: { g: { code: 'TP6', name: 'เทมเปอร์ 6 มม.' } }, setsById: { h: { code: 'HW-A', name: 'ชุด A', provider_id: 'p' } }, providersById: { p: { name: 'ก' } }, partsBySet: { h: [{ part: { name: 'ล้อ' }, quantity: 2 }] } }
  it('builds strings', () => {
    const r = itemSpecRows({ width_m: 1.8, height_m: 1.2, series_id: 's', alu_finish_id: 'f', infill_type_id: 'g', hardware_set_id: 'h', frame_thickness_mm: 1.2, sash_thickness_mm: 1.0 }, ctx)
    expect(r.size).toBe('1800 × 1200 มม.')
    expect(r.aluminium).toEqual({ series: 'ซีรีส์ 40', thickness: 'กรอบ 1.2 / บาน 1 มม.', colour: 'ขาว' })
    expect(r.glass).toEqual({ code: 'TP6', name: 'เทมเปอร์ 6 มม.' })
    expect(r.hardwareSet).toBe('HW-A · ชุด A (ยี่ห้อ ก)')
    expect(r.hardwareParts).toBe('ล้อ × 2')
  })
  it('is null-safe', () => {
    const r = itemSpecRows({}, {})
    expect(r.size).toBe('—')
    expect(r.aluminium.thickness).toBe('—')
    expect(r.glass).toEqual({ code: '', name: '—' })
    expect(r.hardwareSet).toBe('—')
    const r2 = itemSpecRows({ infill_type_id: 'g' }, { infillById: { g: { name: 'กระจกใส' } } })
    expect(r2.glass).toEqual({ code: '', name: 'กระจกใส' })
    expect(itemSpecRows({ sash_thickness_mm: 1.5 }, {}).aluminium.thickness).toBe('หนา 1.5 มม.')
    expect(itemSpecRows({ frame_thickness_mm: 1.2, sash_thickness_mm: 1.2 }, {}).aluminium.thickness).toBe('หนา 1.2 มม.')
    expect(r.weight).toBeUndefined()
    expect(itemSpecRows({ weightKg: 18.5, glassAreaSqm: 2.16, extraNote: 'Bracket' }, {})).toMatchObject({ weight: '18.50 กก./ชุด', glassArea: '2.16 ตร.ม./ชุด', extraNote: 'Bracket' })
  })
})

describe('safeSvgDataUri', () => {
  const ok = '<svg width="10" height="10"><rect width="5" height="5"/></svg>'
  it('accepts plain drawings as a data URI', () => {
    const u = safeSvgDataUri(ok)
    expect(u.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(u.split(',')[1])).toBe(ok)
  })
  it('accepts the real preview renderer output', () => {
    const p = buildFramePreview({ template: { grid_row_weights: [1] }, width_m: 1.8, height_m: 1.2, panel_count: 2 })
    const svg = previewSvgString(p, { style: 'double' })
    expect(svg).toContain('<svg')
    expect(safeSvgDataUri(svg)).not.toBeNull()
    expect(safeSvgDataUri(previewSvgString(p, { style: 'solid', finishColor: '#aabbcc' }))).not.toBeNull()
  })
  const bypasses = {
    script: '<svg><script>alert(1)</script></svg>',
    'svg/onload': '<svg/onload=alert(1)>',
    'svg onload': '<svg onload="x()"></svg>',
    'no-space attr': '<svg><rect width="1"onclick="x()"/></svg>',
    'slash-separated': '<svg><image href=x/onerror=alert(1)></svg>',
    image: '<svg><image href="https://evil/x.png"/></svg>',
    'unclosed iframe': '<svg><iframe srcdoc="<script>1</script>"></svg>',
    'nested javascript': '<svg><a href="javajavascript:script:alert(1)"><rect/></a></svg>',
    'js entity': '<svg><a href="java&#x73;cript:alert(1)"><rect/></a></svg>',
    'colon entity': '<svg><a href="javascript&colon;alert(1)"><rect/></a></svg>',
    'tab entity': '<svg><a href="java&Tab;script:1"><rect/></a></svg>',
    style: '<svg><style>@import url(https://evil/x.css)</style></svg>',
    'css url beacon': '<svg><rect style="fill:url(https://evil/x)"/></svg>',
    'external href': '<svg><rect href="//evil/x"/></svg>',
    foreignObject: '<svg><foreignObject><div/></foreignObject></svg>',
    use: '<svg><use href="#a"/></svg>',
    animate: '<svg><animate attributeName="href" values="javascript:1"/></svg>',
    set: '<svg><set attributeName="onmouseover" to="1"/></svg>',
    'data html': '<svg><a href="data:text/html,<b>"/></svg>',
    'not svg': 'hello',
    'html wrapper': '<div><svg/></div>',
    'upper case': '<svg ONLOAD="x()"></svg>',
  }
  for (const [name, bad] of Object.entries(bypasses)) {
    it('rejects ' + name, () => { expect(safeSvgDataUri(bad)).toBeNull() })
  }
  it('handles null', () => { expect(safeSvgDataUri(null)).toBeNull(); expect(safeSvgDataUri('')).toBeNull() })
})
