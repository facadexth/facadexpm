// HR › 🕐 เช็คอิน-เช็คเอาท์: one row per worker per day with the 4 points (ออกจากจุดรวมพล /
// ถึงไซท์ / ออกจากไซท์ / กลับถึงจุดรวมพล), travel, work time and OT, plus the monthly
// self-tap summary. Everything is computed at read time by src/lib/checkinDay.js -- a filled
// point ("ตามหัวหน้าทีม", or the red site-time fallback) is never written to the database.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useAppSetting, saveAppSetting } from '../../hooks/useSupabase.js'
import { fetchAllPages } from '../../lib/payroll/load.js'
import { buildCheckinDays, otHoursForDay, summarizeTaps, fmtMinutes } from '../../lib/checkinDay.js'

const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : null)
const dateOf = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('th-TH', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export async function loadCheckinDays(from, to, settings) {
  const [checkins, assignments, sites] = await Promise.all([
    fetchAllPages(() => supabase.from('worker_checkins').select('id, worker_id, date, site_id, checkin_location_id, is_assembly, checkin_at, checkout_at').gte('date', from).lte('date', to)),
    fetchAllPages(() => supabase.from('worker_assignments').select('id, worker_id, date, site_id, shift, type, is_team_leader').gte('date', from).lte('date', to)),
    supabase.from('sites').select('id, name, assembly_mode').then(({ data, error }) => { if (error) throw error; return data }),
  ])
  const sitesById = Object.fromEntries(sites.map(s => [s.id, s]))
  return { days: buildCheckinDays({ checkins, assignments, sites: sitesById, settings }), sitesById }
}

function useCheckinSettings() {
  const { data: mode } = useAppSetting('assembly_mode', 'none')
  const { data: loc } = useAppSetting('assembly_location_id', '')
  const { data: std } = useAppSetting('checkin_standard_day_hours', '8')
  return useMemo(() => ({ assemblyMode: mode || 'none', assemblyLocationId: loc || null, standardHours: parseFloat(std) || 8, ready: mode != null && loc != null }), [mode, loc, std])
}

function Point({ p, siteName }) {
  if (!p) return <span style={{ color: 'var(--text3)' }}>—</span>
  const color = p.source === 'site' ? 'var(--red)' : p.source === 'leader' ? 'var(--yellow)' : undefined
  return (
    <span style={{ color }}>
      {timeOf(p.at)}{siteName ? <span style={{ color: 'var(--text3)' }}> · {siteName}</span> : null}
      {p.source === 'leader' && <span style={{ fontSize: 11 }}> (ตามหัวหน้าทีม)</span>}
      {p.source === 'site' && <span style={{ fontSize: 11 }}> (ไม่ได้กด ใช้เวลาไซท์)</span>}
    </span>
  )
}

export function CheckinDayTable({ from, to, workerFilter, workers = [] }) {
  const settings = useCheckinSettings()
  const [state, setState] = useState({ loading: true, days: [], sitesById: {} })
  useEffect(() => {
    if (!settings.ready) return
    let cancelled = false
    setState(s => ({ ...s, loading: true }))
    loadCheckinDays(from, to, settings)
      .then(r => { if (!cancelled) setState({ loading: false, ...r }) })
      .catch(e => { if (!cancelled) setState({ loading: false, days: [], sitesById: {}, error: e.message }) })
    return () => { cancelled = true }
  }, [from, to, settings])

  const names = useMemo(() => Object.fromEntries(workers.map(w => [w.id, w.nickname || w.name])), [workers])
  const days = state.days.filter(d => !workerFilter || d.workerId === workerFilter)
  const siteName = (id) => state.sitesById[id]?.name

  if (state.loading) return <div style={{ padding: 16, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
  return (
    <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
      <div style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13 }}>⏱️ เวลางานรายวัน</div>
      <table>
        <thead>
          <tr>
            <th>ช่าง</th><th>วันที่</th><th>ออกจากจุดรวมพล</th><th>ถึงไซท์</th><th>ออกจากไซท์</th><th>กลับถึงจุดรวมพล</th>
            <th>เดินทาง</th><th>เวลางาน</th><th>กดเอง</th>
          </tr>
        </thead>
        <tbody>
          {days.map(d => {
            const ot = otHoursForDay(d, settings.standardHours)
            const travel = (d.travelOutMin ?? 0) + (d.travelBackMin ?? 0)
            return (
              <tr key={`${d.workerId}|${d.date}`} style={d.flag ? { background: 'rgba(220,38,38,0.06)' } : undefined}>
                <td style={{ fontWeight: 600 }}>{names[d.workerId] || '—'}</td>
                <td style={{ fontSize: 12 }}>{dateOf(d.date)}</td>
                <td style={{ fontSize: 12 }}>{d.mode === 'assembly' ? <Point p={d.leave} /> : <span style={{ color: 'var(--text3)' }}>ไปไซท์ตรง</span>}</td>
                <td style={{ fontSize: 12 }}><Point p={d.arrive} siteName={d.arrive && siteName(d.arrive.siteId)} /></td>
                <td style={{ fontSize: 12 }}><Point p={d.depart} siteName={d.depart && d.siteIds.length > 1 ? siteName(d.depart.siteId) : null} /></td>
                <td style={{ fontSize: 12 }}>{d.mode === 'assembly' ? (d.return ? <Point p={d.return} /> : <span style={{ color: 'var(--yellow)' }}>ยังไม่กลับ</span>) : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                <td style={{ fontSize: 12 }}>{d.travelOutMin != null || d.travelBackMin != null ? fmtMinutes(travel) : '—'}</td>
                <td style={{ fontSize: 12, fontWeight: 600 }}>
                  {d.workMin != null ? fmtMinutes(d.workMin) : <span style={{ color: 'var(--text3)', fontWeight: 400 }}>ยังไม่ครบ</span>}
                  {ot ? <span style={{ color: 'var(--accent)', fontWeight: 400 }}> · OT {fmtMinutes(Math.round(ot * 60))}</span> : null}
                </td>
                <td className="font-mono" style={{ fontSize: 12 }}>{d.tapsMade}/{d.tapsExpected}</td>
              </tr>
            )
          })}
          {!days.length && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 20 }}>ไม่มีข้อมูลในช่วงนี้</td></tr>}
        </tbody>
      </table>
      <div style={{ padding: '8px 14px', fontSize: 11.5, color: 'var(--text3)' }}>
        เวลางาน = ออกจากจุดรวมพล → กลับถึงจุดรวมพล (วันไปไซท์ตรง: ถึงไซท์แรก → ออกจากไซท์สุดท้าย) · สีเหลือง = ใช้เวลาหัวหน้าทีม · แถวแดง = ไม่มีใครกดที่จุดรวมพล ใช้เวลาไซท์แทน ให้แอดมินตรวจ
      </div>
    </div>
  )
}

