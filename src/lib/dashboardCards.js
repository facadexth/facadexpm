// Pure logic behind the home dashboard cards (src/pages/Dashboard.jsx).
// All dates are 'YYYY-MM-DD' / 'YYYY-MM' strings on the Bangkok calendar. Nothing here
// builds a Date from a bare 'YYYY-MM-DD' in local time: date maths uses Date.UTC only.
import { PENDING_ITEMS } from './pendingItems.js'

const pad = n => String(n).padStart(2, '0')
const toUtc = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
const fromUtc = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` }

/** Today (or `now`) on the Bangkok calendar. */
export function bangkokDate(now = new Date()) {
  return new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10)
}

export function addMonthsYm(ym, n) {
  const [y, m] = ym.split('-').map(Number)
  const idx = y * 12 + (m - 1) + n
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`
}

export function monthEndIso(ym) {
  const [y, m] = ym.split('-').map(Number)
  return fromUtc(Date.UTC(y, m, 0))
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000)
}

export function addDaysIso(iso, n) {
  return fromUtc(toUtc(iso) + n * 86400000)
}

/** Monday..Sunday week containing `today`. */
export function weekRange(today) {
  const ms = toUtc(today)
  const dow = (new Date(ms).getUTCDay() + 6) % 7 // Mon = 0
  return { from: fromUtc(ms - dow * 86400000), to: fromUtc(ms + (6 - dow) * 86400000) }
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
/** 'ต.ค. 69' (Buddhist year, 2 digits). */
export function thaiMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  return `${TH_MONTHS[m - 1]} ${String((y + 543) % 100).padStart(2, '0')}`
}

/** Same priority as payment_forecast and applyDateFilter('due'): check_date, due_date, date. */
export function expenseDueKey(e) {
  return e?.check_date || e?.due_date || e?.date || null
}

/**
 * This month + the next `extra` months of unpaid expenses (rows already filtered to
 * pending/check_issued) and uncashed cheques. Anything due before today is left out:
 * it belongs to the overdue card instead.
 */
export function dueByMonth(expenses, cheques, today, extra = 3) {
  const thisYm = today.slice(0, 7)
  const rows = []
  for (let i = 0; i <= extra; i++) {
    const month = addMonthsYm(thisYm, i)
    rows.push({ month, label: thaiMonthLabel(month), from: i === 0 ? today : `${month}-01`, to: monthEndIso(month), isCurrent: i === 0, amount: 0, count: 0, chequeCount: 0 })
  }
  const byMonth = new Map(rows.map(r => [r.month, r]))
  for (const e of expenses || []) {
    const k = expenseDueKey(e)
    if (!k || k < today) continue
    const r = byMonth.get(k.slice(0, 7))
    if (!r) continue
    r.amount += Number(e.amount) || 0
    r.count += 1
  }
  for (const c of cheques || []) {
    if (c.status === 'cashed' || !c.check_date || c.check_date < today) continue
    const r = byMonth.get(c.check_date.slice(0, 7))
    if (r) r.chequeCount += 1
  }
  return rows
}

/** Unpaid expenses whose due key is before today. */
export function overdueExpenses(expenses, today) {
  let count = 0
  let total = 0
  for (const e of expenses || []) {
    const k = expenseDueKey(e)
    if (!k || k >= today) continue
    count += 1
    total += Number(e.amount) || 0
  }
  return { count, total }
}

/** Ongoing sites whose end_date is before today, most days late first. */
export function lateSites(sites, today, limit = 4) {
  const late = (sites || [])
    .filter(s => s.status === 'Ongoing' && s.end_date && s.end_date < today)
    .map(s => ({ id: s.id, name: s.name, site_number: s.site_number, end_date: s.end_date, daysLate: daysBetween(s.end_date, today) }))
    .sort((a, b) => b.daysLate - a.daysLate)
  return { total: late.length, top: late.slice(0, limit), rest: Math.max(0, late.length - limit), all: late }
}

const WORK_TYPES = ['site', 'factory', 'subcontract'] // same as checkinDay.js
const workerName = w => w?.nickname || w?.name || '—'

