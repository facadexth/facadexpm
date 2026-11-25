// Crew LINE "งานวันนี้": one 📄 ใบงานซ่อม link per repair job the worker has today.
// Pure rules here (unit-tested from src/lib/repairWorkorderLink.test.js); line-webhook does the DB
// reads and the token inserts.

type JoinedTicket = { ticket_number?: string | null; status?: string | null; scheduled_date?: string | null }
export type WorkOrderAssignmentRow = {
  repair_ticket_id?: string | null
  repair_tickets?: JoinedTicket | JoinedTicket[] | null
}

// Statuses with no work left for the crew -- no link.
const CLOSED = new Set(['declined', 'done'])

// Today's worker_assignments rows (repair_ticket_id not null, joined repair_tickets) -> one entry
// per ticket, in first-seen order. A worker can hold a morning AND an evening row for the same
// ticket, so de-duplicate. A ticket whose scheduled_date is no longer today is skipped: the
// repair-workorder function only accepts a crew token on the ticket's current scheduled_date, so
// a link would just be refused.
export function workOrderTickets(rows: WorkOrderAssignmentRow[], today: string): Array<{ ticketId: string; ticketNumber: string }> {
  const seen = new Set<string>()
  const out: Array<{ ticketId: string; ticketNumber: string }> = []
  for (const r of rows) {
    const id = r.repair_ticket_id
    const t = Array.isArray(r.repair_tickets) ? r.repair_tickets[0] : r.repair_tickets
    if (!id || !t || !t.ticket_number) continue
    if (CLOSED.has(t.status ?? '')) continue
    if (t.scheduled_date !== today) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ticketId: id, ticketNumber: t.ticket_number })
  }
  return out
}

// Reply lines to append; url null = the token insert failed.
export function workOrderLines(rows: Array<{ ticketNumber: string; url: string | null }>): string[] {
  return rows.flatMap((r) => ['', `📄 ใบงานซ่อม ${r.ticketNumber}: ${r.url ?? 'เปิดไม่ได้ตอนนี้ ลองใหม่'}`])
}

// A crew work order token lives until the end of the Bangkok day it was issued on
// (23:59:59 +07:00), matching "งานวันนี้": tomorrow's jobs need tomorrow's links. Bangkok has no
// DST, so a fixed +7 h offset is always right. Returns a UTC ISO string.
export function workOrderTokenExpiry(nowMs: number): string {
  const day = new Date(nowMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return new Date(`${day}T23:59:59+07:00`).toISOString()
}
