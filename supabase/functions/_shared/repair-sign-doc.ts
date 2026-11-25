// Pure helpers behind the sign-link 'repair_ticket' loader (CRM phase 2a task 5).
// No Deno or supabase imports, so vitest imports this file from src/lib/repairSignDoc.test.js.

export type RepairSignItemRow = { seq?: number | null; location?: string | null; room?: string | null; symptom?: string | null; note?: string | null }

const clean = (s: string | null | undefined) => (s ?? '').trim()

// '<location> (<room>) — <symptom>: <note>'; "(room)" and ": note" are left out when empty.
export function repairItemLine(it: RepairSignItemRow): string {
  const room = clean(it.room)
  const note = clean(it.note)
  return `${clean(it.location)}${room ? ` (${room})` : ''} — ${clean(it.symptom)}${note ? `: ${note}` : ''}`
}

// One { description } per item in seq order; a ticket without items (old chat-flow ticket) gets one
// item = its trimmed description, or no items at all when that is empty too.
export function repairSignItems(description: string | null | undefined, items: RepairSignItemRow[] | null | undefined): Array<{ description: string }> {
  const rows = [...(items ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  if (rows.length) return rows.map((it) => ({ description: repairItemLine(it) }))
  const d = clean(description)
  return d ? [{ description: d }] : []
}
