// Flex carousel for the customer bot's "สถานะงาน": one card per ongoing site with a mini Gantt of
// its phases (owner design C, 2026-10-20). Pure: no Deno or supabase imports (vitest imports it).
// Customer-facing only: site name, %, phase names/dates/status, due date. No money, people or notes.

import { formatThaiDate } from './thai-date.ts'
import { row, dayNum, statusText, ALT_TEXT_MAX, COLOR_ACTIVE, COLOR_PRIMARY, STATUS_MAX_SITES, type Flex, type SitePhase, type SiteStatus } from './customer-line-replies.ts'
import type { LineMessage } from './line-reply.ts'

const COLOR_HEADER = '#2B6CB0'
const COLOR_DOING = '#2B6CB0'
const COLOR_TODO = '#CFC8BE'
const COLOR_TODAY = '#B04A38'
const COLOR_MUTED = '#8A847C'

const MAX_ROWS = 12
const LINE_TEXT_MAX = 5000
// LINE limits a carousel's JSON to 50 KB; keep a margin. A card costs ~1.5 KB plus ~0.55 KB per row,
// so a busy carousel (many sites) shows fewer rows per card ("+N ขั้นตอน"), and only if even that is
// too big are the last cards dropped (the altText fallback still lists every site).
const CAROUSEL_BUDGET = 46000
const MIN_ROWS = 3
const MAX_MONTH_LABELS = 6
const MAX_YEAR_LABELS = 4
const ROW_H = 18
const BAR_H = 10
const NAME_W = '86px'
const NAME_MAX = 20
const SITE_NAME_MAX = 50

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

export type GanttSpan = { start: string; end: string; startDay: number; days: number }

const pad2 = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// A phase's [start, end] (YYYY-MM-DD), using the one date it has for both; null when it has none.
function phaseRange(p: SitePhase): [string, string] | null {
  const a = p.start_date ? p.start_date.slice(0, 10) : null
  const b = p.end_date ? p.end_date.slice(0, 10) : null
  if (!a && !b) return null
  const s = (a ?? b) as string
  const e = (b ?? a) as string
  return s <= e ? [s, e] : [e, s]
}

// min(phase start) .. max(phase end), widened to include today, padded to whole months.
export function ganttSpan(phases: SitePhase[], today: string): GanttSpan {
  let lo = today.slice(0, 10)
  let hi = lo
  for (const p of phases) {
    const r = phaseRange(p)
    if (!r) continue
    if (r[0] < lo) lo = r[0]
    if (r[1] > hi) hi = r[1]
  }
  const [ly, lm] = lo.split('-').map(Number)
  const [hy, hm] = hi.split('-').map(Number)
  const start = ymd(ly, lm, 1)
  const end = ymd(hy, hm, lastDay(hy, hm))
  const startDay = dayNum(start)
  return { start, end, startDay, days: dayNum(end) - startDay + 1 }
}

// Whole-number percents of the span; offset + width never exceeds 100 and width is at least 1.
export function barPercents(start: string, end: string, span: GanttSpan): { offset: number; width: number } {
  const clamp = (n: number) => Math.min(span.days, Math.max(0, n))
  const s = clamp(dayNum(start) - span.startDay)
  const e = clamp(dayNum(end) - span.startDay + 1)
  let offset = Math.round((s / span.days) * 100)
  const width = Math.max(1, Math.round((e / span.days) * 100) - offset)
  if (offset + width > 100) offset = 100 - width
  return { offset, width }
}

function monthLabels(span: GanttSpan): Flex[] {
  const [sy, sm] = span.start.split('-').map(Number)
  const [ey, em] = span.end.split('-').map(Number)
  const count = (ey - sy) * 12 + (em - sm) + 1
  // Over 12 months the same month name repeats, so each label gets a short พ.ศ. year ("ม.ค. 70"),
  // and fewer labels fit.
  const withYear = count > 12
  const step = Math.ceil(count / (withYear ? MAX_YEAR_LABELS : MAX_MONTH_LABELS))
  const out: Flex[] = []
  for (let i = 0; i < count; i += step) {
    const y = sy + Math.floor((sm - 1 + i) / 12)
    const m = ((sm - 1 + i) % 12) + 1
    const offset = Math.round(((dayNum(ymd(y, m, 1)) - span.startDay) / span.days) * 100)
    const text = withYear ? `${MONTHS[m - 1]} ${String(y + 543).slice(-2)}` : MONTHS[m - 1]
    out.push({ type: 'text', text, size: 'xxs', color: COLOR_MUTED, position: 'absolute', offsetTop: '0px', offsetStart: `${offset}%` })
  }
  return out
}

const barColor = (status: string) => (status === 'done' ? COLOR_ACTIVE : status === 'in_progress' ? COLOR_DOING : COLOR_TODO)

