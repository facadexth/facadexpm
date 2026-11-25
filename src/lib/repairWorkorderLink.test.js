import { describe, it, expect } from 'vitest'
import { workOrderLines, workOrderTickets } from '../../supabase/functions/_shared/repair-workorder-link.ts'

const FAIL = 'เปิดไม่ได้ตอนนี้ ลองใหม่'
const TODAY = '2026-11-25'
const row = (over = {}) => ({
  repair_ticket_id: 'r1',
  repair_tickets: { ticket_number: 'RP2611-007', status: 'scheduled', scheduled_date: TODAY },
  ...over,
})

describe('workOrderLines', () => {
  it('no rows -> no lines', () => {
    expect(workOrderLines([])).toEqual([])
  })
  it('one link per ticket, each after a blank line', () => {
    expect(workOrderLines([
      { ticketNumber: 'RP2611-007', url: 'https://changpm.app/w/abc' },
      { ticketNumber: 'RP2611-008', url: 'https://changpm.app/w/def' },
    ])).toEqual([
      '', '📄 ใบงานซ่อม RP2611-007: https://changpm.app/w/abc',
      '', '📄 ใบงานซ่อม RP2611-008: https://changpm.app/w/def',
    ])
  })
  it('failed token -> visible retry text, not a link', () => {
    expect(workOrderLines([{ ticketNumber: 'RP2611-007', url: null }]))
      .toEqual(['', `📄 ใบงานซ่อม RP2611-007: ${FAIL}`])
  })
})

describe('workOrderTickets', () => {
  it('keeps an active ticket scheduled today', () => {
    expect(workOrderTickets([row()], TODAY)).toEqual([{ ticketId: 'r1', ticketNumber: 'RP2611-007' }])
  })
  it('de-duplicates morning + evening rows for the same ticket', () => {
    expect(workOrderTickets([row(), row()], TODAY)).toHaveLength(1)
  })
  it('skips declined and done tickets', () => {
    expect(workOrderTickets([
      row({ repair_tickets: { ticket_number: 'A', status: 'declined', scheduled_date: TODAY } }),
      row({ repair_ticket_id: 'r2', repair_tickets: { ticket_number: 'B', status: 'done', scheduled_date: TODAY } }),
    ], TODAY)).toEqual([])
  })
  it('skips rows without a ticket id or joined ticket', () => {
    expect(workOrderTickets([row({ repair_ticket_id: null }), row({ repair_tickets: null })], TODAY)).toEqual([])
  })
  it('accepts the join as a one-element array', () => {
    expect(workOrderTickets([row({ repair_tickets: [row().repair_tickets] })], TODAY)).toHaveLength(1)
  })
  it('skips a ticket rescheduled away from today (the link would be refused)', () => {
    expect(workOrderTickets([row({ repair_tickets: { ticket_number: 'A', status: 'scheduled', scheduled_date: '2026-11-26' } })], TODAY)).toEqual([])
  })
  it('keeps order of first appearance', () => {
    const out = workOrderTickets([
      row({ repair_ticket_id: 'r2', repair_tickets: { ticket_number: 'B', status: 'scheduled', scheduled_date: TODAY } }),
      row(),
    ], TODAY)
    expect(out.map((t) => t.ticketNumber)).toEqual(['B', 'RP2611-007'])
  })
})
