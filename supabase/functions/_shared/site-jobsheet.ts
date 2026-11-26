// Pure view model for the crew daily job sheet (ใบงานประจำวัน). No Deno/supabase imports: shared by
// the web app (vitest + Vite) and the site-jobsheet edge function. The A4 sheet and the crew phone
// page both render the JobSheet this returns. Dates are 'YYYY-MM-DD' strings handled with UTC math,
// so no timezone can shift a day; "today" is always the Bangkok date the caller passes in.

import { siteMapLink } from './site-map-link.ts'
import { formatThaiDate } from './thai-date.ts'
import { thaiWeekday } from './repair-workorder.ts'
import { isWorkerDoneable, doneBlockedMessage } from './lineTaskRules.ts'

export const DEFAULT_SAFETY_NOTE =
  'ก่อนเริ่มงาน: ตรวจอุปกรณ์เซฟตี้ · ใส่เข็มขัดนิรภัยเมื่อทำงานที่สูง · ปูผ้ากันเปื้อนพื้น · เก็บเศษวัสดุและทำความสะอาดก่อนกลับ'

const NO_ZONE = 'ทั่วไป'
const STATUS_TEXT: Record<string, string> = { not_started: 'ยังไม่เริ่ม', in_progress: 'กำลังทำ', done: 'เสร็จแล้ว' }
const SHIFT_TEXT: Record<string, string> = { morning: 'เช้า', evening: 'บ่าย' }
const SHIFT_ORDER = ['morning', 'evening']
const RUN_GAP_DAYS = 3 // Fri -> Mon still counts as the same run of work days
const DAY_MS = 24 * 60 * 60 * 1000
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const byText = (a: string, b: string) => a.localeCompare(b, 'th', { numeric: true })

export type JobSheetRun = { index: number; total: number; from: string; to: string }

export type JobSheetInput = {
  tenant: { company_name?: string; address?: string; phone?: string; logo_url?: string | null }
  date: string // Bangkok YYYY-MM-DD
  site: {
    id: string; name: string; site_number?: string | null; location?: string | null; map_url?: string | null
    lat?: number | null; lng?: number | null; safety_note?: string | null
  }
  tenantSafetyDefault?: string | null
  run: JobSheetRun | null
  crew: Array<{ worker_id: string; name: string; nickname?: string | null; shifts: string[]; is_team_leader: boolean }>
  phases: Array<{ id: string; name: string; sort_order: number; is_issue_phase?: boolean }>
  cards: Array<{
    id: string; phase_id: string; name: string; zone?: string | null; status: 'not_started' | 'in_progress' | 'done'
    sort_order?: number | null; progress_mode?: string | null; planned_qty?: number | null; done_qty?: number | null
    unit?: string | null; issue_report_id?: string | null; has_children?: boolean; worker_ids: string[]
    updated_at?: string | null
  }>
  drawings: Array<{ id: string; title: string; url: string | null }>
  viewerWorkerId?: string | null // crew page: the token's worker
}

export type JobSheetCard = {
  id: string; name: string; statusText: string; qtyText: string; ownersText: string
  mine: boolean; canClose: boolean; blockedText: string | null
}

export type JobSheet = {
  dateText: string
  runText: string | null
  company: { name: string; address: string; phone: string; logoUrl: string | null }
  siteName: string; address: string; mapUrl: string | null
  leaderText: string
  crewText: string
  safetyNote: string
  progressText: string | null
  problems: Array<{ id: string; name: string; zone: string }>
  groups: Array<{ phase: string; zone: string; cards: JobSheetCard[] }>
  cardCount: number // cards in groups (problem cards not counted)
  drawings: JobSheetInput['drawings']
  viewerIsLeader: boolean
}

type Card = JobSheetInput['cards'][number]

// Site note (trimmed) -> tenant default -> built-in default.
export function resolveSafetyNote(siteNote?: string | null, tenantDefault?: string | null): string {
  return str(siteNote) || str(tenantDefault) || DEFAULT_SAFETY_NOTE
}

