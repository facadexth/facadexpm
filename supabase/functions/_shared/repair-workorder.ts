// Pure view model for the repair work order (ใบงานซ่อม). No Deno/supabase imports: shared by the
// web app (vitest + Vite) and the repair-workorder edge function. Input comes from
// loadWorkOrderInput (_shared/repair-workorder-load.ts); output is what the A4 sheet prints.
// All dates are 'YYYY-MM-DD' strings handled with UTC math, so no timezone can shift a day.

import { warrantyStatus } from './warranty.ts'
import { siteMapLink } from './site-map-link.ts'
import { SLOTS, itemsDescription } from './repair-form.ts'
import { formatThaiDate } from './thai-date.ts'

export type WorkOrderInput = {
  tenant: { company_name?: string; address?: string; phone?: string; logo_url?: string | null }
  ticket: {
    ticket_number: string; created_at: string; source: string; description?: string | null
    scheduled_date?: string | null; scheduled_start?: string | null; duration_hours?: number | null
    preferred_days?: string[] | null; preferred_slot?: string | null
  }
  site: {
    name: string; location?: string | null; map_url?: string | null; lat?: number | null; lng?: number | null
    handover_date?: string | null; warranty_months?: number | null
  } | null
  client: { name?: string | null; phone?: string | null } | null
  items: Array<{ id: string; seq: number; location: string; room?: string | null; symptom: string; note?: string | null }>
  media: Array<{ id: string; item_id?: string | null; role: string; media_type: 'image' | 'video'; url: string | null }>
  crew: Array<{ name: string; nickname?: string | null; is_team_leader?: boolean }>
  receipt: { signer_name: string; signed_at: string; signature_url: string | null } | null
  today: string // Bangkok YYYY-MM-DD
}

export type WorkOrderPhoto = { url: string | null; video: boolean }

export type WorkOrder = {
  number: string
  reportedText: string
  company: { name: string; address: string; phone: string; logoUrl: string | null }
  siteName: string
  address: string
  customerText: string
  mapUrl: string | null
  appointmentText: string | null
  crewText: string
  warranty: { kind: 'active' | 'expired' | 'none' | 'not_handed_over'; text: string }
  preferredText: string | null
  customerNote: string | null
  rows: Array<{ no: number; where: string; room: string; symptom: string; note: string; photos: WorkOrderPhoto[] }>
  receipt: WorkOrderInput['receipt']
}

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤหัส', 'ศ', 'ส']
const NOTE_PREFIX = 'หมายเหตุ: '
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// 'YYYY-MM-DD' -> short Thai weekday ('พฤหัส' for Thursday). '' when not a date.
export function thaiWeekday(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  if (!m) return ''
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(t) ? WEEKDAYS[new Date(t).getUTCDay()] : ''
}

// Bangkok calendar day of an ISO timestamp; null when it cannot be parsed.
function bangkokDate(iso: string | null | undefined): string | null {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) ? new Date(t + BKK_OFFSET_MS).toISOString().slice(0, 10) : null
}

// 'HH:MM:SS' | 'HH:MM' -> 'HH:MM'; '' otherwise.
function hhmm(s: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(str(s))
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
}

function appointmentText(t: WorkOrderInput['ticket']): string | null {
  if (!t.scheduled_date) return null
  const parts = [`${thaiWeekday(t.scheduled_date)} ${formatThaiDate(t.scheduled_date)}`.trim()]
  const time = hhmm(t.scheduled_start)
  if (time) parts.push(time)
  const h = Number(t.duration_hours)
  if (t.duration_hours != null && Number.isFinite(h) && h > 0) parts.push(`ประมาณ ${h} ชม.`)
  return parts.join(' · ')
}

function customerText(c: WorkOrderInput['client']): string {
  const name = str(c?.name)
  const phone = str(c?.phone)
  const parts: string[] = []
  if (name) parts.push(name.startsWith('คุณ') ? name : `คุณ${name}`)
  if (phone) parts.push(phone)
  return parts.length ? parts.join(' · ') : '-'
}

function crewText(crew: WorkOrderInput['crew']): string {
  const list = (crew || []).filter((c) => str(c?.name))
  if (!list.length) return '-'
  const leaders = list.filter((c) => c.is_team_leader)
  const others = list.filter((c) => !c.is_team_leader)
  return [...leaders, ...others].map((c) => {
    const nick = str(c.nickname)
    let s = nick ? `${str(c.name)} (${nick})` : str(c.name)
    if (c.is_team_leader) s += ' (หัวหน้าทีม)'
    return s
  }).join(', ')
}

