// Render smoke test of the item form's add-on list (ช่องแสง): empty state, rows with their Thai labels (incl. the
// วางเสมอ choices), no NaN / undefined, and the legacy box. Server-side render only.
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import ItemAddons from './ItemAddons.jsx'

const main = { widthMm: 1800, heightMm: 1200 }
const top = { mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3 }
const right = { mode: 'attach', kind: 'awning', position: 'right', len_mm: 1200, thick_mm: 500, offset_mm: 0, align: 'end', rows: 2, cols: 1 }
const noop = () => {}
const clean = html => html.replace(/<!-- -->/g, '')

describe('ItemAddons renders', () => {
  it('empty state', () => {
    const html = clean(renderToString(<ItemAddons addons={[]} main={main} onChange={noop} onConvert={noop} />))
    expect(html).toContain('ช่องแสง')
    expect(html).toContain('+ เพิ่มช่องแสง')
    expect(html).toContain('ยังไม่มีช่องแสง')
  })
  it('rows with Thai labels, align labels per side, summary lines, no NaN / undefined', () => {
    const html = clean(renderToString(<ItemAddons addons={[top, right, { ...top, position: 'bottom', len_mm: null }]} main={main} onChange={noop} onConvert={noop} />))
    for (const t of ['ช่องแสง 1', 'ช่องแสง 2', 'ช่องแสง 3', 'โหมด', 'ร่วมวงกบ', 'แยกวงกบ', 'ชนิด', 'ติดตาย', 'กระทุ้ง', 'ตำแหน่ง', 'ยาวตามขอบ (มม.)',
      'สูงของช่องแสง (มม.)', 'กว้างของช่องแสง (มม.)', 'วางเสมอ', 'เสมอซ้าย', 'เสมอขวา', 'เสมอบน', 'เสมอล่าง', 'ชั้น (rows)', 'ช่อง (cols)', 'เสร็จแล้ว ▲', 'ลบ']) {
      expect(html).toContain(t)
    }
    expect(html).toContain('ร่วมวงกบ · ติดตาย · บน · 1800 × 400 มม. · 1 × 3 ช่อง · เสมอซ้าย')
    expect(html).toContain('แยกวงกบ · กระทุ้ง · ขวา · 500 × 1200 มม. · 2 × 1 ช่อง · เสมอล่าง')
    expect(html).toContain('3 ชิ้น (สูงสุด 6)')
    expect(html).toContain('ชนิดกระทุ้งตอนนี้คิดเหมือนติดตาย (ยังไม่มีชิ้นบานกระทุ้ง)')
    expect(html).not.toContain('เยื้อง')
    expect(html).not.toMatch(/NaN|undefined/)
  })
  it('a non-zero offset (converted legacy add-on) shows in the summary', () => {
    const html = clean(renderToString(<ItemAddons addons={[{ ...top, mode: 'attach', offset_mm: 25 }]} main={main} onChange={noop} onConvert={noop} />))
    expect(html).toContain('แยกวงกบ · ติดตาย · บน · 1800 × 400 มม. · 1 × 3 ช่อง · เสมอซ้าย · เยื้อง 25')
  })
  it('a too-long add-on shows the range warning line', () => {
    const html = clean(renderToString(<ItemAddons addons={[{ ...top, len_mm: 2000 }]} main={main} onChange={noop} onConvert={noop} />))
    expect(html).toContain('ช่องแสง 1 ยาวเกินขอบ (1800 มม.)')
  })
  it('six add-ons disable the add button', () => {
    const html = renderToString(<ItemAddons addons={Array(6).fill(top)} main={main} onChange={noop} onConvert={noop} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\+ เพิ่มช่องแสง/)
  })
  it('a legacy item shows the yellow box with the convert button instead of the list', () => {
    const html = clean(renderToString(<ItemAddons legacy addons={[]} main={main} onChange={noop} onConvert={noop} />))
    expect(html).toContain('ชุดต่อเติม')
    expect(html).toContain('แปลงเป็นช่องแสงแบบใหม่')
    expect(html).not.toContain('+ เพิ่มช่องแสง')
  })
  it('loading and load-error states', () => {
    expect(renderToString(<ItemAddons loading addons={[]} main={main} onChange={noop} onConvert={noop} />)).toContain('กำลังโหลดช่องแสง')
    expect(renderToString(<ItemAddons error="x" addons={[]} main={main} onChange={noop} onConvert={noop} />)).toContain('โหลดช่องแสงไม่สำเร็จ')
  })
})
