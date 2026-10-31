// SSR smoke: the series form offers the extruder's ซีรีส์หลัก; the family form edits the thickness list as text.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import { emptyForm, formFromRow, buildPayload } from '../../lib/catalogForm.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { seriesFields, FAMILY_FIELDS, familyThicknessError } = await import('./HierarchyTab.jsx')
const clean = h => h.replace(/<!-- -->/g, '')
const form = (fields, initial, row = null) => clean(renderToString(<CrudForm fields={fields} initial={initial} row={row} onSave={() => {}} onCancel={() => {}} />))

describe('HierarchyTab forms', () => {
  const fams = [{ id: 'f1', name: 'ICONIQ EURO', active: true }, { id: 'f2', name: 'OLD', active: false }]
  it('the series form has a ซีรีส์หลัก select of active families (the current one kept)', () => {
    const fields = seriesFields(fams)
    const h = form(fields, emptyForm(fields))
    expect(h).toContain('ซีรีส์หลัก')
    expect(h).toContain('ไม่มี (เป็นซีรีส์หลักของตัวเอง)')
    expect(h).toContain('ICONIQ EURO')
    expect(h).not.toContain('>OLD<')
    const row = { id: 's', name: 'X', series_family_id: 'f2', is_base: false, active: true }
    expect(form(fields, formFromRow(fields, row), row)).toContain('OLD')
    expect(buildPayload(fields, { ...emptyForm(fields), name: 'X', series_family_id: '' })).toMatchObject({ series_family_id: null })
  })
  it('the family form shows a stored thickness list as text and saves numbers', () => {
    const row = { id: 'f', name: 'STANDARD', thickness_options: [1, 1.2, 1.5, 1.8, 2], active: true }
    expect(form(FAMILY_FIELDS, formFromRow(FAMILY_FIELDS, row), row)).toContain('value="1.0, 1.2, 1.5, 1.8, 2.0"')
    expect(buildPayload(FAMILY_FIELDS, { name: ' STANDARD ', thickness_options: '2, 1.0', active: true })).toEqual({ name: 'STANDARD', thickness_options: [1, 2], active: true })
    expect(buildPayload(FAMILY_FIELDS, { name: 'EURO', thickness_options: '', active: true }).thickness_options).toBeNull()
    expect(familyThicknessError({ thickness_options: '1.2, x' })).toBeTruthy()
    expect(familyThicknessError({ thickness_options: '' })).toBeNull()
  })
})
