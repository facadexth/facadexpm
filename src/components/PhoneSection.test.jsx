// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import PhoneSection from './PhoneSection.jsx'
import * as phone from '../hooks/useIsPhone.js'

afterEach(cleanup)
beforeEach(() => vi.restoreAllMocks())

describe('PhoneSection', () => {
  it('desktop: returns the child itself', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container, getByTestId } = render(<PhoneSection title="ใบเสนอราคา"><div data-testid="c" /></PhoneSection>)
    expect(container.firstChild).toBe(getByTestId('c'))
  })

  it('phone: renders title + summary, closed by default', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container, getByText } = render(<PhoneSection title="มัดจำ" summary="฿5,000"><p>body</p></PhoneSection>)
    expect(getByText('มัดจำ').className).toBe('ps-title')
    expect(getByText('฿5,000').className).toBe('ps-sum')
    expect(container.querySelector('details.phone-section').open).toBe(false)
    expect(container.querySelector('.ps-body').textContent).toBe('body')
  })

  it('phone: defaultOpen opens it; no summary span without summary', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container } = render(<PhoneSection title="x" defaultOpen><p>b</p></PhoneSection>)
    expect(container.querySelector('details').open).toBe(true)
    expect(container.querySelector('.ps-sum')).toBeNull()
  })
})
