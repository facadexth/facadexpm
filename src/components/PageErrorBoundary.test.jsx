// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const insert = vi.fn(() => Promise.resolve({ error: null }))
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn(() => ({ insert })) } }))
const { default: PageErrorBoundary, errorRow } = await import('./PageErrorBoundary.jsx')

afterEach(() => { cleanup(); insert.mockClear() })

let boom = true
function Doc() {
  if (boom) throw new Error('Maximum update depth exceeded')
  return <p>เอกสาร</p>
}

describe('PageErrorBoundary', () => {
  it('a crashing page shows the error instead of a blank screen and records it once', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    boom = true
    render(<PageErrorBoundary page="invoices" tenantId="t1"><Doc /></PageErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toMatch(/หน้านี้แสดงผลไม่ได้/)
    expect(screen.getByText('Maximum update depth exceeded')).toBeTruthy()
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({ page: 'invoices', tenant_id: 't1', message: 'Maximum update depth exceeded' })
    boom = false
    fireEvent.click(screen.getByText('ลองใหม่'))
    expect(screen.getByText('เอกสาร')).toBeTruthy()
    quiet.mockRestore()
  })
  it('moving to another page clears the error', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    boom = true
    const { rerender } = render(<PageErrorBoundary page="invoices"><Doc /></PageErrorBoundary>)
    boom = false
    rerender(<PageErrorBoundary page="expenses"><Doc /></PageErrorBoundary>)
    expect(screen.getByText('เอกสาร')).toBeTruthy()
    quiet.mockRestore()
  })
  it('errorRow keeps every field within the table limits', () => {
    const r = errorRow({ message: 'x'.repeat(5000), stack: 's'.repeat(9000) }, { componentStack: 'c' }, { page: 'p'.repeat(200) })
    expect(r.message).toHaveLength(2000)
    expect(r.stack).toHaveLength(8000)
    expect(r.page).toHaveLength(100)
    expect(r.tenant_id).toBeNull()
  })
})
