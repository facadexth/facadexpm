// ============================================================
// PhaseKanbanBoard -- งานย่อย (task) ของแต่ละขั้นตอน แสดงเป็นบอร์ด 3 คอลัมน์
// (ยังไม่เริ่ม/กำลังทำ/เสร็จแล้ว) กรองตามขั้นตอน+ชั้น/โซน คลิกการ์ดเปิด panel
// แก้ไขในหน้าเดียว (ชื่อ/โซน/สถานะ/กำหนดเสร็จ/ผู้รับผิดชอบ) + ลากการ์ดย้าย
// คอลัมน์แบบด่วนบนเดสก์ท็อป (HTML5 native drag -- คลิกเปิด panel คือ
// fallback ที่ใช้ได้ทุกอุปกรณ์รวมถึงทัช). สถานะของขั้นตอนแม่บน Gantt
// คำนวณสดจาก phase_tasks นี้เอง (ดู GanttView.jsx) ไม่ได้เขียนกลับ
// site_phases.status ตรงๆ จากที่นี่
//
// ค่าเริ่มต้นคือ "ทั้งหมด" (ALL_PHASES) -- รวมทุกขั้นตอนที่มีงานย่อยไว้ในหน้า
// เดียว (บอร์ด 3 คอลัมน์แยกต่อขั้นตอน ไม่ปนกันเป็นกองเดียว เพื่อไม่ให้งง --
// ดูเฉพาะขั้นตอนที่เป็น leaf เองเท่านั้น ขั้นตอนที่มีขั้นตอนย่อยข้างในจะไม่
// โชว์อะไรในโหมดนี้ ข้อจำกัดที่รับทราบแล้ว) เลือกขั้นตอนใดขั้นตอนหนึ่งจาก chip
// เพื่อโฟกัสดูเฉพาะขั้นตอนนั้น (มีตัวกรองชั้น/โซนเพิ่มด้วยในโหมดนี้) -- ถ้า
// ขั้นตอนที่เลือกมีขั้นตอนย่อย จะงอก chip แถวใหม่ต่อท้ายให้เลือกลึกลงไปอีกชั้น
// ไปเรื่อยๆ จนถึง leaf (ดู selectedChain ด้านล่าง) -- คลิกแท่ง leaf บนแท็บ
// Gantt ก็จะ deep-link มาที่นี่พร้อม chip เลือกไว้ให้ทั้งเส้นผ่าน initialLeafId
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { useSitePhases, usePhaseTasks, useWorkers, useSubtasks } from '../../hooks/useSupabase.js'
import { STATUS_COLOR } from './ganttTimeline.js'
import { groupSubtasksByParent, isLeaf } from './subtaskCalc.js'

const ALL_PHASES = '__all__'

const COLUMNS = [
  { status: 'not_started', label: 'ยังไม่เริ่ม' },
  { status: 'in_progress', label: 'กำลังทำ' },
  { status: 'done', label: 'เสร็จแล้ว' },
]

const emptyDraft = (phaseId, status, sortOrder) => ({
  phase_id: phaseId, name: '', zone: '', status, due_date: '', sort_order: sortOrder, assigneeIds: [], leadWorkerId: null,
})