/**
 * Today's crew from today's worker_assignments (with workers/sites names attached) and
 * today's worker_checkins. A worker counts as checked in when any row of theirs today has
 * checkin_at; per site, when that row is at the site or is the day's assembly tap.
 */
export function todayCrewSummary(assignments, checkins) {
  const work = (assignments || []).filter(a => a.site_id && WORK_TYPES.includes(a.type ?? 'site'))
  const tapped = (checkins || []).filter(c => c.checkin_at)
  const anyIn = new Set(tapped.map(c => c.worker_id))
  const assemblyIn = new Set(tapped.filter(c => c.is_assembly).map(c => c.worker_id))
  const siteIn = new Set(tapped.filter(c => c.site_id).map(c => `${c.worker_id}|${c.site_id}`))

  const workers = new Map()
  const sites = new Map()
  for (const a of work) {
    if (!workers.has(a.worker_id)) workers.set(a.worker_id, { id: a.worker_id, name: workerName(a.workers), checkedIn: anyIn.has(a.worker_id) })
    if (!sites.has(a.site_id)) sites.set(a.site_id, { siteId: a.site_id, name: a.sites?.name || '—', ids: new Set(), out: new Set() })
    const s = sites.get(a.site_id)
    s.ids.add(a.worker_id)
    if (!assemblyIn.has(a.worker_id) && !siteIn.has(`${a.worker_id}|${a.site_id}`)) s.out.add(a.worker_id)
  }
  const list = [...workers.values()].sort((x, y) => Number(x.checkedIn) - Number(y.checkedIn) || x.name.localeCompare(y.name, 'th'))
  const checkedIn = list.filter(w => w.checkedIn).length
  const bySite = [...sites.values()]
    .map(s => ({ siteId: s.siteId, name: s.name, count: s.ids.size, notCheckedIn: s.out.size }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name, 'th'))
  return { total: list.length, checkedIn, notCheckedIn: list.length - checkedIn, workers: list, bySite }
}

export function quotationCounts(rows) {
  const out = { sent: 0, accepted: 0, draft: 0, total: 0 }
  for (const q of rows || []) {
    out.total += 1
    if (q.status in out && q.status !== 'total') out[q.status] += 1
  }
  return out
}

/**
 * The chosen pending_counts() items, zero counts kept (the card shows "0"), each pointed at
 * the first page this user can open -- same tab rule as visiblePendingItems (the bell).
 */
export function pendingSummary(counts, canSeeTab, keys) {
  return keys
    .map(key => PENDING_ITEMS.find(i => i.key === key))
    .filter(Boolean)
    .map(item => ({ ...item, count: Number(counts?.[item.key]) || 0, tab: [item.tab, ...(item.fallbackTabs || [])].find(canSeeTab) }))
    .filter(item => item.tab)
}

/** Sites with people today whose % ตามสัญญา is 0 or unknown ("ต้องบันทึกยอด BOQ"). */
export function zeroProgressSites(bySite, pctBySite) {
  return (bySite || []).filter(s => !(Number(pctBySite?.[s.siteId]) > 0))
}

/** This week's repair visits from repair-linked worker_assignments, one row per ticket. */
export function repairsThisWeek(assignments) {
  const byTicket = new Map()
  for (const a of assignments || []) {
    if (!a.repair_ticket_id) continue
    const t = byTicket.get(a.repair_ticket_id) || { ticketId: a.repair_ticket_id, date: a.date, siteName: a.sites?.name || '—', crew: new Set() }
    if (a.date < t.date) t.date = a.date
    t.crew.add(a.worker_id)
    byTicket.set(a.repair_ticket_id, t)
  }
  return [...byTicket.values()].map(t => ({ ...t, crew: t.crew.size })).sort((x, y) => x.date.localeCompare(y.date))
}

/** Saved card prefs (raw localStorage string) merged with the current card ids. */
export function mergeCardPrefs(raw, ids) {
  const fallback = { order: [...ids], hidden: [] }
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    const saved = Array.isArray(parsed.order) ? parsed.order.filter(id => ids.includes(id)) : []
    // Cards added later are appended, so a user who customised before still sees them.
    const order = [...saved, ...ids.filter(id => !saved.includes(id))]
    return { order, hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(id => ids.includes(id)) : [] }
  } catch {
    return fallback
  }
}
