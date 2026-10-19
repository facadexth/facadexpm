// Pure reply texts for the customer LINE bot. No Deno or supabase imports:
// this file is also imported by vitest from src/lib.

import { warrantyStatus } from './warranty.ts'
import { formatThaiDate } from './thai-date.ts'
import type { LineMessage } from './line-reply.ts'

export type SiteStatus = {
  name: string
  status: 'Ongoing' | 'On Hold' | 'Completed' | 'Cancelled'
  pct: number | null
  phases: string[]
  endDate: string | null // YYYY-MM-DD
  handoverDate: string | null // YYYY-MM-DD
  warrantyMonths: number
}

// Shared by statusText and warrantyText.
const STATUS_MAX_SITES = 10
// LINE's text message limit is 5,000 characters; keep a margin.
const STATUS_MAX_CHARS = 4900
const CONTACT_FOOTER = 'หรือพิมพ์ในแชทนี้ได้เลย เจ้าหน้าที่จะตอบในเวลาทำการ'

export function inviteOkText(clientName: string): string {
  return `เชื่อมกับ ${clientName} เรียบร้อยครับ\nกดเมนู "สถานะงาน" เพื่อดูความคืบหน้าได้ตลอด`
}

export function inviteInvalidText(): string {
  return 'รหัสนี้ใช้ไม่ได้หรือหมดอายุแล้ว กรุณาขอรหัสใหม่จากบริษัท'
}

export function notLinkedText(brandName: string): string {
  const head = brandName ? `สวัสดีครับ ขอบคุณที่เพิ่มเพื่อน ${brandName} 🙏` : 'สวัสดีครับ ขอบคุณที่เพิ่มเพื่อน 🙏'
  return `${head}\n• เป็นลูกค้าของเราอยู่แล้ว: ส่งรหัสเชิญ 6 ตัวที่ได้จากเจ้าหน้าที่ เพื่อติดตามงานและประกันได้ทุกเมื่อ\n• สนใจงานหน้าต่าง ประตู กระจก อลูมิเนียม: กด "ขอใบเสนอราคา" ได้เลยครับ`
}

export function quoteText(): string {
  return 'ขอบคุณที่สนใจครับ\nส่งแบบหรือรูปหน้างาน ขนาดคร่าวๆ ที่ตั้งหน้างาน และเบอร์โทรมาในแชทนี้ได้เลย\nเจ้าหน้าที่จะติดต่อกลับโดยเร็ว'
}

export function repairTempText(): string {
  return 'พิมพ์อาการและส่งรูปมาในแชทนี้ได้เลยครับ\nเจ้าหน้าที่จะรับเรื่องและติดต่อกลับ'
}

export function repairStatusTempText(): string {
  return 'ยังไม่มีรายการแจ้งซ่อมในระบบ\nถ้าแจ้งไว้ทางแชท เจ้าหน้าที่จะตอบในแชทนี้'
}

export function warrantyText(sites: SiteStatus[], today: string): string {
  const lines = sites
    .filter((s) => s.status !== 'Cancelled')
    .slice(0, STATUS_MAX_SITES)
    .map((s) => {
      const months = Number(s.warrantyMonths)
      // 0 months wins over a missing handover date.
      if (!(months > 0)) return `${s.name}: ไม่มีระยะประกัน`
      // A site that is not Completed has not been handed over (or was reopened), even if a
      // handover date is still stored.
      if (s.status !== 'Completed') return `${s.name}: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ`
      const w = warrantyStatus(s.handoverDate, months, today)
      if (w.kind === 'not_handed_over') return `${s.name}: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ`
      if (w.kind === 'active') return `${s.name}: ในประกัน ถึง ${formatThaiDate(w.end)}`
      return `${s.name}: หมดประกันแล้ว (${formatThaiDate(w.end)})`
    })
  if (lines.length === 0) return 'ยังไม่มีงานในระบบ'
  const text = lines.join('\n')
  return text.length > STATUS_MAX_CHARS ? text.slice(0, STATUS_MAX_CHARS) : text
}

export function contactText(opts: { companyName: string; phone: string | null; hours: string | null }): string {
  const lines = [opts.companyName]
  if (opts.phone) lines.push(`โทร ${opts.phone}`)
  if (opts.hours) lines.push(`เวลาทำการ ${opts.hours}`)
  lines.push(CONTACT_FOOTER)
  return lines.join('\n')
}

function siteBlock(s: SiteStatus): string {
  const lines = [s.name]
  if (s.pct !== null) {
    lines.push(`ความคืบหน้ารวม ${Math.round(s.pct)}%`)
  } else {
    lines.push('ยังไม่มีข้อมูลความคืบหน้า')
  }
  if (s.phases.length > 0) lines.push(`กำลังทำ: ${s.phases.join(', ')}`)
  if (s.endDate) lines.push(`กำหนดเสร็จ: ${formatThaiDate(s.endDate)}`)
  return lines.join('\n')
}