function dayNumber(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''))
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null
}

// Which day of a run of work days today is. Dates = this worker's install days at this site (any
// order, duplicates allowed). A next date at most RUN_GAP_DAYS calendar days after the previous stays
// in the same run. null when today is not one of the dates.
export function runOfDays(dates: string[], today: string): JobSheetRun | null {
  const uniq = [...new Set((dates || []).filter((d) => dayNumber(d) != null))].sort()
  const at = uniq.indexOf(today)
  if (at < 0) return null
  let start = at
  while (start > 0 && dayNumber(uniq[start])! - dayNumber(uniq[start - 1])! <= RUN_GAP_DAYS) start--
  let end = at
  while (end < uniq.length - 1 && dayNumber(uniq[end + 1])! - dayNumber(uniq[end])! <= RUN_GAP_DAYS) end++
  return { index: at - start + 1, total: end - start + 1, from: uniq[start], to: uniq[end] }
}

// 'วันที่ 3 จาก 5 · 24–28/11/2569' (same month), '28/11–02/12/2569' (same year), full dates otherwise.
function runText(run: JobSheetRun | null): string | null {
  if (!run) return null
  const head = `วันที่ ${run.index} จาก ${run.total} · `
  const from = formatThaiDate(run.from)
  const to = formatThaiDate(run.to)
  if (run.from === run.to) return head + from
  const [fd, fm, fy] = from.split('/')
  const [, tm, ty] = to.split('/')
  if (fy === ty && fm === tm) return `${head}${fd}–${to}`
  if (fy === ty) return `${head}${fd}/${fm}–${to}`
  return `${head}${from}–${to}`
}

function personName(c: { name: string; nickname?: string | null }): string {
  const nick = str(c.nickname)
  return nick ? `${str(c.name)} (${nick})` : str(c.name)
}

