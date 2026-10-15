// Render smoke tests for the add-on ("ช่องแสง") UI of the part editor (server-side render only, supabase mocked).
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { buildCatalogIndex } from '../../../lib/aluCatalogPricing.js'
import { startModel } from '../../../lib/partModel.js'
import { newAddon, defaultAddonPieces, setKey } from '../../../lib/addonModel.js'

vi.mock('../../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { default: AddonBox } = await import('./AddonBox.jsx')
const { default: AddonZoom } = await import('./AddonZoom.jsx')
const { default: AddonEffects } = await import('./AddonEffects.jsx')
const { default: PartEditor } = await import('../PartEditor.jsx')

const FAMS = { FT: [58.1, 38.1], FB: [55.6, 35.8], FS: [51.3, 38.1], ST: [25, 25], SB: [25, 25], KS: [25, 25], HS: [25, 25], DV: [40, 20] }
const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'MNG' }],
  types: [{ id: 'slide', name: 'บานเลื่อน' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'slide' }],
  finishes: [],
  profiles: Object.entries(FAMS).map(([f, [w, b]]) => ({ id: 'p' + f, provider_id: 'A', family: f, thickness_mm: 1.5, width_mm: w, butt_distance_mm: b, linear_weight_kg_per_m: 1 })),
  seriesProfiles: Object.keys(FAMS).map(f => ({ series_id: 'sA', profile_id: 'p' + f })),
})
const text = html => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'")
const main = { widthMm: 1800, heightMm: 1200 }
const ao = (o = {}) => ({ ...newAddon({ mode: 'merge', position: 'top', mainWidthMm: 1800, mainHeightMm: 1200 }), ...o })
const buttOf = f => FAMS[f]?.[1] ?? null
const noop = () => {}

describe('AddonBox', () => {
  it('empty state', () => {
    const t = text(renderToString(<AddonBox addons={[]} onChange={noop} main={main} sel={null} onSelect={noop} />))
    expect(t).toContain('ยังไม่มีช่องแสง')
    expect(t).toContain('+ เพิ่มช่องแสง')
  })
  it('one add-on: Thai labels, inputs, no NaN / undefined', () => {
    const html = renderToString(<AddonBox addons={[ao()]} onChange={noop} main={main} sel={null} onSelect={noop} />)
    const t = text(html)
    expect(html).not.toMatch(/NaN|undefined|null/)
    expect(t).toContain('ช่องแสง 1')
    expect(t).toContain('เสร็จแล้ว ▲')
    expect(t).toContain('ดูภาพขยาย / กำหนดชิ้นส่วน')
    expect(t).toContain('ร่วมวงกบ')
    expect(t).toContain('กว้าง (ตามแนวขอบ)')
    expect(html).toContain('value="1800"')
  })
  it('alignment select replaces the offset input', () => {
    const t = text(renderToString(<AddonBox addons={[ao()]} onChange={noop} main={main} sel={null} onSelect={noop} />))
    expect(t).not.toContain('ระยะจากขอบ')
    expect(t).toContain('เสมอซ้าย')
    expect(t).toContain('เสมอขวา')
    const l = text(renderToString(<AddonBox addons={[ao({ position: 'left', len_mm: 1200, align: 'end' })]} onChange={noop} main={main} sel={null} onSelect={noop} />))
    expect(l).toContain('เสมอบน')
    expect(l).toContain('เสมอล่าง')
  })
  it('collapsed: the summary line, no inputs', () => {
    const html = renderToString(<AddonBox addons={[ao({ done: true })]} onChange={noop} main={main} sel={0} onSelect={noop} />)
    const t = text(html)
    expect(t).toContain('ร่วมวงกบ · ติดตาย · บน · 1,800 × 400 มม. · 1 ชั้น × 3 ช่อง')
    expect(t).toContain('แก้')
    expect(t).toContain('กำลังดูภาพขยาย')
    expect(html).not.toContain('type="number"')
  })
  it('an invalid add-on shows the Thai problem', () => {
    const t = text(renderToString(<AddonBox addons={[ao({ len_mm: 0 })]} onChange={noop} main={main} sel={null} onSelect={noop} />))
    expect(t).toContain('ช่องแสงที่ 1 ความยาวต้องมากกว่า 0')
  })
})

