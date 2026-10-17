import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n) }))
vi.mock('../../lib/pdf.js', () => ({ downloadPDF: () => {} }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: null }) }))
vi.mock('../../components/Modal.jsx', () => ({ Modal: () => null }))
import { maskAcct } from './Payslip.jsx'

describe('maskAcct', () => {
  it('shows only the last 4 digits of a 10-digit account, grouped 3-1-5-1', () => {
    expect(maskAcct('1234567890')).toBe('xxx-x-xx789-0')
  })
  it('ignores existing separators', () => {
    expect(maskAcct('123-4-56789-0')).toBe('xxx-x-xx789-0')
  })
  it('groups other lengths by 4 and keeps only the last 4 digits', () => {
    expect(maskAcct('123456789012345')).toBe('xxxx-xxxx-xxx2-345'.replace('xxx2-345', 'xxx2-345'))
  })
  it('returns a dash for empty', () => {
    expect(maskAcct(null)).toBe('—')
    expect(maskAcct('')).toBe('—')
  })
})