export function statusText(sites: SiteStatus[], today: string, brandName: string): string {
  const active = sites
    .filter((s) => s.status === 'Ongoing' || s.status === 'On Hold')
    .slice(0, STATUS_MAX_SITES)
  if (active.length === 0) {
    const head = brandName ? `ขอบคุณที่ไว้วางใจ ${brandName} ครับ 🙏` : 'ขอบคุณที่ไว้วางใจครับ 🙏'
    return `${head}\nตอนนี้ยังไม่มีงานที่อยู่ระหว่างดำเนินการ\n• งานที่ส่งมอบแล้ว กด "ประกันของฉัน" เพื่อดูระยะประกันได้เลย\n• มีโครงการใหม่ กด "ขอใบเสนอราคา" ยินดีดูแลให้ครับ`
  }
  const header = `สถานะงาน · อัปเดต ${formatThaiDate(today)}`
  const text = [header, ...active.map(siteBlock)].join('\n\n')
  return text.length > STATUS_MAX_CHARS ? text.slice(0, STATUS_MAX_CHARS) : text
}

// ---- Flex carousel for "ประกันของฉัน" ----

export const ALT_TEXT_MAX = 400
export const COLOR_ACTIVE = '#2F6B3F'
const COLOR_GREY = '#6B6660'
export const COLOR_PENDING = '#B7791F'
const COLOR_TRACK = '#EFEAE3'
export const COLOR_PRIMARY = '#D4B596'

export type Flex = Record<string, unknown>

export function dayNum(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86400000)
}

export function row(label: string, value: string): Flex {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8A847C', flex: 2 },
      { type: 'text', text: value, size: 'sm', color: '#2B2723', flex: 3, wrap: true },
    ],
  }
}

function warrantyBubble(s: SiteStatus, today: string): Flex {
  const months = Number(s.warrantyMonths)
  let color = COLOR_GREY
  let label = 'ไม่มีระยะประกัน'
  let closing = 'สอบถามรายละเอียดได้ที่แชทนี้ครับ'
  let handover: string | null = null
  let end: string | null = null
  let progress: Flex[] = []

  if (months > 0) {
    const w = s.status === 'Completed' ? warrantyStatus(s.handoverDate, months, today) : null
    if (!w || w.kind === 'not_handed_over' || w.kind === 'none') {
      color = COLOR_PENDING
      label = 'ยังไม่ส่งมอบงาน'
      closing = 'ประกันเริ่มนับจากวันส่งมอบงานครับ'
    } else {
      handover = s.handoverDate
      end = w.end
      if (w.kind === 'active') {
        color = COLOR_ACTIVE
        label = 'อยู่ในประกัน'
        closing = 'หากพบปัญหาในระยะประกัน แจ้งเราได้ทันที ทีมงานพร้อมดูแลครับ'
        const daysLeft = w.daysLeft as number
        const total = Math.max(1, dayNum(w.end as string) - dayNum(s.handoverDate as string))
        const used = Math.min(total, Math.max(0, total - daysLeft))
        const pct = Math.min(100, Math.max(2, Math.round((used / total) * 100)))
        const left = daysLeft < 60 ? `เหลืออีก ${daysLeft} วัน` : `เหลือประมาณ ${Math.round(daysLeft / 30.4)} เดือน`
        progress = [
          {
            type: 'box', layout: 'horizontal', height: '8px', backgroundColor: COLOR_TRACK, cornerRadius: '4px', margin: 'md',
            contents: [{ type: 'box', layout: 'vertical', width: `${pct}%`, height: '8px', backgroundColor: COLOR_ACTIVE, cornerRadius: '4px', contents: [{ type: 'filler' }] }],
          },
          {
            type: 'box', layout: 'horizontal', margin: 'sm',
            contents: [
              { type: 'text', text: `ใช้ไป ${used} วัน`, size: 'xs', color: '#8A847C', flex: 1 },
              { type: 'text', text: left, size: 'xs', color: COLOR_ACTIVE, weight: 'bold', align: 'end', flex: 1 },
            ],
          },
        ]
      } else {
        label = 'หมดประกันแล้ว'
        closing = 'ยังดูแลได้เสมอ แจ้งซ่อมเพื่อให้ทีมงานประเมินและเสนอราคาครับ'
      }
    }
  }

  const rows: Flex[] = []
  if (handover) rows.push(row('ส่งมอบงาน', formatThaiDate(handover)))
  if (end) rows.push(row('ประกันถึง', formatThaiDate(end)))

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '16px', spacing: 'xs',
      contents: [
        { type: 'text', text: 'การรับประกันผลงาน', size: 'xs', color: '#FFFFFFCC' },
        { type: 'text', text: label, size: 'lg', weight: 'bold', color: '#FFFFFF' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
      contents: [
        { type: 'text', text: s.name || '-', size: 'md', weight: 'bold', wrap: true },
        ...rows,
        ...progress,
        { type: 'separator', margin: 'md' },
        { type: 'text', text: closing, size: 'sm', color: '#5C554D', wrap: true },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        { type: 'button', style: 'secondary', color: COLOR_PRIMARY, height: 'sm', action: { type: 'message', label: 'แจ้งซ่อม', text: 'แจ้งซ่อม' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' } },
      ],
    },
  }
}

// `brandName` is reserved for the card's wording; the approved card copy does not use it yet.
export function warrantyFlex(sites: SiteStatus[], today: string, _brandName: string): LineMessage {
  const shown = sites.filter((s) => s.status !== 'Cancelled').slice(0, STATUS_MAX_SITES)
  if (shown.length === 0) return { type: 'text', text: 'ยังไม่มีงานในระบบ' }
  return {
    type: 'flex',
    altText: Array.from(warrantyText(sites, today)).slice(0, ALT_TEXT_MAX).join(''),
    contents: { type: 'carousel', contents: shown.map((s) => warrantyBubble(s, today)) },
  }
}
