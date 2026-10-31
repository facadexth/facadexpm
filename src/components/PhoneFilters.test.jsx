// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PhoneFilters from './PhoneFilters.jsx'
import * as phone from '../hooks/useIsPhone.js'

afterEach(cleanup)
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate')))
})

describe('PhoneFilters', () => {
  it('desktop: children only, no wrapper element', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<PhoneFilters count={2}><select id="s" /><input id="q" /></PhoneFilters>)
    expect([...container.childNodes].map(n => n.tagName)).toEqual(['SELECT', 'INPUT'])
  })

  it('phone: button with count, chips with remove, sheet opens with the children, clear and close', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const onRemove = vi.fn(), onClear = vi.fn()
    render(<PhoneFilters count={2} summary={[{ label: 'ต.ค. 69', onRemove }, { label: 'ไซท์: A' }]} onClear={onClear}><select id="s" /></PhoneFilters>)
    expect(screen.getByText('2')).toBeTruthy()
    expect(document.getElementById('s')).toBeNull()               // controls live only in the sheet
    fireEvent.click(screen.getByLabelText('เอา ต.ค. 69 ออก'))
    expect(onRemove).toHaveBeenCalled()
    expect(screen.getByText('ไซท์: A').querySelector('button')).toBeNull()   // chip without onRemove has no ✕
    fireEvent.click(screen.getByRole('button', { name: /ตัวกรอง/ }))
    expect(document.getElementById('s')).toBeTruthy()
    fireEvent.click(screen.getByText('ล้างทั้งหมด'))
    expect(onClear).toHaveBeenCalled()
    fireEvent.click(screen.getByText('ปิด'))
    expect(document.getElementById('s')).toBeNull()
  })

  it('phone: no count → no badge; back button closes the sheet', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    render(<PhoneFilters><select id="s" /></PhoneFilters>)
    expect(document.querySelector('.phone-badge')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /ตัวกรอง/ }))
    expect(document.getElementById('s')).toBeTruthy()
    fireEvent(window, new PopStateEvent('popstate'))
    expect(document.getElementById('s')).toBeNull()
  })
})
