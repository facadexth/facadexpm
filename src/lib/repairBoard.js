// Pure rules for the งานซ่อม Kanban board (src/pages/Repairs.jsx): which column a ticket
// sits in, what a drag-and-drop does, the database patch for a move, and the card texts.
import { REPAIR_STATUS, canMove } from './repairStatus.js'
import { warrantyStatus } from './warranty.js'

export const DONE_WINDOW_DAYS = 60

export const BOARD_COLUMNS = [
  { status: 'pending_review', label: REPAIR_STATUS.pending_review, icon: '📥' },
  { status: 'received', label: REPAIR_STATUS.received, icon: '📋' },
  { status: 'scheduled', label: REPAIR_STATUS.scheduled, icon: '📅' },
  { status: 'in_progress', label: REPAIR_STATUS.in_progress, icon: '🔨' },
  { status: 'done', label: REPAIR_STATUS.done, icon: '✅' },
]

// ISO timestamp -> Bangkok 'YYYY-MM-DD' ('' when missing or unreadable).
export function bangkokDateOf(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10)
}

function dayNum(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86400000)
}

function withinWindow(iso, today) {
  const d = bangkokDateOf(iso)
  return d !== '' && dayNum(today) - dayNum(d) <= DONE_WINDOW_DAYS
}

const desc = (k) => (a, b) => String(b[k] ?? '').localeCompare(String(a[k] ?? ''))
const apptKey = (t) => `${t.scheduled_date ?? '9999-99-99'} ${t.scheduled_start ?? '99:99'}`

// { pending_review, received, scheduled, in_progress, done, declined } -> ticket arrays.
// done and declined keep only the last DONE_WINDOW_DAYS days (Bangkok dates).
export function groupTickets(tickets, today) {
  const g = { pending_review: [], received: [], scheduled: [], in_progress: [], done: [], declined: [] }
  for (const t of tickets || []) {
    if (!g[t.status]) continue
    if (t.status === 'done' && !withinWindow(t.done_at, today)) continue
    if (t.status === 'declined' && !withinWindow(t.declined_at, today)) continue
    g[t.status].push(t)
  }
  g.pending_review.sort(desc('created_at'))
  g.received.sort(desc('created_at'))
  g.scheduled.sort((a, b) => apptKey(a).localeCompare(apptKey(b)))
  g.in_progress.sort((a, b) => apptKey(a).localeCompare(apptKey(b)))
  g.done.sort(desc('done_at'))
  g.declined.sort(desc('declined_at'))
  return g
}

// What dropping a card from one column onto another does:
//  'move'  -> update the status right away
//  'modal' -> open the detail modal (นัดเข้า needs a date; เสร็จ needs an after photo)
//  'none'  -> ignore (same column, or the status rules forbid it)
export function dropAction(from, to) {
  if (from === to || !canMove(from, to)) return 'none'
  if (to === 'scheduled' || to === 'done') return 'modal'
  return 'move'
}

const STAMP = { received: 'received_at', in_progress: 'started_at', done: 'done_at', declined: 'declined_at' }

// repair_tickets update for a board move.
export function movePatch(to, nowIso) {
  const p = { status: to }
  if (STAMP[to]) p[STAMP[to]] = nowIso
  return p
}

// "10 นาทีที่แล้ว" / "2 ชม.ที่แล้ว" / "3 วันที่แล้ว".
export function ageText(iso, nowMs = Date.now()) {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const min = Math.floor(Math.max(0, nowMs - ms) / 60000)
  if (min < 1) return 'เมื่อสักครู่'
  if (min < 60) return `${min} นาทีที่แล้ว`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ชม.ที่แล้ว`
  return `${Math.floor(h / 24)} วันที่แล้ว`
}

// ticket id -> number of distinct workers assigned to it on its appointment date.
export function crewCounts(tickets, assignments) {
  const dateOf = {}
  for (const t of tickets || []) if (t.scheduled_date) dateOf[t.id] = t.scheduled_date
  const sets = {}
  for (const a of assignments || []) {
    const d = dateOf[a.repair_ticket_id]
    if (!d || a.date !== d || !a.worker_id) continue
    ;(sets[a.repair_ticket_id] ||= new Set()).add(a.worker_id)
  }
  return Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.size]))
}

// Warranty of the ticket's site (ticket.sites = embedded site row).
export function warrantyOf(ticket, today) {
  const s = ticket?.sites || {}
  return warrantyStatus(s.handover_date, Number(s.warranty_months) || 0, today)
}

// Filter chips: 'all' | 'active' (ในประกัน) | 'expired' (หมดประกัน: expired, or a site with no warranty).
// A site not handed over yet is neither.
export function matchesWarrantyFilter(ticket, filter, today) {
  if (!filter || filter === 'all') return true
  const k = warrantyOf(ticket, today).kind
  if (filter === 'active') return k === 'active'
  if (filter === 'expired') return k === 'expired' || k === 'none'
  return true
}

// ticket id -> { shown: first 3 media by created_at, more: how many are left over }.
export function pickThumbs(media, max = 3) {
  const by = {}
  for (const m of media || []) (by[m.ticket_id] ||= []).push(m)
  const out = {}
  for (const [id, list] of Object.entries(by)) {
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    out[id] = { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
  }
  return out
}