function warranty(site: WorkOrderInput['site'], today: string): WorkOrder['warranty'] {
  const s = warrantyStatus(site?.handover_date ?? null, Number(site?.warranty_months) || 0, today)
  switch (s.kind) {
    case 'active': return { kind: 'active', text: `✓ อยู่ในประกัน ถึง ${formatThaiDate(s.end)} · ไม่เก็บเงิน` }
    case 'expired': return { kind: 'expired', text: `⚠️ นอกประกัน (หมด ${formatThaiDate(s.end)}) · ต้องมีใบเสนอราคาก่อน` }
    case 'none': return { kind: 'none', text: 'ไม่มีประกัน' }
    default: return { kind: 'not_handed_over', text: 'ยังไม่ส่งมอบงาน' }
  }
}

function preferredText(t: WorkOrderInput['ticket']): string | null {
  const days = (t.preferred_days || []).filter((d) => typeof d === 'string' && d)
  if (!days.length) return null
  let s = `ลูกค้าสะดวก: ${days.map(formatThaiDate).join(', ')}`
  const slot = t.preferred_slot && Object.prototype.hasOwnProperty.call(SLOTS, t.preferred_slot)
    ? (SLOTS as Record<string, string>)[t.preferred_slot] : ''
  if (slot) s += ` · ${slot}`
  return s
}

// The general note the form appends as '\nหมายเหตุ: <text>' after itemsDescription(items).
// Prefer stripping the exact rebuilt items text (so an item note containing a 'หมายเหตุ: ' line is
// not mistaken for it); otherwise take everything after the first line starting with 'หมายเหตุ: '.
function customerNote(description: string | null | undefined, items: WorkOrderInput['items']): string | null {
  const desc = typeof description === 'string' ? description : ''
  if (!desc) return null
  let tail: string | null = null
  const rebuilt = itemsDescription(items.map((it) => ({
    location: it.location, room: it.room ?? undefined, symptom: it.symptom, note: it.note ?? undefined, files: [],
  })))
  if (desc.startsWith(rebuilt)) {
    const rest = desc.slice(rebuilt.length)
    if (rest.startsWith('\n' + NOTE_PREFIX)) tail = rest.slice(1 + NOTE_PREFIX.length)
  } else {
    const lines = desc.split('\n')
    const i = lines.findIndex((l) => l.startsWith(NOTE_PREFIX))
    if (i >= 0) tail = [lines[i].slice(NOTE_PREFIX.length), ...lines.slice(i + 1)].join('\n')
  }
  const note = tail?.trim() ?? ''
  return note || null
}

const photo = (m: WorkOrderInput['media'][number]): WorkOrderPhoto => ({ url: m.url ?? null, video: m.media_type === 'video' })

export function buildWorkOrder(input: WorkOrderInput): WorkOrder {
  const { tenant, ticket, site } = input
  const items = [...(input.items || [])].sort((a, b) => a.seq - b.seq)
  const customerMedia = (input.media || []).filter((m) => m.role === 'customer')

  const rows: WorkOrder['rows'] = items.length
    ? items.map((it, i) => ({
      no: i + 1,
      where: str(it.location),
      room: str(it.room),
      symptom: str(it.symptom),
      note: str(it.note),
      photos: customerMedia.filter((m) => m.item_id === it.id).map(photo),
    }))
    : [{ no: 1, where: 'ตามที่ลูกค้าแจ้ง', room: '', symptom: '', note: str(ticket.description), photos: customerMedia.map(photo) }]

  const reported = formatThaiDate(bangkokDate(ticket.created_at))

  return {
    number: ticket.ticket_number,
    reportedText: `${ticket.source === 'line' ? 'แจ้งทาง LINE' : 'แจ้งโดยทีมงาน'} ${reported}`,
    company: {
      name: str(tenant?.company_name),
      address: str(tenant?.address),
      phone: str(tenant?.phone),
      logoUrl: str(tenant?.logo_url) || null,
    },
    siteName: str(site?.name) || '-',
    address: str(site?.location) || '-',
    customerText: customerText(input.client),
    mapUrl: siteMapLink(site),
    appointmentText: appointmentText(ticket),
    crewText: crewText(input.crew),
    warranty: warranty(site, input.today),
    preferredText: preferredText(ticket),
    customerNote: items.length ? customerNote(ticket.description, items) : null,
    rows,
    receipt: input.receipt ?? null,
  }
}
