// Pure reply texts for the customer LINE bot. No Deno or supabase imports:
// this file is also imported by vitest from src/lib.

import { warrantyStatus } from './warranty.ts'
import { formatThaiDate } from './thai-date.ts'

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

export function notLinkedText(): string {
  return 'ยังไม่มีงานที่เชื่อมกับไลน์นี้\nถ้าเป็นลูกค้าอยู่แล้ว ส่งรหัสเชิญ 6 ตัวที่ได้จากบริษัทมาได้เลย\nถ้าสนใจทำงานใหม่ กด "ขอใบเสนอราคา"'
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

export function statusText(sites: SiteStatus[], today: string): string {
  const active = sites
    .filter((s) => s.status === 'Ongoing' || s.status === 'On Hold')
    .slice(0, STATUS_MAX_SITES)
  if (active.length === 0) return 'ยังไม่มีงานที่กำลังดำเนินการ'
  const header = `สถานะงาน · อัปเดต ${formatThaiDate(today)}`
  const text = [header, ...active.map(siteBlock)].join('\n\n')
  return text.length > STATUS_MAX_CHARS ? text.slice(0, STATUS_MAX_CHARS) : text
}
