// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ value: '', saved: [], refetch: null, keys: [] }))

vi.mock('../hooks/useSupabase.js', () => ({
  useAppSetting: (key) => { h.keys.push(key); return { data: h.value, refetch: h.refetch } },
  saveAppSetting: async (...a) => { h.saved.push(a) },
}))

import SiteSafetyDefaultSettings from './SiteSafetyDefaultSettings.jsx'
import { DEFAULT_SAFETY_NOTE } from '../../supabase/functions/_shared/site-jobsheet.ts'

beforeEach(() => { h.saved = []; h.keys = []; h.refetch = vi.fn(); vi.spyOn(window, 'alert').mockImplementation(() => {}) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SiteSafetyDefaultSettings', () => {
  it('shows the built-in default as placeholder and saves the trimmed text under site_safety_note_default', async () => {
    h.value = ''
    render(<SiteSafetyDefaultSettings />)
    expect(h.keys[0]).toBe('site_safety_note_default')
    expect(screen.getByText('ข้อควรระวังหน้างาน (ค่าเริ่มต้น)')).toBeTruthy()
    expect(screen.getByText('ใช้กับทุกไซท์ที่ไม่ได้ตั้งเอง')).toBeTruthy()
    const ta = screen.getByLabelText('ข้อควรระวังหน้างาน (ค่าเริ่มต้น)')
    expect(ta.getAttribute('placeholder')).toBe(DEFAULT_SAFETY_NOTE)
    expect(ta.getAttribute('maxlength')).toBe('500')
    fireEvent.change(ta, { target: { value: '  ใส่หมวก  ' } })
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(h.saved).toEqual([['site_safety_note_default', 'ใส่หมวก']]))
    expect(h.refetch).toHaveBeenCalled()
  })

  it('loads the saved text; clearing it saves an empty string (= built-in default)', async () => {
    h.value = 'ข้อความเดิม'
    render(<SiteSafetyDefaultSettings />)
    const ta = screen.getByLabelText('ข้อควรระวังหน้างาน (ค่าเริ่มต้น)')
    expect(ta.value).toBe('ข้อความเดิม')
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(h.saved).toEqual([['site_safety_note_default', '']]))
  })
})
