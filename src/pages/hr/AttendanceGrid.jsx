// ============================================================
// AttendanceGrid -- workers × days check-in/checkout grid for HR's
// เช็คอิน-เช็คเอาท์ tab (spec: 2026-09-29-checkin-locations-design.md).
// Owns its own view/anchor/data-fetching, completely independent of the
// existing free-form checkinFrom/checkinTo list below it in HR.jsx --
// reuses ViewToggle as-is (day/week/month; day view naturally degrades to
// a 1-column grid, no special-casing needed).
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, format } from 'date-fns'
import { supabase } from '../../lib/supabase.js'
import ViewToggle from '../assign/ViewToggle.jsx'
import { deriveCellStates } from '../../lib/checkinGrid.js'

const STATE_STYLE = {
  done:   { background: 'var(--green)', title: 'เช็คอิน/เช็คเอาท์ครบ' },
  open:   { background: 'var(--yellow)', title: 'เช็คอินแล้ว ยังไม่เช็คเอาท์' },
  missed: { background: 'var(--red)', title: 'มีตารางงาน ไม่ได้เช็คอิน' },
}

export default function AttendanceGrid({ workers, onCellClick }) {
  const [view, setView] = useState('week')
  const [anchor, setAnchor] = useState(new Date())
  const [checkins, setCheckins] = useState([])
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true)

  const days = useMemo(() => {
    if (view === 'day') return [format(anchor, 'yyyy-MM-dd')]
    const start = view === 'month' ? startOfMonth(anchor) : startOfWeek(anchor, { weekStartsOn: 1 })
    const end = view === 'month' ? endOfMonth(anchor) : endOfWeek(anchor, { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end }).map(d => format(d, 'yyyy-MM-dd'))
  }, [view, anchor])

  useEffect(() => {
    if (!days.length) return
    let cancelled = false
    setLoading(true)
    const from = days[0], to = days[days.length - 1]
    Promise.all([
      supabase.from('worker_checkins').select('worker_id, date, checkin_at, checkout_at').gte('date', from).lte('date', to).order('checkin_at'),
      supabase.from('worker_assignments').select('worker_id, date, type').gte('date', from).lte('date', to),
    ]).then(([c, a]) => {
      if (cancelled) return
      setCheckins(c.data || [])
      setAssignments(a.data || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [days])

  const cellState = useMemo(() => deriveCellStates(checkins, assignments), [checkins, assignments])

  return (
    <div style={{ marginBottom: 20 }}>
      <ViewToggle view={view} onView={setView} anchor={anchor} onAnchor={setAnchor} />
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>ช่าง</th>
                {days.map(d => <th key={d} style={{ fontSize: 11, textAlign: 'center' }}>{format(new Date(d + 'T00:00:00Z'), 'd/M')}</th>)}
              </tr>
            </thead>
            <tbody>
              {(workers || []).map(w => (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{w.nickname || w.name}</td>
                  {days.map(d => {
                    const st = cellState(w.id, d)
                    const style = st ? STATE_STYLE[st] : null
                    return (
                      <td key={d} style={{ textAlign: 'center', padding: 4 }}>
                        <button
                          type="button"
                          title={style?.title}
                          onClick={() => st && onCellClick?.(w.id, d)}
                          style={{
                            width: 18, height: 18, borderRadius: 4, border: 'none', padding: 0,
                            cursor: st ? 'pointer' : 'default',
                            background: style?.background || 'transparent',
                          }}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
              {!(workers || []).length && (
                <tr><td colSpan={days.length + 1} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูลช่าง</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
