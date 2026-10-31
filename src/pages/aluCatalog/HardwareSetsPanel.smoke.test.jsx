// SSR smoke of the hardware set page parts (mockup hwset.html): the set form has no unit, the detail shows the two
// sections, prices with their source, the set total and the series chips; the stock list shows on hand + last price.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import { emptyForm } from '../../lib/catalogForm.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { setFields, SetDetail } = await import('./HardwareSetsPanel.jsx')
const { StockResults } = await import('./StockItemPicker.jsx')
const clean = h => h.replace(/<!-- -->/g, '')
const noop = () => {}

describe('hardware set page', () => {
  it('the set form: name, maker (optional), active; no unit', () => {
    const f = setFields([{ id: 'A', name: 'Alumet', active: true }])
    const h = clean(renderToString(<CrudForm fields={f} initial={emptyForm(f)} onSave={noop} onCancel={noop} />))
    expect(h).toContain('ชื่อชุด')
    expect(h).toContain('ผู้ผลิต (ไม่บังคับ)')
    expect(h).not.toContain('หน่วย')
  })
  it('the detail: two sections, prices with source, total, chips', () => {
    const part = (id, name, unit) => ({ id, code: 'P-' + id, name, unit })
    const lines = {
      hardware: [{ id: 'a', quantity: 4, part: part('9', 'ลูกล้อบานเลื่อน', 'ชิ้น'), price: { net_price: 85, source: 'tax_invoice', doc_no: 'IV-1', date: '2026-10-01' } }],
      consumable: [{ id: 'c', quantity: 2, part: part('30', 'ซิลิโคน 300 มล.', 'หลอด'), price: null }],
    }
    const h = clean(renderToString(
      <SetDetail set={{ id: 'S', code: 'P-0025', name: 'อุปกรณ์หน้าต่างบานเลื่อนสวน', active: true }} lines={lines} total={{ total: 340, missing: 1 }}
        chips={[{ id: 'L', provider: 'Alumet', label: 'ICONIQ EURO บานเลื่อน', type: '' }]} canEdit
        pickerFor={() => null} seriesPicker={null}
        on={{ edit: noop, toggleActive: noop, add: noop, quantity: noop, removeLine: noop, addSeries: noop, removeChip: noop }} />,
    ))
    for (const t of ['1. อุปกรณ์', '2. วัสดุสิ้นเปลือง', '3. ใช้กับซีรีส์', '+ เพิ่มอุปกรณ์', '+ เพิ่มวัสดุสิ้นเปลือง', '+ เพิ่มซีรีส์']) expect(h).toContain(t)
    expect(h).toContain('ราคาชุด = รวมราคาของในชุด 340.00 บาท (ยังไม่มีราคา 1 รายการ)')
    expect(h).toContain('ใบกำกับภาษีซื้อ IV-1 · 2026-10-01')
    expect(h).toContain('ยังไม่มีราคา')
    expect(h).toContain('ICONIQ EURO บานเลื่อน')
    expect(h).not.toMatch(/NaN|undefined/)
  })
  it('stock results: on hand and last purchase price, a pick button', () => {
    const h = clean(renderToString(
      <StockResults matches={[{ id: 'i1', code: 'HW0001', name: 'มือจับกระทุ้ง 019 สีดำ ขวา', base_unit: 'ชิ้น' }]} onHand={{ i1: 10 }}
        prices={[{ id: 'sti:1', inventory_item_id: 'i1', unit_cost: 98, effective_from: '2026-10-01', source: 'tax_invoice', doc_no: 'IV-1' }]} busy={false} onPick={noop} />,
    ))
    expect(h).toContain('มือจับกระทุ้ง 019 สีดำ ขวา')
    expect(h).toContain('คงเหลือ 10 ชิ้น · ซื้อล่าสุด 98')
    expect(h).toContain('เลือก')
  })
})
