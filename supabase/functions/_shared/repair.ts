// Pure repair-ticket texts, LINE Flex cards and status rules. No Deno or supabase imports:
// this file is also imported by vitest from src/lib.

import { warrantyStatus, warrantyEnd } from './warranty.ts'
import { formatThaiDate } from './thai-date.ts'
import type { LineMessage } from './line-reply.ts'
import { row, dayNum, ALT_TEXT_MAX, COLOR_PRIMARY, COLOR_ACTIVE as COLOR_GREEN, COLOR_PENDING as COLOR_AMBER } from './customer-line-replies.ts'
import type { Flex } from './customer-line-replies.ts'

export type RepairStatus = 'pending_review' | 'received' | 'scheduled' | 'in_progress' | 'done' | 'declined'

export const REPAIR_STATUS: Record<RepairStatus, string> = {
  pending_review: 'รอพิจารณา',
  received: 'รับเรื่อง',
  scheduled: 'นัดเข้า',
  in_progress: 'กำลังซ่อม',
  done: 'เสร็จ',
  declined: 'ไม่รับ',
}

export const REPAIR_STEPS = ['received', 'scheduled', 'in_progress', 'done'] as const

const MOVES: Record<RepairStatus, RepairStatus[]> = {
  pending_review: ['received', 'declined'],
  received: ['scheduled', 'declined'],
  scheduled: ['in_progress', 'received'],
  in_progress: ['done', 'scheduled'],
  done: ['in_progress'],
  declined: [],
}

export function canMove(from: string, to: string): boolean {
  const list = (MOVES as Record<string, string[]>)[from]
  return Array.isArray(list) && list.includes(to)
}

// Index of the last filled step; -1 (nothing filled) for pending_review and declined.
export function stepIndex(status: string): number {
  return (REPAIR_STEPS as readonly string[]).indexOf(status)
}

export function mediaTooBig(bytes: number): boolean {
  return bytes > 50 * 1024 * 1024
}

// LINE answers 202 on GET .../content while a video is still being prepared. The webhook runs inside
// EdgeRuntime.waitUntil (R13), so it can wait: retry a 202 up to CONTENT_RETRY_MAX times, 5 s apart (~30 s).
export const CONTENT_RETRY_MAX = 6
export const CONTENT_RETRY_DELAY_MS = 5000

// attempt = how many fetches were made so far (1 after the first). Returns ms to wait, or null = stop.
export function contentRetryDelay(attempt: number, status: number): number | null {
  if (status !== 202) return null
  return attempt <= CONTENT_RETRY_MAX ? CONTENT_RETRY_DELAY_MS : null
}

export type RepairTicket = {
  ticket_number: string
  site_name: string
  status: RepairStatus | string
  description?: string | null
  fix_note?: string | null
  scheduled_date?: string | null // YYYY-MM-DD
  scheduled_start?: string | null // HH:MM or HH:MM:SS
  duration_hours?: number | null
  created_at?: string | null
  done_at?: string | null
  handover_date?: string | null
  warranty_months?: number | null
}

export type MediaCounts = { text?: number; image?: number; video?: number; file?: number }

// ---- Date helpers (UTC math on 'YYYY-MM-DD' strings, never local time) ----

const WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']

export function thaiWeekday(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? ''
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function startTime(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''))
  return m ? `${pad2(Number(m[1]))}:${m[2]}` : ''
}