function shiftsText(shifts: string[]): string {
  const list = [...new Set((shifts || []).filter((s) => typeof s === 'string' && s))]
  list.sort((a, b) => {
    const ia = SHIFT_ORDER.indexOf(a), ib = SHIFT_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return list.map((s) => SHIFT_TEXT[s] ?? s).join(' + ')
}

function bangkokDate(iso: string | null | undefined): string | null {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) ? new Date(t + BKK_OFFSET_MS).toISOString().slice(0, 10) : null
}

const num = (v: unknown): string => {
  const n = Number(v)
  return v != null && Number.isFinite(n) ? String(n) : '0'
}

function qtyText(c: Card): string {
  if ((c.progress_mode ?? 'status') !== 'quantity') return '-'
  const unit = str(c.unit)
  const s = `${num(c.done_qty)}/${num(c.planned_qty)}`
  return unit ? `${s} ${unit}` : s
}

export function buildJobSheet(input: JobSheetInput): JobSheet {
  const { tenant, site, date } = input
  const crew = (input.crew || []).filter((c) => str(c?.name))
  const phases = new Map((input.phases || []).map((p) => [p.id, p]))
  const cards = input.cards || []
  const viewer = input.viewerWorkerId || null

  const leaders = crew.filter((c) => c.is_team_leader)
  const others = crew.filter((c) => !c.is_team_leader).sort((a, b) => byText(str(a.name), str(b.name)))
  const leaderText = leaders.length
    ? leaders.map((c) => {
      const sh = shiftsText(c.shifts)
      return sh ? `${personName(c)} · ${sh}` : personName(c)
    }).join(', ')
    : '-'
  const crewText = others.length ? others.map(personName).join(', ') : '-'
  const nameOf = new Map(crew.map((c) => [c.worker_id, str(c.name)]))

  const isIssue = (c: Card) => !!c.issue_report_id || phases.get(c.phase_id)?.is_issue_phase === true
  const shown = (c: Card) => c.status !== 'done' || bangkokDate(c.updated_at) === date

  // Crew hint only: share of cards done in the phase with the most open cards. The weighted
  // 100-point % is the PM's figure in the web app; this deliberately just counts cards.
  let progressText: string | null = null
  const perPhase = new Map<string, { all: number; done: number }>()
  for (const c of cards) {
    if (isIssue(c)) continue
    const p = perPhase.get(c.phase_id) ?? { all: 0, done: 0 }
    p.all++
    if (c.status === 'done') p.done++
    perPhase.set(c.phase_id, p)
  }
  let best: { id: string; open: number; order: number } | null = null
  for (const [id, p] of perPhase) {
    const open = p.all - p.done
    const order = phases.get(id)?.sort_order ?? Number.MAX_SAFE_INTEGER
    if (!best || open > best.open || (open === best.open && order < best.order)) best = { id, open, order }
  }
  if (best) {
    const p = perPhase.get(best.id)!
    const name = str(phases.get(best.id)?.name) || '-'
    progressText = `${name} · คืบหน้า ${Math.round((p.done / p.all) * 100)}%`
  }

  const problems = cards
    .filter((c) => isIssue(c) && c.status !== 'done')
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((c) => ({ id: c.id, name: str(c.name), zone: str(c.zone) || NO_ZONE }))

  type Group = { phase: string; zone: string; order: number; items: Card[] }
  const groupMap = new Map<string, Group>()
  for (const c of cards) {
    if (isIssue(c) || !shown(c)) continue
    const ph = phases.get(c.phase_id)
    const zone = str(c.zone) || NO_ZONE
    const key = `${c.phase_id}\u0000${zone}`
    let g = groupMap.get(key)
    if (!g) {
      g = { phase: str(ph?.name) || '-', zone, order: ph?.sort_order ?? Number.MAX_SAFE_INTEGER, items: [] }
      groupMap.set(key, g)
    }
    g.items.push(c)
  }
  const isMine = (c: Card) => !!viewer && (c.worker_ids || []).includes(viewer)
  const groups = [...groupMap.values()]
    .sort((a, b) => a.order - b.order || byText(a.phase, b.phase) || byText(a.zone, b.zone))
    .map((g) => ({
      phase: g.phase,
      zone: g.zone,
      cards: [...g.items]
        .sort((a, b) => Number(isMine(b)) - Number(isMine(a)) || (a.sort_order ?? 0) - (b.sort_order ?? 0)
          || byText(str(a.name), str(b.name)))
        .map((c): JobSheetCard => {
          const rule = { progress_mode: c.progress_mode ?? null, has_children: c.has_children === true }
          const owners = (c.worker_ids || []).map((id) => nameOf.get(id)).filter((n): n is string => !!n)
          return {
            id: c.id,
            name: str(c.name),
            statusText: STATUS_TEXT[c.status] ?? c.status,
            qtyText: qtyText(c),
            ownersText: owners.length ? owners.join(', ') : '-',
            mine: isMine(c),
            canClose: isWorkerDoneable(rule) && c.status !== 'done',
            blockedText: doneBlockedMessage(rule),
          }
        }),
    }))

  return {
    dateText: `${thaiWeekday(date)} ${formatThaiDate(date)}`.trim(),
    runText: runText(input.run),
    company: {
      name: str(tenant?.company_name),
      address: str(tenant?.address),
      phone: str(tenant?.phone),
      logoUrl: str(tenant?.logo_url) || null,
    },
    siteName: str(site?.name) || '-',
    address: str(site?.location) || '-',
    mapUrl: siteMapLink(site),
    leaderText,
    crewText,
    safetyNote: resolveSafetyNote(site?.safety_note, input.tenantSafetyDefault),
    progressText,
    problems,
    groups,
    cardCount: groups.reduce((n, g) => n + g.cards.length, 0),
    drawings: input.drawings || [],
    viewerIsLeader: !!viewer && crew.some((c) => c.worker_id === viewer && c.is_team_leader),
  }
}
