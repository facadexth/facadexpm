// @vitest-environment jsdom
// TemplateCardGrid: cards with a drawing (part / frame / placeholder), chips by top-level type, search, pick, empty texts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { startModel } from '../../lib/partModel.js'
import TemplateCardGrid from './TemplateCardGrid.jsx'

afterEach(cleanup)

const typesById = {
  win: { id: 'win', name: 'หน้าต่าง' }, slide: { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' },
  door: { id: 'door', name: 'ประตู' }, swing: { id: 'swing', name: 'บานสวิง', parent_id: 'door' },
}
const model = startModel('sliding_2')
for (const k of Object.keys(model.lines)) model.lines[k][0].profile_family = 'FR'
const templates = [
  { id: 'p', name: 'เลื่อนสวน 2 บาน', type_id: 'slide', layout_kind: 'sliding_2', active: true },
  { id: 'f', name: 'สวิงคู่', type_id: 'swing', grid_row_weights: [1], active: true },
  { id: 'n', name: 'Unloaded', type_id: 'slide', layout_kind: 'sliding_2', active: false },
]
const cards = () => screen.getAllByRole('button').filter(b => b.hasAttribute('title'))

describe('TemplateCardGrid', () => {
  it('draws every card, highlights the selected one and picks on click', () => {
    const onPick = vi.fn()
    const { container } = render(<TemplateCardGrid templates={templates} typesById={typesById} partModelByTemplate={{ p: model }} selectedId="f" onPick={onPick} />)
    expect(cards()).toHaveLength(3)
    expect(container.querySelector('img[src^="data:image/svg+xml"]')).not.toBeNull()
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0)
    expect(screen.getByText('UN')).toBeTruthy()
    expect(screen.getByText(/🚫/).textContent).toContain('Unloaded')
    expect(screen.getByTitle('สวิงคู่').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle('เลื่อนสวน 2 บาน').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTitle('เลื่อนสวน 2 บาน'))
    expect(onPick).toHaveBeenCalledWith(templates[0])
    expect(container.innerHTML).not.toMatch(/NaN|ม\.<\/text>/)
  })
  it('filters by chip and by search, with the Thai empty text', () => {
    render(<TemplateCardGrid templates={templates} typesById={typesById} partModelByTemplate={{}} selectedId={null} onPick={() => {}} />)
    const chip = within(screen.getByRole('group')).getByRole('button', { name: /ประตู/ })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(cards().map(b => b.title)).toEqual(['สวิงคู่'])
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: /ทั้งหมด/ }))
    fireEvent.change(screen.getByLabelText('ค้นหาเทมเพลต'), { target: { value: 'ไม่มีแบบนี้' } })
    expect(cards()).toHaveLength(0)
    expect(screen.getByText('ไม่พบเทมเพลตที่ตรงกับคำค้น')).toBeTruthy()
  })
  it('chips={false} hides the chips; no templates shows the empty text', () => {
    const { unmount } = render(<TemplateCardGrid templates={templates} typesById={typesById} chips={false} onPick={() => {}} />)
    expect(screen.queryByRole('group')).toBeNull()
    unmount()
    render(<TemplateCardGrid templates={[]} typesById={typesById} onPick={() => {}} emptyText="ยังไม่มี Template" />)
    expect(screen.getByText('ยังไม่มี Template')).toBeTruthy()
  })
})
