// ============================================================
// DayView — single day grouped by site, morning/evening columns + cost
// ============================================================
import { useMemo } from 'react'
import { fmt } from '../../lib/supabase.js'
import { TYPE_COLOR, TYPE_LABEL, SITE_TYPES } from './constants.js'
import { otCost } from './otMath.js'

const dayRate = (w) => Math.round((w?.monthly_salary || 0) / 26)

export default function DayView({ dayIso, assignments, otEntries, sites, travelRate, onEditHalf }) {
  const siteMeta = useMemo(() => {
    const m = {}
    ;(sites || []).forEach(s => { m[s.id] = { name: s.name, site_number: s.site_number, distance_km: s.distance_km } })
    return m
  }, [sites])

  const rows = (assignments || []).filter(a => a.date === dayIso)
  const dayOT = (otEntries || []).filter(o => o.date === dayIso)
  const otBySite = {}
  dayOT.forEach(o => { (otBySite[o.site_id] ||= []).push(o) })

  // group site/factory/subcontract by site; keep others separately
  const bySite = {}
  const others = []  // leave/office/holiday
  rows.forEach(a => {
    if (a.site_id && (SITE_TYPES.includes(a.type) || a.type === 'subcontract')) {
      const g = bySite[a.site_id] ||= { morning: [], evening: [], hasSiteType: false, labor: 0 }
      g[a.shift]?.push(a)
      if (a.type === 'site') g.hasSiteType = true
      if (SITE_TYPES.includes(a.type)) g.labor += 0.5 * dayRate(a.workers)
    } else {
      others.push(a)
    }
  })

  const siteIds = Object.keys(bySite)

  const Chip = ({ a }) => {
    const tc = TYPE_COLOR[a.type] || TYPE_COLOR.site
    return (
      <span onClick={() => onEditHalf({ id: a.worker_id, name: a.workers?.name, nickname: a.workers?.nickname }, a.date, a.shift)}
        title={`${a.workers?.name || ''}${a.type === 'factory' ? ' (โรงงาน)' : ''}${a.ot_hours > 0 ? ' OT' + a.ot_hours + 'h' : ''}`}
        style={{ background: tc.bg, color: tc.color, borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
        {a.workers?.nickname || a.workers?.name}{a.type === 'factory' ? ' 🏭' : ''}{a.ot_hours > 0 ? ' ⚡' : ''}
      </span>
    )
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {siteIds.map(sid => {
          const g = bySite[sid]
          const meta = siteMeta[sid] || {}
          const travel = g.hasSiteType ? (meta.distance_km || 0) * 2 * (travelRate || 0) : 0
          const siteOT = otBySite[sid] || []
          const otTotal = siteOT.reduce((s, o) => s + otCost(o.workers?.monthly_salary, o.ot_hours), 0)
          const total = g.labor + travel + otTotal
          return (
            <div key={sid} className="card card-body" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--accent)' }}>{meta.site_number}</div>
                  <div style={{ fontWeight: 700, fontSize: 14, overflowWrap: 'anywhere' }}>{meta.name}</div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวมวันนี้</div>
                  <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 16 }}>{fmt(total)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    แรง {fmt(g.labor)}{travel > 0 && <> · เดินทาง {fmt(travel)}</>}{otTotal > 0 && <> · OT {fmt(otTotal)}</>}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--blue)', marginBottom: 4 }}>🌅 เช้า</div>
                  {g.morning.length ? g.morning.map(a => <Chip key={a.id} a={a} />) : <span style={{ fontSize: 11, color: 'var(--text3)' }}>— ว่าง —</span>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--yellow)', marginBottom: 4 }}>🌆 บ่าย</div>
                  {g.evening.length ? g.evening.map(a => <Chip key={a.id} a={a} />) : <span style={{ fontSize: 11, color: 'var(--text3)' }}>— ว่าง —</span>}
                </div>
              </div>
              {siteOT.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--yellow)', marginBottom: 4 }}>⚡ OT</div>
                  {siteOT.map(o => (
                    <span key={o.id} onClick={() => onEditHalf({ id: o.worker_id, name: o.workers?.name, nickname: o.workers?.nickname }, o.date, 'morning')}
                      title={`${o.workers?.name || ''} · ${o.start_time?.slice(0,5)}-${o.end_time?.slice(0,5)}`}
                      style={{ background: 'rgba(255,209,102,0.25)', color: 'var(--yellow)', borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
                      {o.workers?.nickname || o.workers?.name} ({o.start_time?.slice(0,5)}-{o.end_time?.slice(0,5)})
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {!siteIds.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีการ assign ในวันนี้</div>}
      </div>

      {others.length > 0 && (
        <div className="card card-body" style={{ padding: '12px 16px', marginTop: 12 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text3)', marginBottom: 6 }}>ลา / ออฟฟิศ / หยุด</div>
          {others.map(a => {
            const tc = TYPE_COLOR[a.type] || TYPE_COLOR.holiday
            return (
              <span key={a.id} onClick={() => onEditHalf({ id: a.worker_id, name: a.workers?.name, nickname: a.workers?.nickname }, a.date, a.shift)}
                style={{ background: tc.bg, color: tc.color, borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
                {a.workers?.nickname || a.workers?.name} · {TYPE_LABEL[a.type] || a.type} ({a.shift === 'morning' ? 'เช้า' : 'บ่าย'})
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