// start + duration hours, HH:MM. Clamped to 23:59 if it would pass midnight.
export function endTime(start: string | null | undefined, hours: number | null | undefined): string {
  const s = startTime(start)
  if (!s) return ''
  const [h, mi] = s.split(':').map(Number)
  const total = h * 60 + mi + Math.round((Number(hours) || 0) * 60)
  const t = Math.min(total, 23 * 60 + 59)
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`
}

function fmtHours(h: number | null | undefined): string {
  const n = Number(h)
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : ''
}

// ---- Plain texts ----

export function repairStartText(siteName: string): string {
  return `แจ้งปัญหาของงาน ${siteName} ได้เลยครับ 🙏\nพิมพ์อาการ และส่งรูป / วิดีโอ / PDF ได้หลายอย่าง\nส่งครบแล้วกด "ส่งครบแล้ว" (หรือรอ 30 นาที ระบบจะรวมให้เอง)`
}

export function repairPickSiteText(): string {
  return 'แจ้งซ่อมงานไหนครับ?'
}

export function repairReceivedText(ticketNumber: string, siteName: string, counts: MediaCounts): string {
  const parts = [siteName]
  if (counts.text) parts.push(`ข้อความ ${counts.text}`)
  if (counts.image) parts.push(`รูป ${counts.image}`)
  if (counts.video) parts.push(`วิดีโอ ${counts.video}`)
  if (counts.file) parts.push(`PDF ${counts.file}`)
  return `รับเรื่องแล้วครับ เลขที่ ${ticketNumber}\n${parts.join(' · ')}\nเจ้าหน้าที่จะตรวจสอบและแจ้งนัดหมายกลับในแชทนี้\nติดตามได้ที่ "สถานะแจ้งซ่อม"`
}

// Ack while a report is open: LINE hides quick replies once the customer sends anything, so this carries them again.
export function repairGotItText(): string {
  return 'ได้รับแล้ว ✓ ส่งเพิ่มได้อีก หรือกด "ส่งครบแล้ว" เมื่อครบ'
}

export function repairCancelledText(): string {
  return 'ยกเลิกการแจ้งซ่อมแล้วครับ'
}

export function repairTooBigText(): string {
  return 'ไฟล์ใหญ่เกินไป ส่งทางแชทให้เจ้าหน้าที่แทนได้ครับ'
}

export function repairNoTicketsText(): string {
  return 'ยังไม่มีรายการแจ้งซ่อมครับ หากพบปัญหา กด "แจ้งซ่อม" ได้ตลอด'
}

function timeRange(t: RepairTicket): string {
  const st = startTime(t.scheduled_start)
  if (!st) return ''
  const en = Number(t.duration_hours) > 0 ? endTime(t.scheduled_start, t.duration_hours) : ''
  return en && en !== st ? `${st}–${en}` : st
}

function durationNote(t: RepairTicket): string {
  return startTime(t.scheduled_start) && Number(t.duration_hours) > 0 ? ` (ประมาณ ${fmtHours(t.duration_hours)} ชม.)` : ''
}

export function scheduleText(t: RepairTicket): string {
  const d = String(t.scheduled_date ?? '')
  const when = [thaiWeekday(d), formatThaiDate(d), timeRange(t)].filter(Boolean).join(' ')
  return `📅 นัดเข้าซ่อม ${t.ticket_number}\n${t.site_name}\n${when}${durationNote(t)}\nหากไม่สะดวก ตอบกลับในแชทนี้ได้เลยครับ`
}

export function reminderText(t: RepairTicket): string {
  const d = String(t.scheduled_date ?? '')
  const range = timeRange(t)
  return `🔔 พรุ่งนี้ ทีมช่างจะเข้าซ่อมที่ ${t.site_name}\n${thaiWeekday(d)} ${formatThaiDate(d)}${range ? ` · ${range}` : ''}\nรบกวนเตรียมพื้นที่หน้างานให้ด้วยนะครับ 🙏`
}

// ---- Flex ----
// Same style as warrantyFlex in customer-line-replies.ts; helpers and colours are imported from there.

const MAX_BUBBLES = 10
const DONE_WINDOW_DAYS = 30
const COLOR_BEFORE = '#B04A38'
const COLOR_DOT_ON = '#2B6CB0'
const COLOR_DOT_OFF = '#DDDDDD'
const HEADER_COLOR: Record<string, string> = {
  pending_review: COLOR_AMBER,
  received: COLOR_AMBER,
  scheduled: '#2B6CB0',
  in_progress: '#6B46C1',
  done: '#2F6B3F',
}

function altOf(text: string): string {
  return text.slice(0, ALT_TEXT_MAX)
}

// ISO timestamp -> Bangkok 'YYYY-MM-DD'.
function bangkokDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10)
}

function stepper(idx: number): Flex {
  const parts: Flex[] = []
  REPAIR_STEPS.forEach((_, i) => {
    if (i > 0) {
      parts.push({
        type: 'box', layout: 'vertical', flex: 1, height: '2px', margin: 'none',
        backgroundColor: i <= idx ? COLOR_DOT_ON : COLOR_DOT_OFF, contents: [],
      })
    }
    parts.push({
      type: 'box', layout: 'vertical', width: '12px', height: '12px', cornerRadius: '6px',
      backgroundColor: i <= idx ? COLOR_DOT_ON : COLOR_DOT_OFF, contents: [],
    })
  })
  const labels = REPAIR_STEPS.map((s, i) => ({
    type: 'text', text: REPAIR_STATUS[s], size: 'xxs', flex: 1,
    align: i === 0 ? 'start' : i === REPAIR_STEPS.length - 1 ? 'end' : 'center',
    color: i <= idx ? COLOR_DOT_ON : '#8A847C',
  }))
  return {
    type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md',
    contents: [
      { type: 'box', layout: 'horizontal', alignItems: 'center', contents: parts },
      { type: 'box', layout: 'horizontal', contents: labels },
    ],
  }
}

function statusLabel(status: string): string {
  return status === 'pending_review' ? 'รอเจ้าหน้าที่ตรวจสอบ' : (REPAIR_STATUS as Record<string, string>)[status] ?? status
}

function statusBubble(t: RepairTicket, today: string): Flex {
  const body: Flex[] = [
    { type: 'text', text: t.site_name || '-', size: 'md', weight: 'bold', wrap: true },
    stepper(stepIndex(String(t.status))),
  ]
  if (t.status === 'scheduled' && t.scheduled_date) {
    body.push({
      type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', paddingAll: '10px',
      backgroundColor: '#EBF4FF', cornerRadius: '8px',
      contents: [
        { type: 'text', text: '📅 นัดเข้าซ่อม', size: 'xs', color: '#2B6CB0', weight: 'bold' },
        { type: 'text', text: `${thaiWeekday(t.scheduled_date)} ${formatThaiDate(t.scheduled_date)}`, size: 'sm', weight: 'bold', wrap: true },
        ...(timeRange(t)
          ? [{ type: 'text', text: `${timeRange(t)}${durationNote(t)}`, size: 'sm', color: '#5C554D', wrap: true }]
          : []),
      ],
    })
  }
  const w = warrantyStatus(t.handover_date, Number(t.warranty_months) || 0, today)
  if (w.kind === 'active' || w.kind === 'expired') {
    body.push({ type: 'separator', margin: 'md' })
    body.push({
      type: 'text', size: 'sm', wrap: true, weight: 'bold',
      text: w.kind === 'active' ? 'อยู่ในประกัน · ไม่มีค่าใช้จ่าย' : 'นอกระยะประกัน · เจ้าหน้าที่จะแจ้งค่าใช้จ่าย',
      color: w.kind === 'active' ? COLOR_GREEN : COLOR_AMBER,
    })
  }
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: HEADER_COLOR[String(t.status)] ?? '#6B6660', paddingAll: '16px', spacing: 'xs',
      contents: [
        { type: 'text', text: t.ticket_number || '-', size: 'xs', color: '#FFFFFFCC' },
        { type: 'text', text: statusLabel(String(t.status)), size: 'lg', weight: 'bold', color: '#FFFFFF' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px', contents: body },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        { type: 'button', style: 'secondary', color: COLOR_PRIMARY, height: 'sm', action: { type: 'message', label: 'ติดต่อ / ขอเลื่อนนัด', text: 'ติดต่อเรา' } },
      ],
    },
  }
}

function countChip(icon: string, label: string): Flex {
  return {
    type: 'box', layout: 'vertical', flex: 1, alignItems: 'center', spacing: 'xs', paddingAll: '8px',
    backgroundColor: '#F5F2EE', cornerRadius: '8px',
    contents: [
      { type: 'text', text: icon, size: 'lg', align: 'center' },
      { type: 'text', text: label, size: 'xs', color: '#5C554D', align: 'center' },
    ],
  }
}

// "ส่งครบแล้ว" confirmation card. altText is the plain-text version, which is also the reply fallback.
export function repairReceivedFlex(ticketNumber: string, siteName: string, counts: MediaCounts): LineMessage {
  const chips: Flex[] = []
  if (counts.text) chips.push(countChip('📝', `ข้อความ ${counts.text}`))
  if (counts.image) chips.push(countChip('🖼️', `รูป ${counts.image}`))
  if (counts.video) chips.push(countChip('🎬', `วิดีโอ ${counts.video}`))
  if (counts.file) chips.push(countChip('📄', `ไฟล์ ${counts.file}`))
  return {
    type: 'flex',
    altText: altOf(repairReceivedText(ticketNumber, siteName, counts)),
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: COLOR_GREEN, paddingAll: '16px', spacing: 'xs',
        contents: [
          { type: 'text', text: ticketNumber || '-', size: 'xs', color: '#FFFFFFCC' },
          { type: 'text', text: 'ได้รับแจ้งซ่อมแล้ว ✓', size: 'lg', weight: 'bold', color: '#FFFFFF' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'text', text: siteName || '-', size: 'md', weight: 'bold', wrap: true },
          chips.length > 0
            ? { type: 'box', layout: 'horizontal', spacing: 'sm', contents: chips }
            : { type: 'text', text: 'ไม่มีไฟล์แนบ', size: 'sm', color: '#8A847C' },
          stepper(-1),
          {
            type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '10px', backgroundColor: '#FFF7E6', cornerRadius: '8px',
            contents: [
              { type: 'text', text: 'รอเจ้าหน้าที่ตรวจสอบ', size: 'sm', weight: 'bold', color: COLOR_AMBER },
              { type: 'text', text: 'เจ้าหน้าที่จะแจ้งนัดหมายกลับในแชทนี้', size: 'xs', color: '#5C554D', wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'secondary', color: COLOR_PRIMARY, height: 'sm', action: { type: 'message', label: 'ดูสถานะแจ้งซ่อม', text: 'สถานะแจ้งซ่อม' } },
        ],
      },
    },
  }
}

const OPEN = ['pending_review', 'received', 'scheduled', 'in_progress']

export function repairStatusFlex(tickets: RepairTicket[], today: string): LineMessage {
  const key = (t: RepairTicket) => String(t.scheduled_date ?? t.created_at ?? '')
  const open = tickets.filter((t) => OPEN.includes(String(t.status))).sort((a, b) => key(a).localeCompare(key(b)))
  const cutoff = dayNum(today) - DONE_WINDOW_DAYS
  const done = tickets
    .filter((t) => {
      if (t.status !== 'done') return false
      const d = bangkokDate(t.done_at)
      return d !== '' && dayNum(d) >= cutoff
    })
    .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)))
  const shown = [...open, ...done].slice(0, MAX_BUBBLES)
  if (shown.length === 0) return { type: 'text', text: repairNoTicketsText() }
  const summary = shown.map((t) => `${t.ticket_number} ${t.site_name} · ${statusLabel(String(t.status))}`).join('\n')
  return {
    type: 'flex',
    altText: altOf(`สถานะแจ้งซ่อม\n${summary}`),
    contents: { type: 'carousel', contents: shown.map((t) => statusBubble(t, today)) },
  }
}

function imageCol(url: string, label: string, color: string): Flex {
  return {
    type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
    contents: [
      { type: 'image', url, aspectMode: 'cover', aspectRatio: '1:1', size: 'full' },
      { type: 'text', text: label, size: 'xs', weight: 'bold', color, align: 'center' },
    ],
  }
}

export function repairReportFlex(
  t: RepairTicket,
  beforeUrls: string[],
  afterUrls: string[],
  warrantyEndDate: string | null | undefined,
): LineMessage {
  const body: Flex[] = [
    { type: 'text', text: `${t.site_name || '-'} · ${t.ticket_number || '-'}`, size: 'md', weight: 'bold', wrap: true },
  ]
  if (t.description) body.push(row('ปัญหา', t.description))
  if (t.fix_note) body.push(row('แก้ไข', t.fix_note))
  const cols: Flex[] = []
  if (beforeUrls[0]) cols.push(imageCol(beforeUrls[0], 'ก่อน', COLOR_BEFORE))
  if (afterUrls[0]) cols.push(imageCol(afterUrls[0], 'หลัง', COLOR_GREEN))
  if (cols.length > 0) body.push({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md', contents: cols })
  const doneDate = bangkokDate(t.done_at)
  if (doneDate) body.push(row('วันที่ซ่อม', formatThaiDate(doneDate)))
  if (warrantyEndDate) body.push(row('ประกันยังเหลือถึง', formatThaiDate(warrantyEndDate)))
  const alt = [`ซ่อมเสร็จเรียบร้อย ✓ ${t.ticket_number}`, t.site_name, t.fix_note].filter(Boolean).join('\n')
  return {
    type: 'flex',
    altText: altOf(alt),
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: COLOR_GREEN, paddingAll: '16px', spacing: 'xs',
        contents: [{ type: 'text', text: 'ซ่อมเสร็จเรียบร้อย ✓', size: 'lg', weight: 'bold', color: '#FFFFFF' }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px', contents: body },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'secondary', color: COLOR_PRIMARY, height: 'sm', action: { type: 'message', label: 'ยังพบปัญหา? แจ้งซ่อม', text: 'แจ้งซ่อม' } },
        ],
      },
    },
  }
}

// Convenience for callers that only have handover + months.
export function repairWarrantyEnd(handoverDate: string | null | undefined, months: number | null | undefined): string | null {
  return warrantyEnd(handoverDate, Number(months) || 0)
}

// ---- Media storage helpers (used by customer-line-webhook) ----

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
}

// File extension for a stored repair media object. Files use their own name's extension
// (1-8 letters/digits, lowercased); otherwise the mime type decides; 'bin' if unknown.
export function repairMediaExt(mime: string | null | undefined, fileName?: string | null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName ?? ''))
  if (m) return m[1].toLowerCase()
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? 'bin'
}

// repair-media/{tenant}/{ticket}/{messageId}.{ext}. Deterministic, so a redelivered LINE event hits the
// same object (upload conflict) instead of making a duplicate. The first folder must be the tenant id
// (storage policy). The message id is reduced to letters/digits so it can never add a folder or a LIKE wildcard.
export function repairMediaPath(tenantId: string, ticketId: string, messageId: string, ext: string): string {
  const id = String(messageId).replace(/[^A-Za-z0-9]/g, '')
  return `${tenantId}/${ticketId}/${id}.${ext}`
}

// Content-type stored on the object: only image/*, video/* and PDF are trusted; anything else
// (text/html, svg, ...) is stored as a plain download.
export function repairUploadMime(mime: string | null | undefined): string {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase()
  if (base === 'image/svg+xml') return 'application/octet-stream'
  if (/^(image|video)\/[a-z0-9.+-]+$/.test(base) || base === 'application/pdf') return base
  return 'application/octet-stream'
}

// LINE quick-reply labels allow at most 20 characters (counted as UTF-16 units to be safe).
// Cuts on code-point boundaries so a surrogate pair is never split.
export function quickReplyLabel(s: string): string {
  let out = ''
  for (const ch of String(s ?? '')) {
    if (out.length + ch.length > 20) break
    out += ch
  }
  return out.trim() || '-'
}