export default function PhaseKanbanBoard({ site, canEdit, onTasksChanged, initialLeafId }) {
  const { data: allPhases } = useSitePhases()
  const { data: allTasks, refetch } = usePhaseTasks()
  const { data: workers } = useWorkers()
  const { data: allSubtasks } = useSubtasks()

  // เชนของ id ที่เลือกไว้ต่อชั้น: selectedChain[0] = phase (หรือ ALL_PHASES),
  // selectedChain[1] = subtask ชั้น 1 ที่เลือกใต้ phase นั้น, [2] = ชั้น 2, ...
  // ยาวเท่าที่ลึกจนถึง leaf ที่กำลังโฟกัสอยู่
  const [selectedChain, setSelectedChain] = useState(() => [ALL_PHASES])
  const [selectedZone, setSelectedZone] = useState('all')
  const [editingId, setEditingId] = useState(null) // task.id หรือ '__new__:<phaseId>:<status>'
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [dragOverKey, setDragOverKey] = useState(null) // `${phaseId}:${status}` -- บอร์ดหลายอันโชว์พร้อมกันได้ในโหมด "ทั้งหมด"

  const phases = useMemo(() => (allPhases || [])
    .filter((p) => p.site_id === site.id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)), [allPhases, site.id])

  // งานย่อย (Kanban) group ตาม "โหนดแม่" ที่แท้จริง -- ติดกับ subtask_id
  // ถ้ามี (แปลว่าติดอยู่กับ subtask ที่เป็น leaf) ไม่งั้นติดกับ phase_id ตรงๆ
  // (โหนดแม่คนละใบไม่มีทางชนกัน id เพราะมาจากคนละตาราง) -- โครงเดียวกับ
  // GanttView.jsx's microtasksByNodeId เป๊ะๆ (ก็อปมาเพราะไฟล์นี้แยกอิสระจากกัน)
  const microtasksByNodeId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => { const key = t.subtask_id || t.phase_id; (m[key] ||= []).push(t) })
    return m
  }, [allTasks])

  const subtasksByParent = useMemo(() => groupSubtasksByParent((allSubtasks || []).filter((s) => s.site_id === site.id)), [allSubtasks, site.id])

  // subtask id -> ตัวโหนดเอง (ใช้หา .phase_id ของ subtask ตอนสร้าง phase_tasks ใหม่)
  const byNodeId = useMemo(() => {
    const m = {}
    ;(allSubtasks || []).forEach((s) => { m[s.id] = s })
    return m
  }, [allSubtasks])

  const workerById = useMemo(() => {
    const m = {}
    ;(workers || []).forEach((w) => { m[w.id] = w })
    return m
  }, [workers])

  // เดินตาม chain ทีละชั้น หยุดที่ node สุดท้ายที่ระบุไว้จริง (ชั้นที่ยังไม่
  // ได้เลือกอะไรก็หยุดตรงนั้น) -- activeLeafId คือโหนดที่บอร์ดกำลังโฟกัส
  const isAllPhases = selectedChain[0] === ALL_PHASES
  const activeLeafId = isAllPhases ? null : selectedChain[selectedChain.length - 1]
  const activeLeafIsLeaf = activeLeafId ? isLeaf(activeLeafId, subtasksByParent) : false
  const leafMicrotasks = activeLeafId ? (microtasksByNodeId[activeLeafId] || []) : []

  useEffect(() => {
    if (!initialLeafId || !allSubtasks) return
    // เดินจาก leaf ย้อนกลับขึ้นไปหา phase เพื่อสร้าง chain ทั้งเส้น
    const chain = [initialLeafId]
    let cur = (allSubtasks || []).find((s) => s.id === initialLeafId)
    while (cur && cur.parent_subtask_id) {
      chain.unshift(cur.parent_subtask_id)
      cur = allSubtasks.find((s) => s.id === cur.parent_subtask_id)
    }
    const phaseId = cur ? cur.phase_id : initialLeafId
    setSelectedChain([phaseId, ...chain.filter((id) => id !== phaseId)])
  }, [initialLeafId, allSubtasks])

  const zones = useMemo(() => [...new Set(leafMicrotasks.map((t) => t.zone).filter(Boolean))].sort(), [leafMicrotasks])
  const effectiveZone = zones.includes(selectedZone) ? selectedZone : 'all'
  const visibleTasks = leafMicrotasks.filter((t) => effectiveZone === 'all' || t.zone === effectiveZone)

  // โหมด "ทั้งหมด" โชว์เฉพาะขั้นตอนที่มีงานย่อยติดอยู่กับตัวมันเองโดยตรง (ข้าม
  // ขั้นตอนว่างเปล่า เพื่อไม่ให้หน้าโหลดบอร์ดเปล่าๆ 7 อันจนงง) -- ขั้นตอนที่มี
  // ขั้นตอนย่อยข้างใน (งานย่อยไปติดอยู่กับ subtask ที่เป็น leaf แทน) จะไม่โชว์
  // อะไรเลยในโหมดนี้ (ข้อจำกัดที่รับทราบแล้ว -- เข้าไปดูผ่านการเลือก chip
  // ขั้นตอนนั้นแล้วไล่ chip ขั้นตอนย่อยลงไปแทน) -- ขั้นตอนที่ยังไม่มีงานเลย
  // ให้เข้าไปเพิ่มงานแรกผ่านการเลือก chip ขั้นตอนนั้นโดยตรง
  const phasesWithTasks = useMemo(() => phases.filter((p) => (microtasksByNodeId[p.id] || []).length > 0), [phases, microtasksByNodeId])

  const afterWrite = async () => {
    await refetch()
    onTasksChanged?.()
  }

  const startEdit = (task) => {
    setEditingId(task.id)
    const workerRows = task.phase_task_workers || []
    setDraft({
      // phase_id ที่เก็บใน draft คือ "โหนดเป้าหมาย" จริงๆ (phase หรือ leaf
      // subtask) ไม่ใช่ phase บรรพบุรุษเสมอไปอีกต่อไป -- ใช้ subtask_id ถ้ามี
      phase_id: task.subtask_id || task.phase_id, name: task.name, zone: task.zone || '', status: task.status,
      due_date: task.due_date || '', sort_order: task.sort_order,
      assigneeIds: workerRows.map((r) => r.worker_id),
      leadWorkerId: workerRows.find((r) => r.is_lead)?.worker_id || null,
    })
  }
  const startAdd = (nodeId, status) => {
    const tasks = microtasksByNodeId[nodeId] || []
    const sortOrder = tasks.length ? Math.max(...tasks.map((t) => t.sort_order || 0)) + 1 : 1
    setEditingId(`__new__:${nodeId}:${status}`)
    setDraft(emptyDraft(nodeId, status, sortOrder))
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
        // draft.phase_id คือโหนดเป้าหมายจริง (phase หรือ leaf subtask) --
        // phase_tasks ต้องได้ phase_id เป็น phase บรรพบุรุษสูงสุดเสมอ และ
        // subtask_id เฉพาะตอนเป้าหมายเป็น subtask จริงๆ (คอนเวนชันเดียวกับ
        // ที่ GanttView.jsx ใช้ตอนสร้าง phase_subtasks ใหม่)
        const isTargetPhase = phases.some((p) => p.id === draft.phase_id)
        const { data, error } = await supabase.from('phase_tasks')
          .insert({
            phase_id: isTargetPhase ? draft.phase_id : byNodeId[draft.phase_id].phase_id,
            subtask_id: isTargetPhase ? null : draft.phase_id,
            site_id: site.id, ...payload,
          })
          .select().single()
        if (error) throw error
        taskId = data.id
      } else {
        const { error } = await supabase.from('phase_tasks').update(payload).eq('id', editingId)
        if (error) throw error
      }
      if (draft.assigneeIds.length) {
        // upsert(ignoreDuplicates) adds anyone newly checked (with the
        // right is_lead already set) without touching rows that already
        // existed -- same non-destructive ordering as before (insert the
        // new set first, only delete what's no longer wanted, further
        // below), so a failure here never wipes an existing assignee.
        const { error: insErr } = await supabase.from('phase_task_workers')
          .upsert(draft.assigneeIds.map((worker_id) => ({ task_id: taskId, worker_id, is_lead: worker_id === draft.leadWorkerId })), { onConflict: 'task_id,worker_id', ignoreDuplicates: true })
        if (insErr) throw insErr
        // ignoreDuplicates means an assignee who was already on the task
        // keeps whatever is_lead value their row already had -- sync it
        // explicitly for the two people whose leader status can actually
        // change: clear it off everyone who isn't the new leader, then
        // set it on the new leader (a real UPDATE, now that phase_task_
        // workers has an admin_updates policy -- see migration -01).
        const { error: clearLeadErr } = await supabase.from('phase_task_workers')
          .update({ is_lead: false }).eq('task_id', taskId).neq('worker_id', draft.leadWorkerId || '00000000-0000-0000-0000-000000000000')
        if (clearLeadErr) throw clearLeadErr
        if (draft.leadWorkerId) {
          const { error: setLeadErr } = await supabase.from('phase_task_workers')
            .update({ is_lead: true }).eq('task_id', taskId).eq('worker_id', draft.leadWorkerId)
          if (setLeadErr) throw setLeadErr
        }
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
    setDraft((d) => {
      const nowChecked = !d.assigneeIds.includes(workerId)
      const assigneeIds = nowChecked ? [...d.assigneeIds, workerId] : d.assigneeIds.filter((id) => id !== workerId)
      // เอาคนออกจากทีมแล้ว ก็เอาสถานะหัวหน้าออกไปด้วย (เป็นหัวหน้าของทีมที่ไม่ได้อยู่ในนั้นไม่ได้)
      const leadWorkerId = !nowChecked && d.leadWorkerId === workerId ? null : d.leadWorkerId
      return { ...d, assigneeIds, leadWorkerId }
    })
  }

  const setLead = (workerId) => {
    setDraft((d) => ({ ...d, leadWorkerId: d.leadWorkerId === workerId ? null : workerId }))
  }

  if (!phases.length) {
    return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไซท์นี้ยังไม่มีขั้นตอนงาน — เพิ่มขั้นตอนก่อนในแท็บ Gantt</div>
  }

  const boardProps = {
    canEdit, workers: workers || [], workerById, editingId, draft, setDraft,
    onToggleAssignee: toggleAssignee, onSetLead: setLead, onStartEdit: startEdit, onStartAdd: startAdd,
    onCancelEdit: cancelEdit, onSaveDraft: saveDraft, onDeleteRequest: setConfirmDeleteId,
    onQuickMove: quickMove, saving, dragOverKey, setDragOverKey,
  }

  return (
    <div>
      {/* ยาว selectedChain.length + 1 เสมอ -- ชั้นสุดท้าย "พิเศษ" (ยังไม่มี
          ใน selectedChain) คือชั้นที่ให้เลือกลูกของโหนดที่เพิ่งเลือกไปหมาดๆ
          (ถ้ามีลูก) เพื่อให้กด chip แถวนั้นแล้วลึกลงไปได้เรื่อยๆ -- ไม่งั้น
          เลือกเฟสที่มีขั้นตอนย่อยแล้วจะตันทันที ไม่มีทางกด chip ขั้นตอนย่อย
          ชั้นแรกได้เลย (แถวนั้นยังไม่เคยมีอยู่ใน selectedChain มาก่อน) */}
      {Array.from({ length: selectedChain.length + 1 }, (_, tier) => {
        const selectedAtThisTier = selectedChain[tier]
        const parentId = tier === 0 ? null : selectedChain[tier - 1]
        const options = tier === 0 ? phases : (subtasksByParent[parentId] || [])
        if (tier > 0 && options.length === 0) return null // พ่อแม่ชั้นก่อนไม่มีลูกแล้ว ไม่ต้องโชว์แถวนี้
        return (
          <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
            {tier === 0 ? 'เฟส:' : 'ขั้นตอนย่อย:'}
            {tier === 0 && (
              <span onClick={() => setSelectedChain([ALL_PHASES])}
                style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer', background: isAllPhases ? 'var(--accent)' : 'transparent', color: isAllPhases ? '#fff' : 'var(--text2)' }}>
                🗂 ทั้งหมด
              </span>
            )}
            {options.map((n) => (
              <span key={n.id}
                onClick={() => setSelectedChain([...selectedChain.slice(0, tier), n.id])}
                style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer', background: selectedAtThisTier === n.id ? 'var(--accent)' : 'transparent', color: selectedAtThisTier === n.id ? '#fff' : 'var(--text2)' }}>
                {n.name}
              </span>
            ))}
          </div>
        )
      })}

      {isAllPhases ? (
        phasesWithTasks.length ? (
          phasesWithTasks.map((phase, i) => {
            // ปกติขั้นตอนที่มี child subtask แล้ว งานย่อยของมันควรถูกย้ายไปติด
            // subtask ที่เป็น leaf หมดแล้ว (ดู GanttView.jsx's "Kanban เก่า"
            // auto-move) แต่ถ้า step ที่สองของการย้ายนั้นพลาดไปครั้งใด หรือมี
            // การแก้ไขพร้อมกัน (race) ขั้นตอนนี้จะมีทั้งงานย่อยตรงๆ (subtask_id
            // NULL) และ child subtask ในเวลาเดียวกัน -- ไม่ใช่ leaf แต่ก็มี
            // งานย่อยติดอยู่ ยังต้องโชว์ให้จัดการได้ (ไม่ซ่อน ไม่ย้ายให้เอง)
            // แค่เตือนและห้ามเพิ่มงานใหม่ที่ผิดที่นี่อีก
            const phaseIsLeaf = isLeaf(phase.id, subtasksByParent)
            return (
              <div key={phase.id} style={{ marginTop: i > 0 ? 28 : 0, paddingTop: i > 0 ? 20 : 0, borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12 }}>{phase.name}</div>
                {!phaseIsLeaf && (
                  <div style={{ color: 'var(--amber, #d9a441)', fontSize: 12, marginBottom: 10 }}>
                    ⚠️ พบงานย่อยที่ไม่ได้อยู่ใต้ขั้นตอนย่อยใดๆ — อาจเกิดจากข้อผิดพลาดระหว่างการย้ายข้อมูล (แก้ไข/ย้ายงานเหล่านี้ได้ตามปกติ แต่เพิ่มงานใหม่ที่นี่ไม่ได้แล้ว — เลือกขั้นตอนย่อยจาก chip ด้านบนแทน)
                  </div>
                )}
                <PhaseBoard phaseId={phase.id} tasks={microtasksByNodeId[phase.id] || []} disableAdd={!phaseIsLeaf} {...boardProps} />
              </div>
            )
          })
        ) : (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
            ไซท์นี้ยังไม่มีงานย่อยเลย — เลือกขั้นตอนด้านบนแล้วกด "+ เพิ่มงาน" เพื่อเริ่ม
          </div>
        )
      ) : !activeLeafIsLeaf ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
          ขั้นตอนนี้มีขั้นตอนย่อยอยู่ข้างใน — เลือกขั้นตอนย่อยจาก chip ด้านบนต่อไปเรื่อยๆ จนถึงขั้นตอนย่อยสุดท้าย เพื่อดูหรือเพิ่มงานย่อย (Kanban)
        </div>
      ) : (
        <>
          {zones.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
              ชั้น:
              {['all', ...zones].map((z) => (
                <span key={z} onClick={() => setSelectedZone(z)}
                  style={{
                    border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer',
                    background: effectiveZone === z ? 'var(--accent)' : 'transparent',
                    color: effectiveZone === z ? '#fff' : 'var(--text2)',
                  }}>
                  {z === 'all' ? 'ทุกชั้น' : z}
                </span>
              ))}
            </div>
          )}
          <PhaseBoard phaseId={activeLeafId} tasks={visibleTasks} {...boardProps} />
        </>
      )}

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

