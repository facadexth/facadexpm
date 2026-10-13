// Render smoke test (server-side only): the type form's layout_kind select lists the 13 kinds in Thai, and the
// layout_params fieldset shows only the chosen kind's fixed_by_type inputs.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import { typeFields } from './TypesTab.jsx'
import { emptyForm, formFromRow } from '../../lib/catalogForm.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))

const fields = typeFields([])
const render = (initial) => renderToString(<CrudForm fields={fields} initial={initial} onSave={() => {}} onCancel={() => {}} />)

describe('TypesTab form', () => {
  it('a new type: the kind select lists every kind with its Thai label; no params fieldset', () => {
    const html = render(emptyForm(fields))
    expect(html).toContain('แบบชิ้นส่วน')
    for (const label of ['บานเลื่อนสวน 2 บาน', 'บานกระทุ้ง (ชั้น × ช่อง)', 'ประตูบานเปิด/สวิง', 'ผนังกระจกเปลือย']) expect(html).toContain(label)
    expect(html).not.toContain('<fieldset')
  })
  it('an awning type shows its rows / cols (stored values), a swing door its leaves and pivot', () => {
    const awning = render(formFromRow(fields, { name: 'กระทุ้ง', category: 'window', layout_kind: 'awning_grid', layout_params: { rows: 3, cols: 2 } }))
    expect(awning).toContain('<fieldset')
    expect(awning).toContain('จำนวนแถว')
    expect(awning).toContain('จำนวนช่อง')
    expect(awning).toMatch(/value="3"/)
    expect(awning).not.toContain('เปิดออก')   // open is an estimator input, not the type's
    const swing = render(formFromRow(fields, { name: 'สวิง', category: 'door', layout_kind: 'swing_door', layout_params: {} }))
    expect(swing).toContain('จำนวนบาน')
    expect(swing).toContain('เดือยบน/ล่าง')
    expect(swing).not.toContain('ธรณี<')
  })
  it('a kind without fixed inputs (fixed_grid) shows no fieldset', () => {
    expect(render(formFromRow(fields, { name: 'ติดตาย', category: 'window', layout_kind: 'fixed_grid', layout_params: {} }))).not.toContain('<fieldset')
  })
})
