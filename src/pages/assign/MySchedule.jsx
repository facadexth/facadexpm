// ============================================================
// MySchedule — WORKER's personal view of the Assign page: their
// own days/shifts/OT for the current range, plus their leave quota.
// No team grid, no cost figures — RLS also enforces this at the
// database level, this component is the matching restricted UI.
// ============================================================
import { useMemo } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useWorkers, useAssignmentsRange, useWorkerOTRange, useSitesProgress, useLeaveQuotaUsage } from '../../hooks/useSupabase.js'
import { DOW_TH } from './constants.js'

const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'หยุด' }

export default function MySchedule({ from, to, days }) {
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
    </div>
  )
}
