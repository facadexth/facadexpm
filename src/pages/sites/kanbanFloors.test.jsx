// @vitest-environment jsdom
// แยกตามชั้น: per-floor BOQ cards (generation, sum check, duplicate guard per zone), floor
// chip order, and billing / delivery-report sums across the floor cards of one item x phase.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'

const inserted = []
vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: () => ({ insert: (rows) => { inserted.push(...rows); return { select: async () => ({ data: rows.map((r, i) => ({ id: `n${i}`, ...r })), error: null }) } } }) },
}))
vi.mock('../../lib/audit.js', () => ({ auditLog: vi.fn() }))

import BoqBulkCardsDialog from './BoqBulkCardsDialog.jsx'
import { floorCardRows, splitEvenly, sortZones, boqCardCandidates, DEFAULT_FLOORS } from './boqPhaseCards.js'
import { doneQty } from '../../lib/progressBilling.js'
import { buildReportRows } from '../../lib/deliveryReport.js'

afterEach(() => { cleanup(); inserted.length = 0 })

const d1 = { id: 'b1', code: 'D1A', description: 'ประตู D1A', unit: 'ชุด', planned_qty: 7 }

describe('floorCardRows', () => {
  it('one card per floor with qty > 0, zone = floor, planned_qty = floor qty', () => {
    const { inserts, errors } = floorCardRows({ siteId: 's1', phaseId: 'p1', nextSortOrder: 5, floors: ['FL.1', 'FL.2', 'Deck'],
      rows: [{ item: d1, target: 7, perFloor: { 'FL.1': 4, 'FL.2': 0, Deck: '3' } }] })
    expect(errors).toEqual([])
    expect(inserts.map((r) => [r.zone, r.planned_qty, r.sort_order, r.boq_item_id, r.phase_id])).toEqual([['FL.1', 4, 5, 'b1', 'p1'], ['Deck', 3, 6, 'b1', 'p1']])
    expect(inserts[0]).toMatchObject({ progress_mode: 'quantity', status: 'not_started', name: 'ประตู D1A' })
  })
  it('row sum must equal the target', () => {
    const { inserts, errors } = floorCardRows({ siteId: 's1', phaseId: 'p1', nextSortOrder: 1, floors: ['FL.1', 'FL.2'],
      rows: [{ item: d1, target: 7, perFloor: { 'FL.1': 3, 'FL.2': 3 } }] })
    expect(inserts).toEqual([])
    expect(errors).toEqual([{ itemId: 'b1', sum: 6, target: 7 }])
  })
  it('skips a floor that already has a card (duplicate guard per item x phase x zone)', () => {
    const { inserts } = floorCardRows({ siteId: 's1', phaseId: 'p1', nextSortOrder: 1, floors: ['FL.1', 'FL.2'],
      rows: [{ item: d1, target: 2, perFloor: { 'FL.2': 2 }, skipZones: ['FL.1'] }] })
    expect(inserts.map((r) => r.zone)).toEqual(['FL.2'])
  })
  it('candidates list the zones already carded for the item in the phase', () => {
    const { rows } = boqCardCandidates({ phaseId: 'p1', boqItems: [d1], cells: { b1: { p1: 100 } },
      tasks: [{ id: 't', boq_item_id: 'b1', phase_id: 'p1', zone: 'FL.1', planned_qty: 5 }, { id: 'u', boq_item_id: 'b1', phase_id: 'p2', zone: 'FL.2', planned_qty: 1 }] })
    expect(rows[0]).toMatchObject({ remaining: 2, zones: ['FL.1'] })
  })
  it('splitEvenly: whole numbers for count units, decimals otherwise', () => {
    expect(splitEvenly(7, 3, true)).toEqual([3, 2, 2])
    expect(splitEvenly(10, 3, false).reduce((a, b) => a + b, 0)).toBeCloseTo(10)
  })
  it('sortZones: FL.n numerically, then Deck', () => {
    expect(sortZones(['Deck', 'FL.10', 'FL.2', 'FL.1'])).toEqual(['FL.1', 'FL.2', 'FL.10', 'Deck'])
  })
})