describe('AddonZoom', () => {
  const zoom = (props) => renderToString(
    <AddonZoom addon={ao()} ai={0} rows={defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' })} isDefault dirty={false}
      families={Object.keys(FAMS)} canEdit pieceIdx={0} onPick={noop} onEditRow={noop} main={main} buttOf={buttOf} layoutKind="sliding_2" model={startModel('sliding_2')} {...props} />,
  )
  it('header, default chip, table header, unresolved text with null families', () => {
    const html = zoom()
    const t = text(html)
    expect(html).not.toMatch(/NaN|undefined/)
    expect(t).toContain('ภาพขยาย ช่องแสง 1')
    expect(t).toContain('ค่าเริ่มต้น ยังไม่บันทึก')
    expect(t).toContain('ความยาว × ท่อน (มม.)')
    expect(t).toContain('ยังไม่ได้เลือกอลูมิเนียม จึงยังคิดความยาวไม่ได้')
    expect(t).toContain('คิ้วเท')
    expect(html).toContain('data-pc="ao_bead"')
  })
  it('a family gives the length × bars from the lib; side panel fields', () => {
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' }).map(r => ({ ...r, profile_family: 'DV' }))
    const t = text(zoom({ rows, isDefault: false, dirty: true, pieceIdx: 5 }))
    expect(t).toContain('แก้แล้ว')
    expect(t).not.toContain('ค่าเริ่มต้น ยังไม่บันทึก')
    expect(t).toContain('1,800.0 × 1')              // far frame: len 1800 − 0 (default deduction 2 × 0)
    expect(t).toContain('ชิ้นที่เลือก: เฟรมด้านไกลของช่องแสง')
    expect(t).toContain('อ้างอิงขนาดจาก')
    expect(t).toContain('ความยาวตามแนวขอบ ช่องแสง (1,800.0 มม.)')
    expect(t).toContain('จำนวนท่อน (คงที่)')
    expect(t).toContain('หมายเหตุ')
  })
  it('read-only: disabled fields', () => {
    expect(zoom({ canEdit: false })).toMatch(/<select id="aoFam" disabled=""/)
  })
})

describe('AddonEffects', () => {
  it('lists the main-unit overrides and notes', () => {
    const rows = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' }).map(r => (r.piece_key === 'ext' ? { ...r, profile_family: 'FS' } : r))
    const t = text(renderToString(<AddonEffects addons={[ao()]} addonSets={{ [setKey('merge', 'fixed', 'top')]: { rows, dirty: true } }} main={main} buttOf={buttOf} layoutKind="sliding_2" model={startModel('sliding_2')} />))
    expect(t).toContain('ชิ้นหลัก: เฟรมข้าง')
    expect(t).toContain('1,600.0')
    expect(t).toContain('ตบเรียบ (รองคิ้วเท)')
  })
})

describe('PartEditor with add-on props', () => {
  const render = (props) => renderToString(
    <PartEditor model={startModel('sliding_2')} onChange={noop} index={index} canEdit testSeriesId="sA" testThicknessMm={1.5} onTestChange={noop}
      addonSets={{}} onAddonSetsChange={noop} previewAddons={[]} onPreviewAddonsChange={noop} {...props} />,
  )
  it('mounts the box under the size bar', () => {
    const t = text(render())
    expect(t).toContain('ยังไม่มีช่องแสง')
    expect(t.indexOf('ยังไม่มีช่องแสง')).toBeGreaterThan(t.indexOf('สูง (มม.)'))
    expect(t.indexOf('ยังไม่มีช่องแสง')).toBeLessThan(t.indexOf('ซีรีส์ที่ใช้ทดสอบ'))
  })
  it('a preview add-on: drawn in the overview, effects card; selected → zoom card, main faded', () => {
    const html = render({ previewAddons: [ao()], initialAddonSel: 0 })
    const t = text(html)
    expect(html).not.toMatch(/NaN|undefined/)
    expect(html).toContain('data-addon="0"')
    expect(html).toContain('opacity="0.28"')
    expect(t).toContain('ผลต่อชิ้นงาน')
    expect(t).toContain('ภาพขยาย ช่องแสง 1')
    expect(t).toContain('ความยาว × ท่อน (มม.)')
  })
})

describe('fix round 1', () => {
  const zoomWith = (props) => renderToString(
    <AddonZoom addon={ao({ mode: 'attach' })} ai={0} rows={defaultAddonPieces({ mode: 'attach', kind: 'fixed', position: null }).map(r => ({ ...r, profile_family: 'FS', deduction_mm: r.piece_key === 'frame_top' ? 76.2 : r.deduction_mm }))}
      isDefault={false} dirty families={Object.keys(FAMS)} canEdit pieceIdx={0} onPick={noop} onEditRow={noop} main={main} buttOf={buttOf} layoutKind="sliding_2" model={startModel('sliding_2')} {...props} />,
  )
  it('save / load errors are callouts in the box and the zoom card', () => {
    expect(text(renderToString(<AddonBox addons={[]} onChange={noop} main={main} sel={null} onSelect={noop} error="บันทึกชิ้นส่วนช่องแสงไม่สำเร็จ: boom" />))).toContain('บันทึกชิ้นส่วนช่องแสงไม่สำเร็จ: boom')
    const html = zoomWith({ error: 'บันทึกชิ้นส่วนช่องแสงไม่สำเร็จ: boom' })
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('บันทึกชิ้นส่วนช่องแสงไม่สำเร็จ: boom')
  })
  it('รวม (ม.) per row, a sum row, ที่มา of the selected piece', () => {
    const t = text(zoomWith())
    expect(t).toContain('รวม (ม.)')
    expect(t).toContain('1,723.8 × 11.72')                  // length × qty, then its metres
    expect(t).toContain('รวมอลูมิเนียมของช่องแสงนี้5.12')
    expect(t).toContain('ที่มา: กว้าง ช่องแสง 1,800.0 − หัก 76.2 = 1,723.8 มม. × 1 ท่อน = 1.72 ม.')
  })
  it('glass: clickable in the zoom, its own row, a read-only panel', () => {
    const html = zoomWith({ pieceIdx: 'glass' })
    const t = text(html)
    expect(html).toMatch(/<rect class="pc glass sel" data-pc="glass" tabindex="0" role="button"/)
    expect(html).toContain('<tr class="pick sel" data-pc="glass"')
    expect(t).toContain('ชิ้นที่เลือก: กระจก / บาน')
    expect(t).toContain('1 × 3 = 3 ช่อง')
    expect(t).toContain('574.6 × 323.8')
    expect(html).not.toContain('id="aoFam"')
  })
  it('ext: ที่มา shows the old length and the stretch', () => {
    const t = text(renderToString(
      <AddonZoom addon={ao()} ai={0} rows={defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top' })} isDefault dirty={false}
        families={[]} canEdit pieceIdx={0} onPick={noop} onEditRow={noop} main={main} buttOf={buttOf} layoutKind="sliding_2" model={startModel('sliding_2')} />))
    expect(t).toContain('(เดิม 1,200.0 มม. ยืดขึ้น 400.0)')
  })
  it('overview: shared frame around main + merge add-ons and the overall size', () => {
    const html = renderToString(
      <PartEditor model={startModel('sliding_2')} onChange={noop} index={index} canEdit testSeriesId="sA" testThicknessMm={1.5} onTestChange={noop}
        addonSets={{}} onAddonSetsChange={noop} previewAddons={[ao()]} onPreviewAddonsChange={noop} />)
    expect(html).toContain('class="aoenv"')
    expect(text(html)).toContain('ขนาดรวมทั้งชุด (รวมช่องแสง) 1,800 × 1,600 มม. · ช่องหลัก 1,800 × 1,200 มม.')
  })
})
