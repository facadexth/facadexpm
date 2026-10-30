// @vitest-environment jsdom
// Stickers by bar range: default first 10 bars, per-10 quick buttons, typed ranges clamped, k/N stays whole-project,
// and a group cut only from stock offcuts has no range.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../lib/stickerRender.js', () => ({
  qrDataUrl: async () => 'data:image/png;base64,AA',
  endGlyphDataUrl: () => 'data:image/png;base64,AA',
  downloadStickersPdf: vi.fn(async () => {}),
}))
const { default: StickerSheet } = await import('./StickerSheet.jsx')

afterEach(cleanup)

const pc = (len, o = {}) => ({ length_m: len, opening_no: 'W-01', item_id: 'i1', item_name: '', role_name: 'เฟรมบน', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square', ...o })
const big = {
  key: 'A|F', profile_id: 'A', finish_id: 'F', die_no: '15100', name: 'เฟรมบน', finish_name: 'POWDER COATING WHITE', length_m: 6.4, offcutBars: [], unplaced: [],
  bars: Array.from({ length: 12 }, () => ({ length_m: 6.4, left_m: 1.0, pieces: [pc(1.8), pc(1.8), pc(1.8)] })),
  newOffcuts: Array.from({ length: 12 }, (_, i) => ({ key: `A|F#${i + 1}`, bar_ref: String(i + 1), length_m: 1.0, end_a: 'square', keep: true })),
}
const fromStock = {
  key: 'B|F', profile_id: 'B', finish_id: 'F', die_no: null, name: 'เสากุญแจ', finish_name: 'POWDER COATING WHITE', length_m: 6.4, bars: [], unplaced: [],
  offcutBars: [{ length_m: 5.6, left_m: 0.6, pieces: [pc(2.5, { opening_no: 'T-01' }), pc(2.5, { opening_no: 'T-01' })], offcut: { id: 'o6', code: 'OC-0006', length_m: 5.6 } }],
}
fromStock.newOffcuts = [{ key: 'B|F#OC-0006', bar_ref: 'OC-0006', length_m: 0.6, end_a: 'square', keep: true }]
const plan = { signature: 'S', groups: [big, fromStock] }
const view = () => render(<StickerSheet plan={plan} issued={null} codes={null} projectName="PARLLEL TROPICAL" projectId="pj1" openingIds={{}} flipped={new Set()} onFlip={() => {}} />)
const text = () => document.body.textContent

describe('StickerSheet bar range', () => {
  it('opens on bars 1–10 with per-10 buttons, the count on the PDF button and whole-project numbers', () => {
    view()
    expect(screen.getByRole('option', { name: '15100 เฟรมบน · POWDER COATING WHITE (12 เส้น)' })).toBeTruthy()
    expect(text()).toContain('รอบละ 10 เส้น:')
    expect(screen.getByRole('button', { name: '1–10' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '11–12' }).getAttribute('aria-pressed')).toBe('false')
    expect(text()).toContain('เฟรมบน เส้น 1–10 = ท่อน 30 ดวง + เศษ 10 ดวง · ลำดับ 1/38 … 30/38')
    expect(screen.getByText('ดาวน์โหลด PDF 40 ดวง')).toBeTruthy()
  })
  it('a quick button and ทั้งหมด change the range', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: '11–12' }))
    expect(text()).toContain('เฟรมบน เส้น 11–12 = ท่อน 6 ดวง + เศษ 2 ดวง · ลำดับ 31/38 … 36/38')
    expect(screen.getByText('ดาวน์โหลด PDF 8 ดวง')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ทั้งหมด' }))
    expect(text()).toContain('เฟรมบน เส้น 1–12 = ท่อน 36 ดวง + เศษ 12 ดวง')
  })
  it('a typed range is clamped and put in order', () => {
    view()
    fireEvent.change(screen.getByLabelText('เส้นที่'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: '3' } })
    expect(text()).toContain('เฟรมบน เส้น 3–12 = ท่อน 30 ดวง')
    fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: '99' } })
    expect(text()).toContain('เฟรมบน เส้น 12–12 = ท่อน 3 ดวง')
  })
  it('a group with no new bars has no range and lists all its stickers', () => {
    view()
    fireEvent.change(screen.getByLabelText('หน้าตัด'), { target: { value: 'B|F' } })
    expect(screen.queryByLabelText('เส้นที่')).toBeNull()
    expect(text()).not.toContain('รอบละ 10 เส้น:')
    expect(text()).toContain('2 ท่อน + เศษ 1 ชิ้น')
    expect(screen.getByText('ดาวน์โหลด PDF 3 ดวง')).toBeTruthy()
  })
})