describe('BoqBulkCardsDialog แยกตามชั้น', () => {
  const rows = [{ item: d1, remaining: 7, full: false, zones: [] }]
  it('blocks create until the floor sum matches, then inserts one card per floor in one batch', async () => {
    const onCreated = vi.fn()
    render(<BoqBulkCardsDialog siteId="s1" phase={{ id: 'p1', name: 'ติดตั้ง' }} rows={rows} nextSortOrder={1} onClose={() => {}} onCreated={onCreated} />)
    fireEvent.click(screen.getByLabelText('แยกตามชั้น'))
    DEFAULT_FLOORS.forEach((f) => expect(screen.getByTestId(`floor-chip-${f}`)).toBeTruthy())
    fireEvent.change(screen.getByLabelText('จำนวน ประตู D1A FL.1'), { target: { value: '3' } })
    expect(screen.getByText(/ผลรวมทุกชั้นต้องเท่ากับ/)).toBeTruthy()
    expect(screen.getByText('สร้าง 0 การ์ด').closest('button').disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('จำนวน ประตู D1A Deck'), { target: { value: '4' } })
    const btn = screen.getByText('สร้าง 2 การ์ด').closest('button')
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(inserted.map((r) => [r.zone, r.planned_qty])).toEqual([['FL.1', 3], ['Deck', 4]])
  })
  it('แบ่งเท่าๆ กัน fills the open floors; floors can be removed and added', () => {
    render(<BoqBulkCardsDialog siteId="s1" phase={{ id: 'p1', name: 'ติดตั้ง' }} rows={rows} nextSortOrder={1} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('แยกตามชั้น'))
    fireEvent.click(screen.getByLabelText('ลบชั้น Deck'))
    fireEvent.change(screen.getByLabelText('เพิ่มชั้น'), { target: { value: 'RF' } })
    fireEvent.click(screen.getByText('+ เพิ่ม'))
    expect(screen.queryByTestId('floor-chip-Deck')).toBeNull()
    fireEvent.click(screen.getByText('แบ่งเท่าๆ กัน'))
    expect(screen.getByTestId('floor-sum-b1').textContent).toContain('7 / 7')
    expect(screen.getByText('สร้าง 7 การ์ด')).toBeTruthy()
  })
})

describe('billing + DR sum across floor cards', () => {
  const floorCards = [
    { boq_item_id: 'b1', phase_id: 'p1', zone: 'FL.1', progress_mode: 'quantity', planned_qty: 10, done_qty: 10 },
    { boq_item_id: 'b1', phase_id: 'p1', zone: 'FL.2', progress_mode: 'quantity', planned_qty: 16, done_qty: 6 },
  ]
  it('doneQty sums every floor card of the item x phase', () => {
    expect(doneQty(floorCards, 'b1', 'p1')).toBe(16)
  })
  it('DR checks the billed qty against the summed done qty', () => {
    const base = { invoice: { id: 'i' }, phases: [{ id: 'p1', name: 'ผลิต' }], earlierItems: [], earlierItemPhases: [],
      boqByQuotationItem: { qi1: { id: 'b1', unit: 'ตร.ม.', planned_qty: 26, code: '1', unit_price: 100 } },
      splitsByBoq: { b1: [{ phase_id: 'p1', pct: 100 }] }, cards: floorCards }
    const it1 = { id: 'it1', quotation_item_id: 'qi1', unit_price: 100, line_total: 1600 }
    const ok = buildReportRows({ ...base, invoiceItems: [it1], itemPhases: [{ invoice_item_id: 'it1', boq_item_id: 'b1', phase_id: 'p1', qty: 16, amount: 1600 }] })
    expect(ok.rows[0].reasons).not.toContain('qty_not_card')
    const over = buildReportRows({ ...base, invoiceItems: [it1], itemPhases: [{ invoice_item_id: 'it1', boq_item_id: 'b1', phase_id: 'p1', qty: 10, amount: 1000 }] })
    expect(over.rows[0].reasons).toContain('qty_not_card')
  })
})
