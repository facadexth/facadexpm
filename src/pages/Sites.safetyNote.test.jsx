// @vitest-environment jsdom
// Admin site form: sites.safety_note is not in the site list view, so an edit form loads it on its
// own and keeps the field disabled until then (a save before that must never clear the note).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ selects: [], values: { assembly_mode: null, safety_note: 'ระวังกระจก', value: undefined } }))

vi.mock('../lib/supabase.js', async (orig) => {
  const real = await orig()
  const from = () => {
    let col = ''
    const q = {
      select: (c) => { col = c; h.selects.push(c); return q },
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: { [col]: h.values[col] }, error: null }),
    }
    return q
  }
  return { ...real, supabase: { from, functions: { invoke: async () => ({}) } } }
})

import { SiteForm, siteFormToPayload } from './Sites.jsx'
import { DEFAULT_SAFETY_NOTE } from '../../supabase/functions/_shared/site-jobsheet.ts'

afterEach(() => { cleanup(); h.selects = []; h.values.value = undefined; localStorage.clear() })

describe('SiteForm ข้อควรระวังหน้างาน (ไซท์นี้)', () => {
  it('edit: loads the note, then saves the trimmed value; blank saves NULL', async () => {
    const onSave = vi.fn()
    render(<SiteForm initial={{ id: 's1', name: 'ไซท์ A', status: 'Ongoing' }} onSave={onSave} onCancel={() => {}} />)
    const ta = screen.getByLabelText('ข้อควรระวังหน้างาน (ไซท์นี้)')
    await waitFor(() => expect(ta.value).toBe('ระวังกระจก'))
    expect(h.selects).toContain('safety_note')
    expect(ta.disabled).toBe(false)
    expect(ta.getAttribute('placeholder')).toBe(`ว่างไว้ = ใช้ข้อความกลางของบริษัท: ${DEFAULT_SAFETY_NOTE}`)
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.submit(ta.closest('form'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(siteFormToPayload(onSave.mock.calls[0][0]).safety_note).toBeNull()
  })

  it('edit: disabled until loaded; a save before that writes no safety_note at all', () => {
    const onSave = vi.fn()
    render(<SiteForm initial={{ id: 's2', name: 'ไซท์ B', status: 'Ongoing' }} onSave={onSave} onCancel={() => {}} />)
    const ta = screen.getByLabelText('ข้อควรระวังหน้างาน (ไซท์นี้)')
    expect(ta.disabled).toBe(true)
    fireEvent.submit(ta.closest('form'))
    expect('safety_note' in siteFormToPayload(onSave.mock.calls[0][0])).toBe(false)
  })

  it('placeholder shows the company default when one is set', async () => {
    h.values.value = '  ใส่หมวกนิรภัย  '
    render(<SiteForm onSave={() => {}} onCancel={() => {}} />)
    const ta = screen.getByLabelText('ข้อควรระวังหน้างาน (ไซท์นี้)')
    await waitFor(() => expect(ta.getAttribute('placeholder')).toBe('ว่างไว้ = ใช้ข้อความกลางของบริษัท: ใส่หมวกนิรภัย'))
    expect(h.selects).toContain('value')
  })

  it('add: the field is enabled straight away', () => {
    render(<SiteForm onSave={() => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText('ข้อควรระวังหน้างาน (ไซท์นี้)').disabled).toBe(false)
    expect(h.selects).not.toContain('safety_note')
  })
})
