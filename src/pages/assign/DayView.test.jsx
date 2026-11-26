// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

const h = vi.hoisted(() => ({ modalProps: [] }))

vi.mock('../../lib/supabase.js', () => ({ fmt: (n) => String(n) }))
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => ({ data: [] }),
  usePhaseTasks: () => ({ data: [] }),
}))
vi.mock('../../components/SiteJobSheetModal.jsx', () => ({
  default: (props) => { h.modalProps.push(props); return <div data-testid="js-modal">{props.siteId}</div> },
}))

import DayView from './DayView.jsx'

afterEach(() => { cleanup(); h.modalProps = [] })

const DAY = '2026-11-26'
const W = { name: 'สมชาย', nickname: 'ชาย', daily_wage: 500 }
const SITES = [
  { id: 'sA', name: 'ไซท์ติดตั้ง', short_name: 'INS', site_number: 'S-1' },
  { id: 'sB', name: 'ไซท์ซ่อม', site_number: 'S-2' },
  { id: 'sC', name: 'โรงงาน', site_number: 'S-3' },
]
const ROWS = [
  { id: 'a1', date: DAY, site_id: 'sA', type: 'site', shift: 'morning', worker_id: 'w1', workers: W },
  { id: 'a2', date: DAY, site_id: 'sB', type: 'site', shift: 'morning', worker_id: 'w2', workers: W, repair_ticket_id: 'rt1' },
  { id: 'a3', date: DAY, site_id: 'sC', type: 'factory', shift: 'morning', worker_id: 'w3', workers: W },
  { id: 'a4', date: '2026-11-27', site_id: 'sB', type: 'site', shift: 'morning', worker_id: 'w4', workers: W },
]

const card = (name) => screen.getByText(name).closest('.card')

describe('DayView 🖨 ใบงานวันนี้', () => {
  it('shows the button only on sites with an install (type site, not repair) assignment that day', () => {
    render(<DayView dayIso={DAY} assignments={ROWS} otEntries={[]} sites={SITES} travelRate={0} onEditHalf={() => {}} />)
    expect(within(card('ไซท์ติดตั้ง')).queryByText('🖨 ใบงานวันนี้')).toBeTruthy()
    expect(within(card('ไซท์ซ่อม')).queryByText('🖨 ใบงานวันนี้')).toBeNull()
    expect(within(card('โรงงาน')).queryByText('🖨 ใบงานวันนี้')).toBeNull()
    expect(screen.getAllByText('🖨 ใบงานวันนี้')).toHaveLength(1)
  })

  it('opens the job sheet modal for that site and day, with the short name', () => {
    render(<DayView dayIso={DAY} assignments={ROWS} otEntries={[]} sites={SITES} travelRate={0} onEditHalf={() => {}} />)
    expect(screen.queryByTestId('js-modal')).toBeNull()
    fireEvent.click(screen.getByText('🖨 ใบงานวันนี้'))
    expect(screen.getByTestId('js-modal').textContent).toBe('sA')
    const p = h.modalProps.at(-1)
    expect(p.siteId).toBe('sA')
    expect(p.date).toBe(DAY)
    expect(p.shortName).toBe('INS')
    p.onClose()
  })
})