function gantt(phases: SitePhase[], today: string, maxRows: number): Flex[] {
  if (phases.length === 0) {
    return [{ type: 'text', text: 'ยังไม่มีแผนงาน', size: 'sm', color: COLOR_MUTED }]
  }
  const span = ganttSpan(phases, today)
  // When capped, the window starts at the first phase not yet done (sliding back so it stays full).
  const firstOpen = phases.findIndex((p) => p.status !== 'done')
  const from = Math.max(0, Math.min(firstOpen === -1 ? phases.length : firstOpen, phases.length - maxRows))
  const shown = phases.slice(from, from + maxRows)
  const hiddenAfter = phases.length - from - shown.length
  const names: Flex[] = shown.map((p) => ({
    type: 'box', layout: 'vertical', height: `${ROW_H}px`, justifyContent: 'center',
    contents: [{ type: 'text', text: cut(p.name || '-', NAME_MAX), size: 'xxs' }],
  }))
  const tracks: Flex[] = shown.map((p) => {
    const r = phaseRange(p)
    if (!r) {
      return {
        type: 'box', layout: 'vertical', height: `${ROW_H}px`, justifyContent: 'center',
        contents: [{ type: 'text', text: 'ยังไม่กำหนดวัน', size: 'xxs', color: COLOR_MUTED }],
      }
    }
    const { offset, width } = barPercents(r[0], r[1], span)
    return {
      type: 'box', layout: 'vertical', height: `${ROW_H}px`,
      contents: [
        {
          type: 'box', layout: 'vertical', position: 'absolute', offsetTop: `${(ROW_H - BAR_H) / 2}px`, offsetStart: `${offset}%`,
          width: `${width}%`, height: `${BAR_H}px`, backgroundColor: barColor(p.status), cornerRadius: '3px', contents: [],
        },
      ],
    }
  })
  const todayPct = Math.min(99, Math.round(((dayNum(today) - span.startDay + 0.5) / span.days) * 100))
  tracks.push({
    type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '0px', offsetStart: `${todayPct}%`,
    width: '2px', height: `${shown.length * ROW_H}px`, backgroundColor: COLOR_TODAY, contents: [],
  })
  const out: Flex[] = [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        { type: 'box', layout: 'vertical', width: NAME_W, flex: 0, contents: [] },
        { type: 'box', layout: 'vertical', flex: 1, height: '14px', contents: monthLabels(span) },
      ],
    },
    ...(from > 0 ? [{ type: 'text', text: `+${from} ก่อนหน้า`, size: 'xxs', color: COLOR_MUTED, margin: 'xs' }] : []),
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        { type: 'box', layout: 'vertical', width: NAME_W, flex: 0, contents: names },
        { type: 'box', layout: 'vertical', flex: 1, contents: tracks },
      ],
    },
  ]
  if (hiddenAfter > 0) {
    out.push({ type: 'text', text: `+${hiddenAfter} ขั้นตอน`, size: 'xxs', color: COLOR_MUTED, margin: 'sm' })
  }
  out.push({ type: 'text', text: 'เส้นแดง = วันนี้ · ฟ้า = กำลังทำ · เขียว = เสร็จ', size: 'xxs', color: '#5C554D', margin: 'md', wrap: true })
  return out
}

function statusBubble(s: SiteStatus, today: string, maxRows: number): Flex {
  const pct = s.pct === null || s.pct === undefined ? '—' : `${Math.round(s.pct)}%`
  const body: Flex[] = gantt(s.phases ?? [], today, maxRows)
  // Ruling 2026-10-20: a passed due date is left out rather than shown as overdue.
  if (s.endDate && s.endDate.slice(0, 10) >= today.slice(0, 10)) {
    body.push({ type: 'separator', margin: 'md' })
    body.push({ ...row('กำหนดส่งมอบ', formatThaiDate(s.endDate)), margin: 'md' })
  }
  const buttons: Flex[] = []
  if (s.hasPhotos) {
    buttons.push({ type: 'button', style: 'secondary', color: COLOR_PRIMARY, height: 'sm', action: { type: 'message', label: 'ดูรูปหน้างาน', text: 'ดูรูปหน้างาน' } })
  }
  buttons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' } })
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COLOR_HEADER, paddingAll: '14px', spacing: 'xs',
      contents: [
        { type: 'text', text: `สถานะงาน · อัปเดต ${formatThaiDate(today)}`, size: 'xxs', color: '#FFFFFFD9' },
        {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'text', text: cut(s.name || '-', SITE_NAME_MAX), size: 'lg', weight: 'bold', color: '#FFFFFF', flex: 1, wrap: true, maxLines: 2 },
            { type: 'text', text: pct, size: 'xl', weight: 'bold', color: '#FFFFFF', flex: 0, align: 'end' },
          ],
        },
      ],
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: buttons },
  }
}

// UTF-16 cut that never leaves half a surrogate pair at the end.
function altText(text: string): string {
  if (text.length <= ALT_TEXT_MAX) return text
  let out = text.slice(0, ALT_TEXT_MAX)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

export function statusFlex(sites: SiteStatus[], today: string, brandName: string): LineMessage {
  const active = sites.filter((s) => s.status === 'Ongoing' || s.status === 'On Hold').slice(0, STATUS_MAX_SITES)
  const text = statusText(sites, today, brandName)
  if (active.length === 0) return { type: 'text', text }
  const bytes = (f: Flex) => new TextEncoder().encode(JSON.stringify(f)).length
  const build = (list: SiteStatus[], rows: number): Flex => ({ type: 'carousel', contents: list.map((s) => statusBubble(s, today, rows)) })
  let rows = MAX_ROWS
  let carousel = build(active, rows)
  while (bytes(carousel) > CAROUSEL_BUDGET && rows > MIN_ROWS) carousel = build(active, --rows)
  let list = active
  while (bytes(carousel) > CAROUSEL_BUDGET && list.length > 1) carousel = build(list = list.slice(0, -1), rows)
  // fallbackText is local only: replyWithFallback sends it as plain text if LINE refuses the card,
  // and it is stripped before anything goes to LINE.
  return { type: 'flex', altText: altText(text), fallbackText: text.slice(0, LINE_TEXT_MAX), contents: carousel }
}

export function noPhotosText(): string {
  return 'ตอนนี้ยังไม่มีรูปหน้างานให้ดูครับ'
}
