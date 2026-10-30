// @vitest-environment jsdom
// The job-type switch: a failed save is shown inline under the buttons and can be closed; never alert().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const saveProjectCutMode = vi.fn()
vi.mock('../../hooks/useEstimation2b.js', () => ({ saveProjectCutMode: (...a) => saveProjectCutMode(...a) }))
const { default: CutModeField } = await import('./CutModeField.jsx')

afterEach(() => { cleanup(); saveProjectCutMode.mockReset() })

describe('CutModeField errors', () => {
  it('a failed save shows an inline error that closes, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    saveProjectCutMode.mockRejectedValue(new Error('permission denied'))
    render(<CutModeField project={{ id: 'P' }} settings={{ stock_length_m: 6.4 }} canEdit onProjectSaved={async () => {}} />)
    await act(async () => { fireEvent.click(screen.getByText('งานโครงการ · สั่งความยาวพิเศษ')) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกประเภทงานไม่สำเร็จ')
    expect(box.textContent).toContain('permission denied')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
