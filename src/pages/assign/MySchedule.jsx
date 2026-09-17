// ============================================================
// MySchedule — WORKER's personal view of the Assign page: their
// own days/shifts/OT for the current range, plus their leave quota,
// today's team roster, and today's assigned Kanban tasks.
// No team grid beyond "who's with me today", no cost figures — RLS
// also enforces this at the database level, this component is the
// matching restricted UI.
// Day/week views render a linear day list; month view renders a real
// calendar grid (reusing AssignCell so it matches ADMIN's month grid
// visually — same site colors/abbreviations, same OT badge).
// ============================================================
import { useMemo, useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useAllActiveWorkers, useAssignmentsRange, useWorkerOTRange, useMySiteNames, useLeaveQuotaUsage, usePhaseTasks, useMyTeamToday } from '../../hooks/useSupabase.js'
import { supabase } from '../../lib/supabase.js'
import { isTaskOverdue } from '../sites/phaseTasksCalc.js'
import { DOW_TH } from './constants.js'
import AssignCell from './AssignCell.jsx'
import TodayCheckinCard from './TodayCheckinCard.jsx'

const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'หยุด' }
const DOW_MON_START = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']
const TASK_STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จแล้ว' },
]
const noop = () => {}

export default function MySchedule({ from, to, days, view }) {
  const { user } = useUserRole()
  const { data: workers } = useAllActiveWorkers()
  const { data: assignments } = useAssignmentsRange(from, to)
  const { data: otEntries } = useWorkerOTRange(from, to)
  const { data: sites } = useMySiteNames()
  const { data: leaveUsed } = useLeaveQuotaUsage(new Date().getFullYear())
  const { data: myTasksRaw, refetch: refetchTasks } = usePhaseTasks()
  const { data: teamToday } = useMyTeamToday()

  const [openStatusMenuId, setOpenStatusMenuId] = useState(null)
  const [savingTaskId, setSavingTaskId] = useState(null)

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

  const todayIso = new Date().toISOString().slice(0, 10)

  // งานที่มอบหมายให้ตัวเองและยังไม่เสร็จ -- RLS บน phase_tasks จำกัดผลลัพธ์
  // ของ usePhaseTasks() ไว้อยู่แล้วเฉพาะงานที่ตัวเองเป็น assignee (ดู
  // worker_reads_own policy) แต่ยังกรองซ้ำฝั่ง client ด้วย เผื่อกรณี role
  // สูงกว่า WORKER เปิดหน้านี้ (canEdit=false แต่ไม่ใช่ WORKER จริง) ให้
  // ตรงกับ pattern เดิมของไฟล์นี้ (myAssignmentsByDate/myOtByDate ก็กรองซ้ำ
  // ฝั่ง client เหมือนกันแม้ RLS จะจำกัดไว้แล้ว
  const myTasks = useMemo(() => {
    const mine = (myTasksRaw || []).filter((t) =>
      t.status !== 'done' && (t.phase_task_workers || []).some((r) => r.worker_id === me?.id))
    return mine.sort((a, b) => {
      const aOver = isTaskOverdue(a, todayIso), bOver = isTaskOverdue(b, todayIso)
      if (aOver !== bOver) return aOver ? -1 : 1
      const order = { in_progress: 0, not_started: 1 }
      return (order[a.status] ?? 2) - (order[b.status] ?? 2)
    })
  }, [myTasksRaw, me, todayIso])

  const updateTaskStatus = async (taskId, status) => {
    setSavingTaskId(taskId)
    try {
      const { error } = await supabase.from('phase_tasks').update({ status }).eq('id', taskId)
      if (error) throw error
      await refetchTasks()
      setOpenStatusMenuId(null)
    } catch (e) {
      alert('อัปเดตไม่สำเร็จ: ' + e.message)
    } finally {
      setSavingTaskId(null)
    }
  }

  // Today's distinct site assignments (site-type only) -- one
  // TodayCheckinCard per distinct site_id, since a worker can be
  // assigned to two different sites the same day (spec edge case).
  const todaySiteAssignments = useMemo(() => {
    const rows = (myAssignmentsByDate[todayIso] || []).filter(a => a.type === 'site')
    const bySite = new Map()
    rows.forEach(a => { if (!bySite.has(a.site_id)) bySite.set(a.site_id, a) })
    return [...bySite.values()]
  }, [myAssignmentsByDate, todayIso])

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

      {teamToday && teamToday.length > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 10 }}>ทีมของคุณวันนี้</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {teamToday.map((w) => (
              <span key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: w.id === me.id ? 'var(--blue)' : 'var(--accent)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {(w.nickname || w.name || '?').slice(0, 2)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{w.nickname || w.name}{w.id === me.id ? ' (คุณ)' : ''}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>งานของคุณวันนี้</div>
      {myTasks.length ? (
        <div style={{ marginBottom: 18 }}>
          {myTasks.map((t) => {
            const overdue = isTaskOverdue(t, todayIso)
            const borderColor = overdue ? 'var(--red)' : t.status === 'in_progress' ? 'var(--yellow)' : 'var(--text3)'
            const isOpen = openStatusMenuId === t.id
            return (
              <div key={t.id} style={{ marginBottom: 8 }}>
                <div onClick={() => setOpenStatusMenuId(isOpen ? null : t.id)}
                  style={{
                    background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `3px solid ${borderColor}`,
                    borderRadius: 9, padding: '11px 13px', cursor: 'pointer',
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                    {overdue && '⚠️ '}{t.name}
                    {overdue && <span style={{ fontWeight: 400, color: 'var(--red)', fontSize: 11 }}> เลยกำหนด</span>}
                    {!overdue && t.status === 'in_progress' && <span style={{ fontWeight: 400, color: 'var(--yellow)', fontSize: 11 }}> กำลังทำ</span>}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
                    <span>{siteById[t.site_id]?.site_number || ''}{t.zone ? ` · ${t.zone}` : ''}</span>
                    <span>แตะเพื่ออัปเดต</span>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    {TASK_STATUS_OPTS.map((s) => (
                      <button key={s.value} type="button" className={`btn btn-sm ${t.status === s.value ? 'btn-primary' : 'btn-ghost'}`}
                        disabled={savingTaskId === t.id} style={{ flex: 1, fontSize: 11 }}
                        onClick={() => updateTaskStatus(t.id, s.value)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ color: 'var(--text3)', fontSize: 12.5, marginBottom: 18 }}>ไม่มีงานที่มอบหมายวันนี้</div>
      )}

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
            <div key={d.iso}>
              <div style={{
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
                        {evening && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(108,99,255,.18)', color: 'var(--accent)' }}>บ่าย</span>}
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
              {isToday && todaySiteAssignments.map(a => (
                <TodayCheckinCard
                  key={a.site_id}
                  workerId={me.id} siteId={a.site_id}
                  siteName={siteById[a.site_id]?.name || a.site_id}
                  date={todayIso}
                />
              ))}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}
