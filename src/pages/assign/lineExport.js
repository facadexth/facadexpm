// ============================================================
// lineExport — format the Assign roster (day or week) as plain
// text for copying into a LINE group manually. Stopgap ahead of
// the automated Calendar/LINE sync (docs/superpowers/plans/2026-07-03-calendar-line-sync.md).
// ============================================================
import { fmtDate } from '../../lib/supabase.js'
import { SITE_TYPES } from './constants.js'

const DOW_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', holiday: 'หยุด' }

function workerLabel(a) {
  const name = a.workers?.nickname || a.workers?.name || '—'
  const extras = []
  if (a.ot_hours > 0) extras.push(`OT ${a.ot_hours}ชม.`)
  if (a.notes) extras.push(a.notes)
  return extras.length ? `${name} (${extras.join(', ')})` : name
}

function otLabel(o) {
  const name = o.workers?.nickname || o.workers?.name || '—'
  return `${name} (${o.start_time?.slice(0, 5)}-${o.end_time?.slice(0, 5)})`
}

function formatDayBlock(dateIso, dayAssignments, dayOT, siteMeta) {
  const dow = DOW_TH[new Date(dateIso).getDay()]
  const header = `📅 ${fmtDate(dateIso)} (${dow})`

  const bySite = {}
  const others = []
  dayAssignments.forEach(a => {
    if (a.site_id && (SITE_TYPES.includes(a.type) || a.type === 'subcontract')) {
      const g = bySite[a.site_id] ||= { morning: [], evening: [] }
      g[a.shift]?.push(a)
    } else {
      others.push(a)
    }
  })

  const otBySite = {}
  dayOT.forEach(o => {
    (otBySite[o.site_id] ||= []).push(o)
    if (!bySite[o.site_id]) bySite[o.site_id] = { morning: [], evening: [] }  // OT-only site still gets a card
  })

  const siteIds = Object.keys(bySite)
  if (!siteIds.length && !others.length) return `${header}\n— ไม่มีงาน —`

  const lines = [header]
  siteIds.forEach(sid => {
    const g = bySite[sid]
    const meta = siteMeta[sid] || {}
    lines.push('')
    lines.push(`🏗️ ${meta.site_number || ''} ${meta.name || ''}`.trim())
    if (meta.contact_person) lines.push(`👤 ผู้ติดต่อ: ${meta.contact_person}${meta.phone ? ` (${meta.phone})` : ''}`)
    if (meta.map_url) lines.push(`📍 ${meta.map_url}`)
    lines.push(`🌅 เช้า: ${g.morning.length ? g.morning.map(workerLabel).join(', ') : '— ว่าง —'}`)
    lines.push(`🌆 บ่าย: ${g.evening.length ? g.evening.map(workerLabel).join(', ') : '— ว่าง —'}`)
    const siteOT = otBySite[sid] || []
    if (siteOT.length) lines.push(`⚡ OT: ${siteOT.map(otLabel).join(', ')}`)
  })
  if (others.length) {
    lines.push('')
    lines.push('🏢 ลา / ออฟฟิศ / หยุด')
    others.forEach(a => {
      const label = OTHER_TYPE_LABEL[a.type] || a.type
      const shift = a.shift === 'morning' ? 'เช้า' : 'บ่าย'
      lines.push(`- ${workerLabel(a)} — ${label} (${shift})`)
    })
  }
  return lines.join('\n')
}

/**
 * @param {{iso:string}[]} days - one entry for day view, seven for week view
 * @param {Array} assignments - rows already scoped to the same date range as `days`
 * @param {Array} sites
 * @param {Array} otEntries - rows already scoped to the same date range as `days` (useWorkerOTRange shape)
 * @returns {string} plain text ready to paste into LINE
 */
export function buildLineText(days, assignments, sites, otEntries) {
  const siteMeta = {}
  ;(sites || []).forEach(s => {
    siteMeta[s.id] = {
      name: s.name, site_number: s.site_number, map_url: s.map_url,
      contact_person: s.client_contact_person, phone: s.client_phone,
    }
  })

  const byDate = {}
  ;(assignments || []).forEach(a => { (byDate[a.date] ||= []).push(a) })

  const otByDate = {}
  ;(otEntries || []).forEach(o => { (otByDate[o.date] ||= []).push(o) })

  return (days || [])
    .map(d => formatDayBlock(d.iso, byDate[d.iso] || [], otByDate[d.iso] || [], siteMeta))
    .join('\n\n' + '─'.repeat(20) + '\n\n')
}
