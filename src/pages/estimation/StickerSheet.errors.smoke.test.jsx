// @vitest-environment jsdom
// Stickers: a PDF that cannot be built is reported inline in the sticker card; never alert().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../lib/stickerRender.js', () => ({
  qrDataUrl: () => Promise.reject(new Error('qr boom')),
  endGlyphDataUrl: () => 'data:image/png;base64,AA',
  downloadStickersPdf: vi.fn(async () => {}),
}))
const { default: StickerSheet } = await import('./StickerSheet.jsx')

afterEach(cleanup)

const pc = len => ({ length_m: len, opening_no: 'W-01', item_id: 'i1', item_name: '', role_name: 'เฟรมบน', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square' })
const plan = { signature: 'S', groups: [{ key: 'A|F', profile_id: 'A', finish_id: 'F', die_no: '15100', name: 'เฟรมบน', finish_name: 'ขาว', length_m: 6.4, offcutBars: [],
  bars: [{ length_m: 6.4, left_m: 0.1, pieces: [pc(3), pc(3)] }], unplaced: [], newOffcuts: [] }] }
const issued = { id: 'cp1', status: 'issued', signature: 'S', issued_at: '2026-10-28T03:00:00Z', plan }

describe('StickerSheet errors', () => {
  it('a failed PDF shows an inline error, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<StickerSheet plan={plan} issued={issued} codes={{}} projectName="P" projectId="pj1" openingIds={{}} flipped={new Set()} onFlip={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByText(/ดาวน์โหลด PDF/)) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('สร้าง PDF ไม่สำเร็จ')
    expect(box.textContent).toContain('qr boom')
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore(); errSpy.mockRestore()
  })
})
