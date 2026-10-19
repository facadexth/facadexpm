// Pure helpers for the warranty follow-up card on the Sites page.
import { warrantyEnd, warrantyStatus, followupDue } from './warranty.js'

export const bangkokToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })

// 'YYYY-MM-DD' -> 'dd/mm/yyyy' (Gregorian year, string math so no timezone shift).
export function ddmmyyyy(d) {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${day}/${m}/${y}`
}

export function followupMessage(siteName, endDate) {
  return `สวัสดีครับ ประกันงานของ ${siteName} จะหมดวันที่ ${ddmmyyyy(endDate)} มีจุดไหนต้องการให้เข้าไปตรวจหรือแก้ไขไหมครับ`
}

// sites: Completed rows with handover data; clientsById / linkedClientIds / retentionBySite are lookups.
export function buildFollowupRows(sites, today, { clientsById = {}, linkedClientIds = new Set(), retentionBySite = {} } = {}) {
  return (sites || [])
    .filter(s => followupDue({ ...s, warranty_months: Number(s.warranty_months) }, today))
    .map(s => {
      const months = Number(s.warranty_months)
      const st = warrantyStatus(s.handover_date, months, today)
      const client = clientsById[s.client_id] || null
      const ret = retentionBySite[s.id]
      const total = Number(ret?.total_retention) || 0
      return {
        id: s.id,
        siteName: s.name,
        siteNumber: s.site_number,
        clientName: client?.name || '—',
        phone: client?.phone || '',
        lineLinked: linkedClientIds.has(s.client_id),
        handover: s.handover_date,
        end: warrantyEnd(s.handover_date, months),
        daysLeft: st.daysLeft,
        retentionDue: ret && !ret.retention_released && total > 0 ? total : 0,
      }
    })
    .sort((a, b) => a.daysLeft - b.daysLeft)
}
