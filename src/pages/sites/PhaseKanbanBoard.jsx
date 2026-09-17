// ============================================================
// PhaseKanbanBoard -- งานย่อย (task) ของแต่ละขั้นตอน แสดงเป็นบอร์ด 3 คอลัมน์
// (ยังไม่เริ่ม/กำลังทำ/เสร็จแล้ว) กรองตามขั้นตอน+ชั้น/โซน คลิกการ์ดเปิด panel
// แก้ไขในหน้าเดียว (ชื่อ/โซน/สถานะ/กำหนดเสร็จ/ผู้รับผิดชอบ) + ลากการ์ดย้าย
// คอลัมน์แบบด่วนบนเดสก์ท็อป (HTML5 native drag -- คลิกเปิด panel คือ
// fallback ที่ใช้ได้ทุกอุปกรณ์รวมถึงทัช). สถานะของขั้นตอนแม่บน Gantt
// คำนวณสดจาก phase_tasks นี้เอง (ดู GanttView.jsx) ไม่ได้เขียนกลับ
// site_phases.status ตรงๆ จากที่นี่
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { useSitePhases, usePhaseTasks, useWorkers } from '../../hooks/useSupabase.js'
import { STATUS_COLOR } from './ganttTimeline.js'

const COLUMNS = [
  { status: 'not_started', label: 'ยังไม่เริ่ม' },
  { status: 'in_progress', label: 'กำลังทำ' },
  { status: 'done', label: 'เสร็จแล้ว' },
]

const emptyDraft = (phaseId, status, sortOrder) => ({
  phase_id: phaseId, name: '', zone: '', status, due_date: '', sort_order: sortOrder, assigneeIds: [],
})

