// @vitest-environment jsdom
// The shared inline error: title, text, and "ปิด" that calls onClose; no close button without onClose.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import InlineError from './InlineError.jsx'

afterEach(cleanup)

describe('InlineError', () => {
  it('shows the title and the text and closes with ปิด', () => {
    const onClose = vi.fn()
    render(<InlineError title="ยกเลิกใบตัดไม่ได้" onClose={onClose}>เศษถูกใช้แล้ว</InlineError>)
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('ยกเลิกใบตัดไม่ได้')
    expect(box.textContent).toContain('เศษถูกใช้แล้ว')
    expect(screen.getByLabelText('ปิดข้อความ').textContent).toBe('ปิด')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('has no close button without onClose', () => {
    render(<InlineError>ผิดพลาด</InlineError>)
    expect(screen.getByRole('alert').textContent).toContain('ผิดพลาด')
    expect(screen.queryByLabelText('ปิดข้อความ')).toBeNull()
  })
})
