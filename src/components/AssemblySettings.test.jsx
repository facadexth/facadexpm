// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const save = vi.fn(async () => {})
let values = {}
vi.mock('../hooks/useSupabase.js', () => ({
  useAppSetting: (key, fallback) => ({ data: values[key] ?? fallback, refetch: () => {} }),
  saveAppSetting: (...a) => save(...a),
}))
import AssemblySettings from './AssemblySettings.jsx'

const locations = [
  { id: 'f', name: 'โรงงาน (ส่วนกลาง)', role: 'factory', lat: 13, lng: 100 },
  { id: 'o', name: 'Head Office', role: 'office', lat: 13, lng: 100 },
]

beforeEach(() => { cleanup(); save.mockClear(); values = {} })

describe('AssemblySettings', () => {
  it('defaults to ไปไซท์เลย with no location picker', () => {
    render(<AssemblySettings locations={locations} />)
    expect(screen.getByLabelText(/ไปไซท์เลย/).checked).toBe(true)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('choosing รวมพล + a location saves both settings', async () => {
    render(<AssemblySettings locations={locations} />)
    fireEvent.click(screen.getByLabelText(/รวมพลที่บริษัท\/โรงงานก่อน/))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'f' } })
    fireEvent.click(screen.getByRole('button', { name: /บันทึก/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('assembly_mode', 'assembly'))
    expect(save).toHaveBeenCalledWith('assembly_location_id', 'f')
  })

  it('refuses รวมพล without a location', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<AssemblySettings locations={locations} />)
    fireEvent.click(screen.getByLabelText(/รวมพลที่บริษัท\/โรงงานก่อน/))
    fireEvent.click(screen.getByRole('button', { name: /บันทึก/ }))
    expect(alert).toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
