// ============================================================
// MySchedule — WORKER's personal view of the Assign page: their
// own days/shifts/OT for the current range, plus their leave quota.
// No team grid, no cost figures — RLS also enforces this at the
// database level, this component is the matching restricted UI.
// Day/week views render a linear day list; month view renders a real
// calendar grid (reusing AssignCell so it matches ADMIN's month grid
// visually — same site colors/abbreviations, same OT badge).
// ============================================================
import { useMemo } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useWorkers, useAssignmentsRange, useWorkerOTRange, useSitesProgress, useLeaveQuotaUsage } from '../../hooks/useSupabase.js'
import { DOW_TH } from './constants.js'
import AssignCell from './AssignCell.jsx'

const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'หยุด' }
const DOW_MON_START = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']
const noop = () => {}

export default function MySchedule({ from, to, days, view }) {
  const { user } = useUserRole()
  const { data: workers } = useWorkers()
  const { data: assignments } = useAssignmentsRange(from, to)
  const { data: otEntries } = useWorkerOTRange(from, to)
  const { data: sites } = useSitesProgress()
  const now = new Date()
  const { data: leaveUsed } = useLeaveQuotaUsage(now.getFullYear())

  const me = useMemo(() => (workers || []).find(w => w.email === user?.email), [workers, user])

  const siteById = useMemo(() => {
    const m = {}
    ;(sites || []).forEach(s => { m[s.id] = s })
    return m
  }, [sites])

  const myAssignmentsByDate = useMemo(() => {
    const m = {}
    ;(assignments || []).forEach(a => {
      if (a.worker_id !== me?.id) return
      ;(m[a.date] ||= []).push(a)
    })
    return m
  }, [assignments, me])

  const myOtByDate = useMemo(() => {
    const m = {}
    ;(otEntries || []).forEach(o => {
      if (o.worker_id !== me?.id) return
      m[o.date] = o
    })
    return m
  }, [otEntries, me])

  // AssignCell-compatible cell for one date: { morning, evening } segments,
  // each carrying site_name/site_number resolved via sites_progress (not
  // the assignment row's own nested `sites` join, which RLS blocks for
  // WORKER once Task 6 goes live since it touches the base sites table).
  const cellFor = (iso) => {
    const dayAssignments = myAssignmentsByDate[iso] || []
    const toSeg = (a) => a && {
      type: a.type, site_id: a.site_id,
      site_name: siteById[a.site_id]?.name, site_number: siteById[a.site_id]?.site_number,
    }
    return {
      morning: toSeg(dayAssignments.find(a => a.shift === 'morning')),
      evening: toSeg(dayAssignments.find(a => a.shift === 'evening')),
    }
  }

  // Pad `days` (which only contains real days-in-month, no adjacent-month
  // filler) out to a Monday-start 7-column grid.
  const monthGrid = useMemo(() => {
    if (view !== 'month' || !days.length) return []
    const firstDow = (days[0].date.getDay() + 6) % 7 // 0=Mon..6=Sun
    const leading = Array.from({ length: firstDow }, () => null)
    const cells = [...leading, ...days]
    const trailing = (7 - (cells.length % 7)) % 7
    return [...cells, ...Array.from({ length: trailing }, () => null)]
  }, [view, days])

  if (!me) {
    return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้</div>
  }

  const used = leaveUsed?.[me.id] || 0
  const remaining = (me.annual_leave_days || 0) - used

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm">
          <div className="kpi-label">วันลากิจใช้ไปแล้ว (ปีนี้)</div>
          <div className="kpi-value" style={{ color: used > 0 ? 'var(--red)' : 'var(--text)' }}>{used}</div>
        </div>
        <div className="kpi-card kpi-sm">
          <div className="kpi-label">คงเหลือ</div>
          <div className="kpi-value" style={{ color: remaining < 0 ? 'var(--red)' : 'var(--green)' }}>{remaining}</div>
        </div>
      </div>

      {view === 'month' ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
            {DOW_MON_START.map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10.5, color: 'var(--text3)', fontWeight: 700 }}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {monthGrid.map((d, i) => {
              if (!d) return <div key={`blank-${i}`} />
              const ot = myOtByDate[d.iso]
              const isToday = d.iso === new Date().toISOString().slice(0, 10)
              return (
                <div key={d.iso} style={{
                  border: `1px solid ${isToday ? 'var(--accent)' : 'transparent'}`, borderRadius: 6, padding: 2,
                }}>
                  <div style={{ fontSize: 10, color: d.isSunday ? 'var(--text3)' : 'var(--text2)', textAlign: 'center', marginBottom: 2 }}>
                    {d.date.getDate()}
                  </div>
                  <AssignCell cell={cellFor(d.iso)} ot={ot} onEdit={noop} h={54} variant="month" />
                </div>
              )
            })}
          </div>
        </div>
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {days.map(d => {
          const dayAssignments = myAssignmentsByDate[d.iso] || []
          const ot = myOtByDate[d.iso]
          const morning = dayAssignments.find(a => a.shift === 'morning')
          const evening = dayAssignments.find(a => a.shift === 'evening')
          const isToday = d.iso === new Date().toISOString().slice(0, 10)
          const primary = morning || evening

          return (
            <div key={d.iso} style={{
              display: 'grid', gridTemplateColumns: '56px 1fr auto', alignItems: 'center', gap: 14,
              background: 'var(--bg2)', border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 9, padding: '12px 14px',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>{DOW_TH[d.dow]}</div>
                <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1 }}>{d.date.getDate()}</div>
              </div>
              <div>
                {primary ? (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 3 }}>
                      {['site', 'factory'].includes(primary.type)
                        ? `${primary.type === 'factory' ? '🏭' : '🏗️'} ${siteById[primary.site_id]?.site_number || ''} · ${siteById[primary.site_id]?.name || '—'}`
                        : (OTHER_TYPE_LABEL[primary.type] || primary.type)}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {morning && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(255,209,102,.16)', color: 'var(--yellow)' }}>เช้า</span>}
                      {evening && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(108,99,255,.18)', color: '#b8b0ff' }}>บ่าย</span>}
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--text3)' }}>— ไม่มีงาน —</div>
                )}
              </div>
              {ot && (
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', background: 'rgba(0,212,170,.13)', borderRadius: 999, padding: '5px 10px', whiteSpace: 'nowrap' }}>
                  ⚡ OT {ot.ot_hours} ชม.
                </div>
              )}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}