export function CheckinMonthSummary({ workers = [] }) {
  const settings = useCheckinSettings()
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    if (!settings.ready || !month) return
    let cancelled = false
    const [y, m] = month.split('-').map(Number)
    const from = `${month}-01`
    const to = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
    setSummary(null)
    loadCheckinDays(from, to, settings).then(r => { if (!cancelled) setSummary(summarizeTaps(r.days)) }).catch(() => { if (!cancelled) setSummary({}) })
    return () => { cancelled = true }
  }, [month, settings])

  const rows = workers.filter(w => summary?.[w.id]).map(w => ({ w, s: summary[w.id] }))
  return (
    <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
      <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📊 สรุปการกดเช็คอินรายเดือน</span>
        <input type="month" className="input input-sm" style={{ width: 160 }} value={month} onChange={e => setMonth(e.target.value)} />
      </div>
      <table>
        <thead><tr><th>ช่าง</th><th>วันทำงาน</th><th>กดเอง</th><th>ที่ต้องกด</th><th>% กดเอง</th></tr></thead>
        <tbody>
          {summary == null ? (
            <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 16 }}>กำลังโหลด...</td></tr>
          ) : rows.map(({ w, s }) => (
            <tr key={w.id}>
              <td style={{ fontWeight: 600 }}>{w.nickname || w.name}</td>
              <td>{s.daysWorked}</td>
              <td>{s.tapsMade}</td>
              <td>{s.tapsExpected}</td>
              <td style={{ fontWeight: 600, color: s.pct != null && s.pct < 80 ? 'var(--red)' : undefined }}>{s.pct != null ? `${s.pct}%` : '—'}</td>
            </tr>
          ))}
          {summary != null && !rows.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 16 }}>ไม่มีข้อมูลเดือนนี้</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// HR ⚙️ ตั้งค่าการนับค่าแรง: "คิด OT จากเวลาเช็คอิน" (default OFF, so pay never changes
// silently). On: payroll OT for a day with a known work time = work time beyond the standard
// day; that day's typed OT is replaced, other days keep it (src/lib/payroll/attendance.js).
export function OtFromCheckinSetting() {
  const { data: on, refetch } = useAppSetting('ot_from_checkin', 'false')
  const { data: std, refetch: refetchStd } = useAppSetting('checkin_standard_day_hours', '8')
  const [stdInput, setStdInput] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (std != null) setStdInput(String(std)) }, [std])
  const run = async (fn) => {
    setSaving(true)
    try { await fn() } catch (e) { alert('Error: ' + e.message) } finally { setSaving(false) }
  }
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" style={{ marginTop: 3 }} checked={on === 'true'} disabled={on == null || saving}
          onChange={() => run(async () => { await saveAppSetting('ot_from_checkin', on === 'true' ? 'false' : 'true'); refetch() })} />
        <span>
          <span style={{ fontWeight: 600 }}>คิด OT จากเวลาเช็คอิน</span>
          <span style={{ display: 'block', color: 'var(--text3)', fontSize: 12, marginTop: 2, lineHeight: 1.6 }}>
            {on === 'true'
              ? 'เปิดอยู่: วันที่รู้เวลางานครบ (ออกจากจุดรวมพล → กลับถึง หรือ ถึงไซท์แรก → ออกจากไซท์สุดท้าย) OT = เวลางานที่เกินชั่วโมงมาตรฐาน แทน OT ที่กรอกเองของวันนั้น วันอื่นใช้ OT ที่กรอกเองเหมือนเดิม'
              : 'ปิดอยู่: OT มาจากที่กรอกในหน้าจ่ายงาน/OT เหมือนเดิม เวลาเช็คอินแสดงให้ดูอย่างเดียว ไม่กระทบเงินเดือน'}
          </span>
        </span>
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, marginLeft: 26, fontSize: 13 }}>
        <span>ชั่วโมงมาตรฐานต่อวัน</span>
        <input type="number" className="input input-sm" min="1" max="24" step="0.5" style={{ width: 80 }} value={stdInput} onChange={e => setStdInput(e.target.value)} />
        <button className="btn btn-sm btn-ghost" disabled={saving || !(parseFloat(stdInput) > 0)}
          onClick={() => run(async () => { await saveAppSetting('checkin_standard_day_hours', String(parseFloat(stdInput))); refetchStd() })}>บันทึก</button>
        <span style={{ color: 'var(--text3)', fontSize: 12 }}>(กะเดียว = ครึ่งหนึ่ง)</span>
      </div>
    </div>
  )
}
