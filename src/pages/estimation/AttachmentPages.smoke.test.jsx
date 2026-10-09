import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AttachmentPages from './AttachmentPages.jsx'
import { planAttachmentPages, hardwareSchedule, hardwareRowCount } from '../../lib/attachmentPages.js'

const ctx = {
  seriesById: { s: { name: 'ซีรีส์ 40' } },
  finishesById: { f1: { name: 'ขาว', color_hex: '#f6f6f3' }, f2: { name: 'ดำ' } },
  infillById: { g: { code: 'TP6', name: 'เทมเปอร์' } },
  setsById: { h1: { id: 'h1', name: 'ชุดหน้าต่าง', provider_id: 'p' } },
  partsBySet: { h1: [{ part_id: 'a', quantity: 2, part: { id: 'a', name: 'ล้อ', unit: 'ชุด', image_path: 'x.png' } }, { part_id: 'b', quantity: 1, part: { id: 'b', name: 'กุญแจ', unit: 'ตัว' } }] },
  providersById: { p: { name: 'ยี่ห้อ A' } },
}
const items = Array.from({ length: 5 }, (_, i) => ({
  id: 'i' + i, opening_no: 'W' + (i + 1), width_m: 1.2, height_m: 1.5, quantity: 2, series_id: 's', alu_finish_id: i % 2 ? 'f2' : 'f1', infill_type_id: 'g', hardware_set_id: 'h1',
  preview_svg_out: '<svg viewBox="0 0 10 10"><script>x</script><rect width="5" height="5" onclick="y()"/></svg>', preview_svg_in: i === 4 ? null : '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>',
}))

describe('AttachmentPages', () => {
  it('renders 2 item pages + schedule with legend, header on every page', () => {
    const sched = hardwareSchedule({ items, ...ctx })
    const plan = planAttachmentPages({ items, options: { view: 'both' }, totalQuotationPages: 2, hardwareRowCount: hardwareRowCount(sched) })
    expect(plan.pages.map(p => p.kind)).toEqual(['items', 'items', 'hardware'])
    const html = renderToStaticMarkup(
      <AttachmentPages pages={plan.pages} items={items} ctx={ctx} imageUrls={{ 'x.png': 'https://img/x.png' }} totalPages={plan.totalPages}
        renderHeader={({ pageNumber, totalPages }) => <div className="hdr">HDR {pageNumber}/{totalPages}</div>} />
    )
    expect((html.match(/class="hdr"/g) || []).length).toBe(3)
    expect(html).toContain('HDR 3/5')
    expect(html).toContain('หน้า 5/5')
    expect(html).toContain('Colour legend')
    expect(html).toContain('https://img/x.png')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/onclick/i)
    expect(html).not.toMatch(/NaN|undefined/)
  })
  it('shows placeholder when no usable view', () => {
    const plan = planAttachmentPages({ items: [{ id: 'z', opening_no: 'Z1' }], options: {}, totalQuotationPages: 1, hardwareRowCount: 0 })
    const html = renderToStaticMarkup(<AttachmentPages pages={plan.pages} items={[]} ctx={{}} totalPages={plan.totalPages} />)
    expect(html).toContain('ยังไม่มีภาพ')
    expect(html).not.toMatch(/NaN|undefined/)
  })
})