export default function PhaseKanbanBoard({ site, canEdit, onTasksChanged }) {
  const { data: allPhases } = useSitePhases()
  const { data: allTasks, refetch } = usePhaseTasks()
  const { data: workers } = useWorkers()

  const [selectedPhaseId, setSelectedPhaseId] = useState(null)
  const [selectedZone, setSelectedZone] = useState('all')
  const [editingId, setEditingId] = useState(null) // task.id หรือ '__new__:<status>'
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [dragOverStatus, setDragOverStatus] = useState(null)

  const phases = useMemo(() => (allPhases || [])
    .filter((p) => p.site_id === site.id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)), [allPhases, site.id])

  const tasksByPhaseId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => { (m[t.phase_id] ||= []).push(t) })
    return m
  }, [allTasks])

  const workerById = useMemo(() => {
    const m = {}
    ;(workers || []).forEach((w) => { m[w.id] = w })
    return m
  }, [workers])

  const activePhaseId = selectedPhaseId ?? phases.find((p) => (tasksByPhaseId[p.id] || []).length > 0)?.id ?? phases[0]?.id ?? null
  const phaseTasks = tasksByPhaseId[activePhaseId] || []

  const zones = useMemo(() => [...new Set(phaseTasks.map((t) => t.zone).filter(Boolean))].sort(), [phaseTasks])
  const visibleTasks = phaseTasks.filter((t) => selectedZone === 'all' || t.zone === selectedZone)

  const afterWrite = async () => {
    await refetch()
    onTasksChanged?.()
  }

  const startEdit = (task) => {
    setEditingId(task.id)
    setDraft({
      phase_id: task.phase_id, name: task.name, zone: task.zone || '', status: task.status,
      due_date: task.due_date || '', sort_order: task.sort_order,
      assigneeIds: (task.phase_task_workers || []).map((r) => r.worker_id),
    })
  }
  const startAdd = (status) => {
    if (!activePhaseId) return
    const sortOrder = phaseTasks.length ? Math.max(...phaseTasks.map((t) => t.sort_order || 0)) + 1 : 1
    setEditingId(`__new__:${status}`)
    setDraft(emptyDraft(activePhaseId, status, sortOrder))
  }
  const cancelEdit = () => { setEditingId(null); setDraft(null) }

  const saveDraft = async () => {
    if (!draft.name.trim()) { alert('กรุณาตั้งชื่องาน'); return }
    setSaving(true)
    try {
      const payload = {
        name: draft.name.trim(), zone: draft.zone.trim() || null, status: draft.status,
        due_date: draft.due_date || null, sort_order: draft.sort_order,
      }
      let taskId = editingId
      if (String(editingId).startsWith('__new__')) {
        const { data, error } = await supabase.from('phase_tasks')
          .insert({ phase_id: draft.phase_id, site_id: site.id, ...payload })
          .select().single()
        if (error) throw error
        taskId = data.id
      } else {
        const { error } = await supabase.from('phase_tasks').update(payload).eq('id', editingId)
        if (error) throw error
      }
      if (draft.assigneeIds.length) {
        const { error: insErr } = await supabase.from('phase_task_workers')
          .upsert(draft.assigneeIds.map((worker_id) => ({ task_id: taskId, worker_id })), { onConflict: 'task_id,worker_id', ignoreDuplicates: true })
        if (insErr) throw insErr
      }
      let delQuery = supabase.from('phase_task_workers').delete().eq('task_id', taskId)
      if (draft.assigneeIds.length) delQuery = delQuery.not('worker_id', 'in', `(${draft.assigneeIds.join(',')})`)
      const { error: delErr } = await delQuery
      if (delErr) throw delErr
      await afterWrite()
      cancelEdit()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (id) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('phase_tasks').delete().eq('id', id)
      if (error) throw error
      await afterWrite()
      if (editingId === id) cancelEdit()
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
      setConfirmDeleteId(null)
    }
  }

  const quickMove = async (taskId, status) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('phase_tasks').update({ status }).eq('id', taskId)
      if (error) throw error
      await afterWrite()
    } catch (e) {
      alert('ย้ายไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const toggleAssignee = (workerId) => {
    setDraft((d) => ({
      ...d,
      assigneeIds: d.assigneeIds.includes(workerId) ? d.assigneeIds.filter((id) => id !== workerId) : [...d.assigneeIds, workerId],
    }))
  }

  if (!phases.length) {
    return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไซท์นี้ยังไม่มีขั้นตอนงาน — เพิ่มขั้นตอนก่อนในแท็บ Gantt</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
        เฟส:
        {phases.map((p) => (
          <span key={p.id} onClick={() => { setSelectedPhaseId(p.id); setSelectedZone('all') }}
            style={{
              border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer',
              background: activePhaseId === p.id ? 'var(--accent)' : 'transparent',
              color: activePhaseId === p.id ? '#fff' : 'var(--text2)',
            }}>
            {p.name}
          </span>
        ))}
      </div>
      {zones.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
          ชั้น:
          {['all', ...zones].map((z) => (
            <span key={z} onClick={() => setSelectedZone(z)}
              style={{
                border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer',
                background: selectedZone === z ? 'var(--accent)' : 'transparent',
                color: selectedZone === z ? '#fff' : 'var(--text2)',
              }}>
              {z === 'all' ? 'ทุกชั้น' : z}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        {COLUMNS.map((col) => {
          const colTasks = visibleTasks.filter((t) => t.status === col.status)
          const isNewHere = editingId === `__new__:${col.status}`
          return (
            <div key={col.status}
              onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOverStatus(col.status) } : undefined}
              onDragLeave={canEdit ? () => setDragOverStatus((s) => (s === col.status ? null : s)) : undefined}
              onDrop={canEdit ? (e) => {
                e.preventDefault()
                setDragOverStatus(null)
                const taskId = e.dataTransfer.getData('text/plain')
                if (taskId) quickMove(taskId, col.status)
              } : undefined}
              style={{
                background: dragOverStatus === col.status ? 'var(--bg3)' : 'transparent',
                borderRadius: 9, padding: 4, transition: 'background .1s',
              }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
                <span>{col.label}</span>
                <span style={{ background: 'var(--bg3)', borderRadius: 20, padding: '1px 8px', fontSize: 11, color: 'var(--text3)' }}>{colTasks.length}</span>
              </div>

              {colTasks.map((task) => {
                const assignees = (task.phase_task_workers || []).map((r) => workerById[r.worker_id]).filter(Boolean)
                if (editingId === task.id) {
                  return (
                    <TaskEditPanel key={task.id} draft={draft} setDraft={setDraft} workers={workers || []}
                      onToggleAssignee={toggleAssignee} onCancel={cancelEdit} onSave={saveDraft}
                      onDelete={() => setConfirmDeleteId(task.id)} saving={saving} />
                  )
                }
                return (
                  <div key={task.id}
                    draggable={canEdit}
                    onDragStart={canEdit ? (e) => e.dataTransfer.setData('text/plain', task.id) : undefined}
                    onClick={canEdit ? () => startEdit(task) : undefined}
                    style={{
                      background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `3px solid ${STATUS_COLOR[task.status] || STATUS_COLOR.not_started}`,
                      borderRadius: 9, padding: '11px 13px', marginBottom: 10, boxShadow: 'var(--shadow)', cursor: canEdit ? 'pointer' : 'default',
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{task.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      {task.zone
                        ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', background: 'rgba(78,205,196,.14)', borderRadius: 20, padding: '2px 9px' }}>{task.zone}</span>
                        : <span />}
                      <div style={{ display: 'flex', gap: 4 }}>
                        {assignees.length
                          ? assignees.map((w) => (
                            <span key={w.id} title={w.nickname || w.name} style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {(w.nickname || w.name || '?').slice(0, 2)}
                            </span>
                          ))
                          : <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>ยังไม่มอบหมาย</span>}
                      </div>
                    </div>
                  </div>
                )
              })}

              {isNewHere && (
                <TaskEditPanel draft={draft} setDraft={setDraft} workers={workers || []}
                  onToggleAssignee={toggleAssignee} onCancel={cancelEdit} onSave={saveDraft} saving={saving} isNew />
              )}

              {canEdit && !editingId && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={() => startAdd(col.status)}>+ เพิ่มงาน</button>
              )}
            </div>
          )
        })}
      </div>

      {confirmDeleteId && (
        <ConfirmDialog
          title="ลบงานย่อย"
          message="ต้องการลบงานนี้ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้"
          danger
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => doDelete(confirmDeleteId)}
        />
      )}
    </div>
  )
}

function TaskEditPanel({ draft, setDraft, workers, onToggleAssignee, onCancel, onSave, onDelete, saving, isNew }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 9, padding: 12, marginBottom: 10 }}>
      <input className="input input-sm" style={{ width: '100%', marginBottom: 8, fontWeight: 600 }}
        value={draft.name} placeholder="ชื่องาน" autoFocus
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {COLUMNS.map((c) => (
          <button key={c.status} type="button"
            className={`btn btn-sm ${draft.status === c.status ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1, fontSize: 11, padding: '5px 4px' }}
            onClick={() => setDraft((d) => ({ ...d, status: c.status }))}>
            {c.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
          ชั้น/โซน
          <input className="input input-sm" style={{ width: '100%', marginTop: 2 }} placeholder="เช่น ชั้น 3" value={draft.zone}
            onChange={(e) => setDraft((d) => ({ ...d, zone: e.target.value }))} />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
          กำหนดเสร็จ
          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }} value={draft.due_date || ''}
            onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value }))} />
        </label>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>มอบหมายให้</div>
      <div style={{ maxHeight: 110, overflowY: 'auto', display: 'grid', gap: 4, marginBottom: 8, background: 'var(--bg3)', borderRadius: 6, padding: 8 }}>
        {workers.map((w) => (
          <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={draft.assigneeIds.includes(w.id)} onChange={() => onToggleAssignee(w.id)} />
            {w.nickname || w.name}
          </label>
        ))}
        {!workers.length && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>ไม่มีรายชื่อช่าง</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {!isNew && (
          <button type="button" className="btn btn-sm btn-danger" style={{ marginRight: 'auto' }} disabled={saving} onClick={onDelete}>🗑 ลบ</button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={onCancel}>ยกเลิก</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={onSave}>{saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </div>
  )
}