function PhaseBoard({
  phaseId, tasks, canEdit, workers, workerById, editingId, draft, setDraft, onToggleAssignee, onSetLead,
  onStartEdit, onStartAdd, onCancelEdit, onSaveDraft, onDeleteRequest, onQuickMove, saving,
  dragOverKey, setDragOverKey, disableAdd,
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
      {COLUMNS.map((col) => {
        const key = `${phaseId}:${col.status}`
        const colTasks = tasks.filter((t) => t.status === col.status)
        const isNewHere = editingId === `__new__:${key}`
        return (
          <div key={col.status}
            onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOverKey(key) } : undefined}
            onDragLeave={canEdit ? () => setDragOverKey((k) => (k === key ? null : k)) : undefined}
            onDrop={canEdit ? (e) => {
              e.preventDefault()
              setDragOverKey(null)
              const taskId = e.dataTransfer.getData('text/plain')
              if (taskId) onQuickMove(taskId, col.status)
            } : undefined}
            style={{
              background: dragOverKey === key ? 'var(--bg3)' : 'transparent',
              borderRadius: 9, padding: 4, transition: 'background .1s',
            }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
              <span>{col.label}</span>
              <span style={{ background: 'var(--bg3)', borderRadius: 20, padding: '1px 8px', fontSize: 11, color: 'var(--text3)' }}>{colTasks.length}</span>
            </div>

            {colTasks.map((task) => {
              const workerRows = task.phase_task_workers || []
              const leadRow = workerRows.find((r) => r.is_lead)
              const leadWorker = leadRow ? workerById[leadRow.worker_id] : null
              const otherAssignees = workerRows
                .filter((r) => !r.is_lead)
                .map((r) => workerById[r.worker_id])
                .filter(Boolean)
              if (editingId === task.id) {
                return (
                  <TaskEditPanel key={task.id} draft={draft} setDraft={setDraft} workers={workers}
                    onToggleAssignee={onToggleAssignee} onSetLead={onSetLead} onCancel={onCancelEdit} onSave={onSaveDraft}
                    onDelete={() => onDeleteRequest(task.id)} saving={saving} />
                )
              }
              return (
                <div key={task.id}
                  draggable={canEdit}
                  onDragStart={canEdit ? (e) => e.dataTransfer.setData('text/plain', task.id) : undefined}
                  onClick={canEdit ? () => onStartEdit(task) : undefined}
                  style={{
                    background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `3px solid ${STATUS_COLOR[task.status] || STATUS_COLOR.not_started}`,
                    borderRadius: 9, padding: '11px 13px', marginBottom: 10, boxShadow: 'var(--shadow)', cursor: canEdit ? 'pointer' : 'default',
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{task.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    {task.zone
                      ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', background: 'rgba(78,205,196,.14)', borderRadius: 20, padding: '2px 9px' }}>{task.zone}</span>
                      : <span />}
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {leadWorker && (
                        <span title={`👑 หัวหน้าทีม: ${leadWorker.nickname || leadWorker.name}`}
                          style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--yellow)', color: '#3a2f0e', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--yellow)', boxShadow: '0 0 0 1px var(--bg2)' }}>
                          {(leadWorker.nickname || leadWorker.name || '?').slice(0, 2)}
                        </span>
                      )}
                      {otherAssignees.map((w) => (
                        <span key={w.id} title={w.nickname || w.name} style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {(w.nickname || w.name || '?').slice(0, 2)}
                        </span>
                      ))}
                      {!leadWorker && !otherAssignees.length && <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>ยังไม่มอบหมาย</span>}
                    </div>
                  </div>
                </div>
              )
            })}

            {isNewHere && (
              <TaskEditPanel draft={draft} setDraft={setDraft} workers={workers}
                onToggleAssignee={onToggleAssignee} onSetLead={onSetLead} onCancel={onCancelEdit} onSave={onSaveDraft} saving={saving} isNew />
            )}

            {canEdit && !editingId && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%' }}
                disabled={disableAdd}
                title={disableAdd ? 'ขั้นตอนนี้มีขั้นตอนย่อยแล้ว — เพิ่มงานผ่านขั้นตอนย่อย (chip ด้านบน) แทน' : undefined}
                onClick={() => onStartAdd(phaseId, col.status)}>+ เพิ่มงาน</button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TaskEditPanel({ draft, setDraft, workers, onToggleAssignee, onSetLead, onCancel, onSave, onDelete, saving, isNew }) {
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
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>มอบหมายให้ — กด 👑 เพื่อตั้งเป็นหัวหน้าทีม (เลือกได้คนเดียว)</div>
      <div style={{ maxHeight: 140, overflowY: 'auto', display: 'grid', gap: 2, marginBottom: 8, background: 'var(--bg3)', borderRadius: 6, padding: 8 }}>
        {workers.map((w) => {
          const checked = draft.assigneeIds.includes(w.id)
          const isLead = draft.leadWorkerId === w.id
          return (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer' }}>
                <input type="checkbox" checked={checked} onChange={() => onToggleAssignee(w.id)} />
                {w.nickname || w.name}
              </label>
              {checked && (
                <button type="button" onClick={() => onSetLead(w.id)}
                  title={isLead ? 'เอาออกจากหัวหน้าทีม' : 'ตั้งเป็นหัวหน้าทีม'}
                  style={{
                    border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 4px',
                    opacity: isLead ? 1 : 0.35, filter: isLead ? 'none' : 'grayscale(1)',
                  }}>
                  👑
                </button>
              )}
            </div>
          )
        })}
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
