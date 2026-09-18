// ============================================================
// GanttView — สองมุมมอง: หลายไซท์ (1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว, ใช้
// ในหน้ารายการไซท์แบบภาพรวม) กับไซท์เดียว (1 แถวต่อขั้นตอน พร้อมแกนเดือน,
// ใช้ในหน้า SiteDetail — sites.length === 1 สลับโหมดอัตโนมัติ)
// + ลูกศร dependency (soft) + แก้ไขขั้นตอนได้ในหน้านี้เลย (ไซท์เดียว) +
// เทมเพลตขั้นตอนงานแบบเพิ่มเมื่อต้องการ (ไม่ auto-seed ทุกไซท์แล้ว) +
// สถานะขั้นตอนที่มี phase_tasks (Kanban) คำนวณสดจากงานย่อย ไม่ใช่ตั้งเอง
// ============================================================
import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { useSitePhases, usePhaseTasks, useSubtasks, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { computeTimelineRange, positionPercent, barStyle, computeDependencyArrows, computeDependencyArrowsByRow, computeMonthTicks, STATUS_COLOR, PHASE_TEMPLATE, expandRangeForTransactions } from './ganttTimeline.js'
import { groupSubtasksByParent, computeNodeStats, isLeaf, flattenVisibleRows, siblingWeightSum } from './subtaskCalc.js'
import { getEffectiveTheme } from '../../lib/theme.js'

const ROW_H = 34
const EDIT_H = 320
const LABEL_W = 170
const GAP = 8
const EDIT_BTN_W = 28
const TODAY_ISO = new Date().toISOString().slice(0, 10)
// สำหรับมุมมองหลายไซท์ (portfolio) ไม่ต้องขยาย timeline ตามรายรับ/รายจ่าย
// ของไซท์ใดไซท์หนึ่ง -- ใช้ UUID ปลอมนี้เป็น siteId filter เพื่อให้ hook ดึงมา
// 0 แถวเสมอ (ยังคงเรียก hook เดิมแบบไม่มีเงื่อนไข ตาม Rules of Hooks)
const NIL_SITE_ID = '00000000-0000-0000-0000-000000000000'

const STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จแล้ว' },
]

// editingId แทนด้วย string เข้ารหัสไว้ (ไม่ใช้ object) เพื่อคง pattern
// `editingId === someId` แบบเดิมของไฟล์นี้ให้มากที่สุด:
//   "phase:<id>"                      -- แก้ไข phase เดิม
//   "subtask:<id>"                    -- แก้ไข subtask เดิม
//   "new-phase"                       -- เพิ่ม phase ใหม่ระดับบนสุด
//   "new-subtask:<parentKind>:<parentId>" -- เพิ่ม subtask ใหม่ ใต้ parentKind
//                                         ('phase' หรือ 'subtask') id=parentId
const parseEditingId = (editingId) => {
  if (!editingId) return null
  if (editingId === 'new-phase') return { kind: 'phase', isNew: true }
  if (editingId.startsWith('new-subtask:')) {
    const [, parentKind, parentId] = editingId.split(':')
    return { kind: 'subtask', isNew: true, parentKind, parentId }
  }
  const [kind, id] = editingId.split(':')
  return { kind, id, isNew: false }
}

const emptyDraft = (sortOrder) => ({
  name: '', start_date: '', end_date: '', status: 'not_started',
  billing_weight_pct: 0, depends_on_id: '', sort_order: sortOrder,
})

export default function GanttView({ sites, navigateTo, onManagePhases, selectedSiteId, onSelectSite, canEdit, onPhasesChanged, onOpenKanban }) {
  const { data: allPhases, refetch: refetchPhases } = useSitePhases()
  const { data: allTasks, refetch: refetchTasks } = usePhaseTasks()
  const { data: allSubtasks, refetch: refetchSubtasks } = useSubtasks()
  const singleSiteId = sites.length === 1 ? sites[0].id : NIL_SITE_ID
  const { data: incomesForRange } = useIncomes({ siteId: singleSiteId })
  const { data: expensesForRange } = useExpenses({ siteId: singleSiteId })

  // แก้ไข/เพิ่ม/ลบขั้นตอนแบบ inline (ใช้เฉพาะมุมมองไซท์เดียว) -- hooks ต้อง
  // อยู่บนสุดเสมอ ไม่ผูกกับ branch ไหน
  const [editingId, setEditingId] = useState(null) // ดู parseEditingId ด้านบนสำหรับรูปแบบ string ที่ใช้
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null) // { kind: 'phase'|'subtask', id }
  const [applyingTemplate, setApplyingTemplate] = useState(false)

  // id ของ phase/subtask ที่กางลูกอยู่ (Set รวม id ทั้งสองตารางในที่เดียว
  // เพราะไม่มีทางชนกัน -- ดู subtaskCalc.js's groupSubtasksByParent)
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const toggleExpanded = (nodeId) => setExpandedIds((prev) => {
    const next = new Set(prev)
    if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
    return next
  })

  // SVG presentation attributes (stroke=...) don't resolve CSS var() --
  // only real CSS property values do -- so derive a literal hex color here
  // instead, following Dashboard.jsx's chartColors pattern.
  const isDarkChart = getEffectiveTheme() === 'dark'
  const arrowColor = isDarkChart ? '#5c5f80' : '#928c7a'

  const phasesBySite = useMemo(() => {
    const m = {}
    ;(allPhases || []).forEach((p) => {
      if (!m[p.site_id]) m[p.site_id] = []
      m[p.site_id].push(p)
    })
    return m
  }, [allPhases])

  // งานย่อย (Kanban) group ตาม "โหนดแม่" ที่แท้จริง -- ติดกับ subtask_id
  // ถ้ามี (แปลว่าติดอยู่กับ subtask ที่เป็น leaf) ไม่งั้นติดกับ phase_id ตรงๆ
  // (โหนดแม่คนละใบไม่มีทางชนกัน id เพราะมาจากคนละตาราง)
  const microtasksByNodeId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => {
      const key = t.subtask_id || t.phase_id
      ;(m[key] ||= []).push(t)
    })
    return m
  }, [allTasks])

  // subtask ทุกไซท์ -- filter เฉพาะของไซท์นี้ในมุมมองไซท์เดียวด้านล่าง
  const subtasksBySite = useMemo(() => {
    const m = {}
    ;(allSubtasks || []).forEach((s) => { (m[s.site_id] ||= []).push(s) })
    return m
  }, [allSubtasks])

  // ทุก subtask ทุกไซท์ group ตาม parent id เดียว (phase หรือ subtask) --
  // คำนวณครั้งเดียวทั้งระบบ (ข้อมูลเล็ก, รูปแบบเดียวกับ phasesBySite ด้านบน)
  // แล้วใช้ซ้ำในทุกไซท์แทนการคำนวณใหม่ต่อไซท์
  const subtasksByParent = useMemo(() => groupSubtasksByParent(allSubtasks || []), [allSubtasks])

  // phase หรือ subtask id (คนละตาราง ไม่มีทางชนกัน) -> ตัวโหนดเอง, ครอบคลุม
  // ทุกไซท์ (เหมือน subtasksByParent ด้านบน) -- ต้องอยู่ระดับบนสุดของ
  // component เพราะ saveDraft (ก็อยู่ระดับบนสุดเช่นกัน, เรียกจาก onClick ใน
  // มุมมองไซท์เดียวด้านล่าง) ต้องใช้หา parentPhaseId ตอนเพิ่ม subtask ใหม่
  // ใต้ subtask อีกอันหนึ่ง
  const byNodeId = useMemo(() => {
    const m = {}
    ;(allPhases || []).forEach((p) => { m[p.id] = p })
    ;(allSubtasks || []).forEach((s) => { m[s.id] = s })
    return m
  }, [allPhases, allSubtasks])

  const baseRange = useMemo(() => computeTimelineRange(sites, phasesBySite), [sites, phasesBySite])

  // ขยาย range ให้ครอบคลุมวันที่รายรับ/รายจ่ายจริงด้วย (ไม่ใช่แค่วันที่ตั้งไว้
  // ในขั้นตอน) -- ใช้ฟังก์ชันเดียวกับ SCurveChart.jsx กับรายรับ/รายจ่ายชุด
  // เดียวกัน ให้สองกราฟได้ timeline เดียวกันเป๊ะๆ เสมอ ไม่มีทางเพี้ยนต่างกัน
  // (ในมุมมองหลายไซท์ singleSiteId เป็น UUID ปลอม ทำให้ incomesForRange/
  // expensesForRange ว่างเสมอ ฟังก์ชันนี้จึงคืนค่า baseRange เดิมโดยไม่ขยาย)
  const transactionDatesForRange = useMemo(() => [
    ...(incomesForRange || []).map((i) => i.date),
    ...(expensesForRange || []).map((e) => e.date),
  ], [incomesForRange, expensesForRange])
  const range = useMemo(() => expandRangeForTransactions(baseRange, transactionDatesForRange), [baseRange, transactionDatesForRange])

  // ไซท์เดียว + แก้ไขได้: เก็บ sites.start_date/end_date ให้ตรงกับ timeline
  // ที่ Gantt แสดงจริงเสมอ (ช่วงที่ขยายแล้ว รวมวันที่รายรับ/รายจ่ายด้วย) --
  // ใช้เป็นค่า "วันเริ่ม/วันจบงาน" ที่แสดงในหน้าภาพรวมไซท์ และวันครบกำหนด
  // เงินประกันผลงานคำนวณต่อจาก end_date นี้ ไม่ต้องแก้ไขเองแยกที่หน้าอื่น
  // อีกต่อไป -- เขียนเฉพาะตอนค่าจริงต่างจากที่คำนวณได้ เพื่อไม่ยิง UPDATE ซ้ำ
  useEffect(() => {
    if (sites.length !== 1 || !canEdit || !range) return
    const site = sites[0]
    const newStart = range.start.toISOString().slice(0, 10)
    const newEnd = range.end.toISOString().slice(0, 10)
    if (site.start_date === newStart && site.end_date === newEnd) return
    supabase.from('sites').update({ start_date: newStart, end_date: newEnd }).eq('id', site.id)
      .then(({ error }) => { if (error) console.error('sync site start/end date failed:', error.message) })
  }, [sites, canEdit, range])

  // ทุกจุดเขียนในไฟล์นี้อาจแตะ site_phases, phase_subtasks และ (ตอนย้าย
  // "Kanban เก่า") phase_tasks พร้อมกัน -- useQuery แต่ละตัวเป็น state
  // อิสระ ไม่มี cache กลาง ต้อง refetch ครบทั้งสามตารางเสมอ ไม่งั้นข้อมูล
  // ที่แสดงในไฟล์นี้ (subtasksByParent, byNodeId, microtasksByNodeId) จะ
  // ค้างจนกว่าจะมีอย่างอื่นมา trigger refetch
  const afterWrite = async () => {
    await Promise.all([refetchPhases(), refetchSubtasks(), refetchTasks()])
    onPhasesChanged?.()
  }

  const startEdit = (kind, node) => {
    setEditingId(`${kind}:${node.id}`)
    setDraft({
      ...node,
      depends_on_id: kind === 'phase' ? (node.depends_on_phase_id || '') : (node.depends_on_subtask_id || ''),
    })
  }
  const startAdd = (parentKind, parentId, sortOrder) => {
    setEditingId(parentKind ? `new-subtask:${parentKind}:${parentId}` : 'new-phase')
    setDraft(emptyDraft(sortOrder))
    // กางโหนดแม่ให้อัตโนมัติ เพื่อให้เห็นแถวฟอร์ม "เพิ่มขั้นตอนย่อย" ที่กำลัง
    // จะโผล่ขึ้นมาใต้มันทันที (ไม่งั้นถ้าโหนดแม่ยังหุบอยู่ ผู้ใช้จะไม่เห็น
    // ฟอร์มเลยแม้จะ splice เข้าไปใน visibleRows ถูกตำแหน่งแล้วก็ตาม)
    if (parentId) setExpandedIds((prev) => (prev.has(parentId) ? prev : new Set(prev).add(parentId)))
  }
  const cancelEdit = () => { setEditingId(null); setDraft(null) }

  const saveDraft = async (site) => {
    if (!draft.name.trim()) { alert('กรุณาตั้งชื่อขั้นตอน'); return }
    const parsed = parseEditingId(editingId)
    const isSubtask = parsed.kind === 'subtask'

    // hard-block: ผลรวม % เบิกเงินของ "พี่น้อง" ใต้พ่อแม่เดียวกันต้องไม่เกิน
    // 100 -- ตรวจก่อนเขียนเสมอ ทั้งตอนแก้ subtask เดิมและเพิ่มใหม่ (นี่คือ
    // ข้อยกเว้นเจตนาจาก convention ปกติของแอปนี้ที่ "เตือนแต่ยังให้บันทึก
    // ได้" -- ค่านี้เป็นผลรวมที่ของอื่นต้องพึ่งพา จึงบล็อกจริง ไม่ใช่แค่เตือน)
    if (isSubtask) {
      const parentId = parsed.isNew ? parsed.parentId : (draft.parent_subtask_id || draft.phase_id)
      const excludeId = parsed.isNew ? null : parsed.id
      const already = siblingWeightSum(parentId, subtasksByParent, excludeId)
      const thisWeight = parseFloat(draft.billing_weight_pct) || 0
      if (already + thisWeight > 100) {
        alert(`% เบิกเงินรวมของขั้นตอนย่อยใต้พ่อแม่เดียวกันเกิน 100% (มีอยู่แล้ว ${already}% + ${thisWeight}% ที่กำลังบันทึก) — กรุณาปรับตัวเลข`)
        return
      }
    }

    setSaving(true)
    try {
      if (!isSubtask) {
        // ── Phase (site_phases) -- เหมือนเดิมทุกประการ ──
        const payload = {
          name: draft.name.trim(), start_date: draft.start_date || null, end_date: draft.end_date || null,
          status: draft.status, billing_weight_pct: parseFloat(draft.billing_weight_pct) || 0,
          depends_on_phase_id: draft.depends_on_id || null, sort_order: draft.sort_order,
        }
        if (parsed.isNew) {
          const { error } = await supabase.from('site_phases').insert({ site_id: site.id, ...payload })
          if (error) throw error
        } else {
          const { error } = await supabase.from('site_phases').update(payload).eq('id', parsed.id)
          if (error) throw error
        }
      } else {
        // ── Subtask (phase_subtasks) ──
        const parentId = parsed.isNew ? parsed.parentId : (draft.parent_subtask_id || draft.phase_id)
        const parentKind = parsed.isNew ? parsed.parentKind : (draft.parent_subtask_id ? 'subtask' : 'phase')
        const parentPhaseId = parentKind === 'phase' ? parentId : byNodeId[parentId].phase_id
        const payload = {
          name: draft.name.trim(), start_date: draft.start_date || null, end_date: draft.end_date || null,
          status: draft.status, billing_weight_pct: parseFloat(draft.billing_weight_pct) || 0,
          depends_on_subtask_id: draft.depends_on_id || null, sort_order: draft.sort_order,
        }
        if (parsed.isNew) {
          const { error } = await supabase.from('phase_subtasks').insert({
            site_id: site.id, phase_id: parentPhaseId,
            parent_subtask_id: parentKind === 'subtask' ? parentId : null,
            ...payload,
          })
          if (error) throw error

          // โหนดแม่มีงานย่อย (Kanban) ติดอยู่โดยตรงอยู่แล้ว และนี่คือลูกใบ
          // แรกที่เพิ่มให้มัน -- ย้ายงานย่อยเดิมไปไว้ใน subtask ใหม่ชื่อ
          // "Kanban เก่า" (สร้างแยกจาก subtask ที่ผู้ใช้กำลังตั้งชื่อ ไม่ปน
          // กัน) แทนที่จะบล็อกหรือทำหาย -- สร้างที่เก็บใหม่ก่อน ค่อย repoint
          // ของเดิมเข้าไป (ปลอดภัยถ้า step หลังพลาด ของเดิมก็แค่ยังอยู่ที่เดิม)
          const existingMicrotasks = microtasksByNodeId[parentId] || []
          const wasFirstChild = (subtasksByParent[parentId] || []).length === 0
          if (existingMicrotasks.length > 0 && wasFirstChild) {
            const { data: oldHolder, error: holderErr } = await supabase.from('phase_subtasks').insert({
              site_id: site.id, phase_id: parentPhaseId,
              parent_subtask_id: parentKind === 'subtask' ? parentId : null,
              name: 'Kanban เก่า', start_date: null, end_date: null, billing_weight_pct: 0,
              status: 'not_started', sort_order: (draft.sort_order || 0) + 1,
            }).select().single()
            if (holderErr) throw holderErr
            const { error: moveErr } = await supabase.from('phase_tasks')
              .update({ subtask_id: oldHolder.id })
              .in('id', existingMicrotasks.map((t) => t.id))
            if (moveErr) throw moveErr
          }
        } else {
          const { error } = await supabase.from('phase_subtasks').update(payload).eq('id', parsed.id)
          if (error) throw error
        }
      }
      await afterWrite()
      cancelEdit()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (kind, id) => {
    setSaving(true)
    try {
      const table = kind === 'phase' ? 'site_phases' : 'phase_subtasks'
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) throw error
      await afterWrite()
      if (editingId === `${kind}:${id}`) cancelEdit()
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
      setConfirmDeleteId(null)
    }
  }

  const applyTemplate = async (site) => {
    setApplyingTemplate(true)
    try {
      const rows = PHASE_TEMPLATE.map((t) => ({ site_id: site.id, ...t }))
      const { error } = await supabase.from('site_phases').insert(rows)
      if (error) throw error
      await afterWrite()
    } catch (e) {
      alert('เพิ่มเทมเพลตไม่สำเร็จ: ' + e.message)
    } finally {
      setApplyingTemplate(false)
    }
  }

  // ── ไซท์เดียว: 1 แถวต่อขั้นตอน (หน้า SiteDetail) ──
  if (sites.length === 1) {
    const site = sites[0]
    const phases = phasesBySite[site.id] || []
    const parsed = parseEditingId(editingId)
    // ต้นไม้ที่มองเห็นได้จริง (phase + subtask ที่กางอยู่ ลึกเท่าไหร่ก็ได้) +
    // แถว "กำลังเพิ่ม" (ถ้ามี) แทรกเข้าไปในตำแหน่งที่ถูกต้อง:
    //   - เพิ่ม phase ใหม่ (parsed.parentId ว่าง) -> ต่อท้ายสุด เหมือนเดิม
    //   - เพิ่ม subtask ใหม่ใต้โหนดใดโหนดหนึ่ง -> แทรกทันทีหลังลูกๆ ที่
    //     มองเห็นอยู่แล้วของโหนดแม่นั้น (หรือทันทีหลังตัวโหนดแม่เอง ถ้ายังไม่
    //     มีลูกที่มองเห็น) ที่ depth ของแม่ + 1 -- โหนดแม่ต้องมองเห็นอยู่แล้ว
    //     เสมอเพราะปุ่ม "+" ต่อแถว (startAdd) และ dropdown "เพิ่มภายใต้" (ทั้ง
    //     สองจุดที่ตั้ง editingId แบบนี้) เลือกได้เฉพาะโหนดที่กำลังแสดงอยู่
    //     เท่านั้น
    const visibleRows = flattenVisibleRows(phases, subtasksByParent, expandedIds)
    if (parsed?.isNew) {
      if (!parsed.parentId) {
        visibleRows.push({ node: { id: 'new-phase', isNew: true }, depth: 0, isPhase: true })
      } else {
        const parentIdx = visibleRows.findIndex((r) => r.node.id === parsed.parentId)
        const parentDepth = parentIdx >= 0 ? visibleRows[parentIdx].depth : 0
        let insertAt = parentIdx >= 0 ? parentIdx + 1 : visibleRows.length
        while (insertAt < visibleRows.length && visibleRows[insertAt].depth > parentDepth) insertAt++
        visibleRows.splice(insertAt, 0, { node: { id: 'new-subtask', isNew: true }, depth: parentDepth + 1, isPhase: false })
      }
    }

    // สถานะ/% เบิกเงินที่ "แสดงจริง" ต่อโหนด (phase หรือ subtask ชั้นไหนก็ได้):
    // มี subtask ลูก -> คำนวณสดจากลูก (ซ้ำไปเรื่อยๆ); ไม่มีลูกแต่มี
    // phase_tasks (Kanban) -> คำนวณสดจากงานย่อย; ไม่มีทั้งคู่ -> ใช้ค่าที่
    // ตั้งเอง (ไม่มี regression กับ node ที่ยังไม่มี subtask เลย)
    const nodeStatsById = {}
    const collectStats = (node) => {
      const stats = computeNodeStats(node.id, subtasksByParent, microtasksByNodeId)
      const displayStatus = stats.derivedStatus != null ? stats.derivedStatus : node.status
      const displayWeight = stats.billingWeightPct != null ? stats.billingWeightPct : node.billing_weight_pct
      nodeStatsById[node.id] = { stats, displayStatus, displayWeight }
      ;(subtasksByParent[node.id] || []).forEach(collectStats)
    }
    phases.forEach(collectStats)

    if (!phases.length && !editingId) {
      return (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ color: 'var(--text3)', marginBottom: 14 }}>ไซท์นี้ยังไม่มีขั้นตอนงาน</div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={applyingTemplate} onClick={() => applyTemplate(site)}>
                {applyingTemplate ? '⏳ กำลังเพิ่ม...' : '+ เริ่มใช้ Gantt (เทมเพลตขั้นตอนงาน)'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(null, null, phases.length + 1)}>+ เพิ่มขั้นตอนเอง</button>
            </div>
          )}
        </div>
      )
    }

    const monthTicks = range ? computeMonthTicks(range) : []
    // phases-array index and visibleRows index are the SAME only when
    // nothing is expanded -- expanding any ancestor inserts subtask rows
    // between phases, shifting every phase after it down. Arrows must be
    // positioned against the ACTUAL on-screen row, so resolve each phase's
    // row via this id->visibleRows-index map instead of trusting its
    // position in the flat `phases` array.
    const nodeIdToVisibleRowIndex = {}
    visibleRows.forEach((r, i) => { nodeIdToVisibleRowIndex[r.node.id] = i })
    const arrows = editingId ? [] : computeDependencyArrowsByRow(phases, range, nodeIdToVisibleRowIndex)
    // Bar rows lay out as [label: LABEL_W][gap: GAP][track: flex 1][gap+edit
    // button, only when canEdit]. The header ticks, grid lines, and arrow
    // overlay used to hardcode `left: LABEL_W` (missing GAP) and ignore the
    // edit button entirely -- landing them a few to ~25px off from where
    // the actual bar track renders, worse the further right you look. All
    // four elements now share this exact track geometry so they can't drift
    // apart again.
    const trackLeft = LABEL_W + GAP
    const trackRight = 0
    const doneCount = phases.filter((p) => nodeStatsById[p.id].displayStatus === 'done').length
    const inProgressCount = phases.filter((p) => nodeStatsById[p.id].displayStatus === 'in_progress').length
    const overallPct = phases.length ? Math.round((doneCount / phases.length) * 100) : 0
    // Same reasoning as SCurveChart's todayInRange guard: only draw "today"
    // when it actually falls inside this site's own timeline, otherwise a
    // clamped line at 0%/100% would falsely read as "today = start/end".
    const todayInRange = range && range.start <= new Date(TODAY_ISO) && new Date(TODAY_ISO) <= range.end
    const todayX = todayInRange ? positionPercent(TODAY_ISO, range) : null

    // ยอดสะสมตามแนวตั้ง: แถวที่กำลังแก้ไข/เพิ่ม จะสูงกว่าแถวปกติ เพื่อดัน
    // แถวถัดไปลงแทนที่จะซ้อนทับ (เดิมใช้ i*ROW_H คงที่ ตอนนี้ต้องคำนวณสะสม)
    let cursor = 0
    const rowTops = visibleRows.map(({ node, isPhase }) => {
      const top = cursor
      const isEditingThis = node.isNew || (!!editingId && editingId === `${isPhase ? 'phase' : 'subtask'}:${node.id}`)
      cursor += isEditingThis ? ROW_H + EDIT_H : ROW_H
      return top
    })
    const bodyHeight = Math.max(cursor, ROW_H)

    return (
      <>
        <div className="kpi-grid kpi-grid-4">
          <div className="kpi-card green">
            <div className="kpi-label">ความคืบหน้ารวม</div>
            <div className="kpi-value">{overallPct}%</div>
            <div className="progress" style={{ marginTop: 8 }}><div className="progress-bar" style={{ width: `${overallPct}%` }} /></div>
          </div>
          <div className="kpi-card"><div className="kpi-label">เฟสทั้งหมด</div><div className="kpi-value">{phases.length}</div></div>
          <div className="kpi-card yellow"><div className="kpi-label">กำลังทำอยู่</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{inProgressCount}</div></div>
          <div className="kpi-card green"><div className="kpi-label">เสร็จแล้ว</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{doneCount}</div></div>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div className="card-title">ไทม์ไลน์เฟสงาน</div>
            {canEdit && !editingId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(null, null, phases.length + 1)}>+ เพิ่มขั้นตอน</button>
            )}
          </div>
          {monthTicks.length > 0 && (
            <div style={{ position: 'relative', height: 20, marginLeft: trackLeft, marginRight: trackRight }}>
              {monthTicks.map((t, i) => (
                <div key={i} style={{ position: 'absolute', left: `${t.x}%`, fontSize: 10.5, color: 'var(--text3)', transform: 'translateX(-50%)' }}>
                  {format(t.date, 'MMM yy', { locale: th })}
                </div>
              ))}
            </div>
          )}
          <div style={{ position: 'relative', height: bodyHeight }}>
            {monthTicks.length > 0 && (
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: trackLeft, right: trackRight, pointerEvents: 'none' }}>
                {monthTicks.map((t, i) => (
                  <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${t.x}%`, width: 1, background: 'var(--border)' }} />
                ))}
              </div>
            )}
            {visibleRows.map(({ node, depth, isPhase }, i) => {
              const top = rowTops[i]
              const isEditingThis = node.isNew || (!!editingId && editingId === `${isPhase ? 'phase' : 'subtask'}:${node.id}`)
              const style = node.isNew ? null : barStyle(node, range)
              const ns = nodeStatsById[node.id]
              const nodeIsLeaf = isLeaf(node.id, subtasksByParent)
              const hasChildren = !node.isNew && !nodeIsLeaf

              if (isEditingThis) {
                const phase = node
                return (
                  <div key={node.id} style={{ position: 'absolute', top, left: 0, right: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', height: ROW_H, gap: 8 }}>
                      <input
                        className="input input-sm" style={{ flex: 1, fontWeight: 600 }}
                        value={draft.name} placeholder="ชื่อขั้นตอน" autoFocus
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      />
                    </div>
                    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 4, display: 'grid', gap: 8 }}>
                      {parsed.isNew && (
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          เพิ่มภายใต้
                          <select className="select" style={{ width: '100%', marginTop: 2 }}
                            value={parsed.parentKind ? `${parsed.parentKind}:${parsed.parentId}` : ''}
                            onChange={(e) => {
                              const v = e.target.value
                              if (!v) { setEditingId('new-phase'); return }
                              const [pk, pid] = v.split(':')
                              setEditingId(`new-subtask:${pk}:${pid}`)
                            }}>
                            <option value="">— ไม่มี (ขั้นตอนใหม่ระดับบนสุด) —</option>
                            {visibleRows.filter((r) => !r.node.isNew).map(({ node: n, isPhase: nIsPhase, depth: nDepth }) => (
                              <option key={n.id} value={`${nIsPhase ? 'phase' : 'subtask'}:${n.id}`}>
                                {'　'.repeat(nDepth)}{n.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          เริ่ม
                          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.start_date || ''} onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value }))} />
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          สิ้นสุด
                          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.end_date || ''} onChange={(e) => setDraft((d) => ({ ...d, end_date: e.target.value }))} />
                        </label>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          สถานะ
                          {ns && ns.stats.total > 0 ? (
                            <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text2)', padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
                              คำนวณอัตโนมัติจากงานย่อย ({ns.stats.done}/{ns.stats.total} เสร็จ)
                            </div>
                          ) : (
                            <select className="select" style={{ width: '100%', marginTop: 2 }}
                              value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
                              {STATUS_OPTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                          )}
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          % เบิกเงิน
                          {ns && ns.stats.source === 'subtasks' ? (
                            <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text2)', padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
                              คำนวณอัตโนมัติจากขั้นตอนย่อย ({ns.displayWeight}%)
                            </div>
                          ) : (
                            <input type="number" min="0" max="100" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                              value={draft.billing_weight_pct} onChange={(e) => setDraft((d) => ({ ...d, billing_weight_pct: e.target.value }))} />
                          )}
                        </label>
                      </div>
                      <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                        ขึ้นอยู่กับขั้นตอน
                        <select className="select" style={{ width: '100%', marginTop: 2 }}
                          value={draft.depends_on_id || ''} onChange={(e) => setDraft((d) => ({ ...d, depends_on_id: e.target.value }))}>
                          <option value="">— ไม่ขึ้นกับขั้นตอนอื่น —</option>
                          {(parsed.kind === 'phase'
                            ? phases.filter((p) => p.id !== parsed.id)
                            : (subtasksByParent[parsed.isNew ? parsed.parentId : (draft.parent_subtask_id || draft.phase_id)] || []).filter((s) => s.id !== parsed.id)
                          ).map((n) => (
                            <option key={n.id} value={n.id}>{n.name || '(ยังไม่ตั้งชื่อ)'}</option>
                          ))}
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
                        {!phase.isNew && (
                          <button type="button" className="btn btn-sm btn-danger" style={{ marginRight: 'auto' }}
                            disabled={saving} onClick={() => setConfirmDeleteId({ kind: parsed.kind, id: parsed.id })}>🗑 ลบ</button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={cancelEdit}>ยกเลิก</button>
                        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => saveDraft(site)}>
                          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              }

              const displayStatus = ns ? ns.displayStatus : node.status
              const label = displayStatus === 'done' ? '✓'
                : displayStatus === 'in_progress' ? (ns && ns.stats.total > 0 ? `${ns.stats.pct}%` : 'กำลังทำ')
                : ''
              const titleSuffix = ns && ns.stats.total > 0 ? ` (${ns.stats.done}/${ns.stats.total} ${ns.stats.source === 'subtasks' ? 'ขั้นตอนย่อยเสร็จ' : 'งานย่อยเสร็จ'})` : ''

              return (
                <div key={node.id} style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: LABEL_W, flexShrink: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: depth * 16 }} title={node.name}>
                    {node.name}
                  </div>
                  <div
                    style={{ position: 'relative', flex: 1, height: 20, background: 'var(--bg3)', borderRadius: 5, cursor: hasChildren || nodeIsLeaf ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (node.isNew) return
                      if (hasChildren) toggleExpanded(node.id)
                      else if (nodeIsLeaf) onOpenKanban?.(site, node, isPhase)
                    }}
                  >
                    {style && (
                      <div
                        title={`${node.name}\n${node.start_date} → ${node.end_date}\nสถานะ: ${displayStatus}${titleSuffix}`}
                        style={{
                          position: 'absolute', top: 2, bottom: 2, left: style.left, width: style.width,
                          background: STATUS_COLOR[displayStatus] || STATUS_COLOR.not_started, borderRadius: 5,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 700, color: displayStatus === 'not_started' ? 'var(--text3)' : '#fff',
                          overflow: 'hidden', whiteSpace: 'nowrap',
                        }}
                      >
                        {hasChildren ? (expandedIds.has(node.id) ? '▾ ' : '▸ ') : ''}{label}
                      </div>
                    )}
                    {/* Floats over the track's right edge instead of taking
                        a flex slot next to it -- so the track's own width
                        always matches trackLeft/trackRight (no per-row
                        canEdit-dependent shrinkage the header/grid/arrows
                        would have to separately account for). ✎ edit and +
                        add-subtask buttons both apply to every row (phase or
                        subtask) now -- + sits to the left of ✎ so they never
                        overlap. */}
                    {canEdit && !editingId && (
                      <button type="button" className="btn btn-sm btn-ghost"
                        style={{
                          position: 'absolute', top: '50%', right: 2, transform: 'translateY(-50%)',
                          width: EDIT_BTN_W, padding: '2px 0', opacity: 0.85,
                        }}
                        onClick={(e) => { e.stopPropagation(); startEdit(isPhase ? 'phase' : 'subtask', node) }}>✎</button>
                    )}
                    {canEdit && !editingId && (
                      <button type="button" className="btn btn-sm btn-ghost"
                        style={{ position: 'absolute', top: '50%', right: EDIT_BTN_W + 6, transform: 'translateY(-50%)', width: EDIT_BTN_W, padding: '2px 0', opacity: 0.85 }}
                        title="เพิ่มขั้นตอนย่อยใต้นี้"
                        onClick={(e) => { e.stopPropagation(); startAdd(isPhase ? 'phase' : 'subtask', node.id, ((subtasksByParent[node.id] || []).length) + 1) }}>
                        +
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {arrows.length > 0 && (
              <svg
                // Explicit width (not just left+right) -- SVG is a CSS
                // "replaced element", so an absolutely-positioned one with
                // left+right but no width falls back to sizing itself from
                // the viewBox's intrinsic aspect ratio instead of the
                // containing block, blowing up to ~14x too wide (100:7
                // viewBox stretched to the row height) and pushing the
                // whole drawing off-screen.
                style={{ position: 'absolute', top: 0, left: trackLeft, width: `calc(100% - ${trackLeft + trackRight}px)`, bottom: 0, height: '100%', pointerEvents: 'none' }}
                preserveAspectRatio="none" viewBox={`0 0 100 ${visibleRows.length}`}
              >
                {arrows.map((a, i) => {
                  // Elbow-routed (horizontal/vertical only, no diagonal):
                  // out from the predecessor's end, across at the midpoint,
                  // into the successor's start.
                  const fromY = a.fromRow + 0.5
                  const toY = a.toRow + 0.5
                  const midX = (a.fromX + a.toX) / 2
                  const d = `M ${a.fromX} ${fromY} H ${midX} V ${toY} H ${a.toX}`
                  return (
                    <path
                      key={i} d={d} fill="none"
                      stroke={arrowColor} strokeWidth="1.4" strokeDasharray="1 0.8" vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </svg>
            )}
            {todayX != null && !editingId && (
              <div style={{ position: 'absolute', top: 0, left: LABEL_W, right: 0, bottom: 0, pointerEvents: 'none' }}>
                <div style={{ position: 'absolute', top: -16, left: `${todayX}%`, transform: 'translateX(-50%)', fontSize: 9.5, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                  วันนี้
                </div>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${todayX}%`, borderLeft: '1px dashed var(--text3)' }} />
              </div>
            )}
          </div>
          <div className="legend" style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--text2)' }}>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--green)' }} />เสร็จแล้ว</span>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--yellow)' }} />กำลังทำ</span>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--text3)' }} />ยังไม่เริ่ม</span>
          </div>
        </div>

        {confirmDeleteId && (
          <ConfirmDialog
            title="ลบขั้นตอนงาน"
            message="ต้องการลบขั้นตอนนี้ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้"
            danger
            onCancel={() => setConfirmDeleteId(null)}
            onConfirm={() => doDelete(confirmDeleteId.kind, confirmDeleteId.id)}
          />
        )}
      </>
    )
  }

  // ── หลายไซท์: 1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว (หน้ารายการไซท์) ──
  if (!range) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่มีไซท์ที่มีวันที่ให้แสดงบน Gantt
      </div>
    )
  }

  return (
    <div className="card">
      {sites.map((site) => {
        const phases = phasesBySite[site.id] || []
        const arrows = computeDependencyArrows(phases, range)
        const isSelected = selectedSiteId === site.id
        return (
          <div
            key={site.id}
            onClick={() => onSelectSite(site.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              background: isSelected ? 'var(--bg2)' : 'transparent',
            }}
          >
            <div style={{ width: 180, flexShrink: 0 }}>
              <div
                style={{ fontWeight: 600, fontSize: 13, textDecoration: 'underline dotted' }}
                onClick={(e) => { e.stopPropagation(); navigateTo('assign', { siteId: site.id, siteName: site.name }) }}
                title="ไปหน้า Assign ของไซท์นี้"
              >
                {site.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--accent)' }}>{site.site_number}</div>
            </div>
            <div style={{ position: 'relative', flex: 1, height: 28, background: 'var(--bg2)', borderRadius: 4 }}>
              {phases.map((phase) => {
                const style = barStyle(phase, range)
                if (!style) return null
                return (
                  <div
                    key={phase.id}
                    title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${phase.status}`}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      left: style.left,
                      width: style.width,
                      background: STATUS_COLOR[phase.status] || STATUS_COLOR.not_started,
                      borderRadius: 3,
                    }}
                  />
                )
              })}
              {arrows.length > 0 && (
                <svg
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                  preserveAspectRatio="none" viewBox="0 0 100 28"
                >
                  {arrows.map((a, i) => (
                    <line
                      key={i}
                      x1={a.fromX} y1={14} x2={a.toX} y2={14}
                      stroke={arrowColor} strokeWidth="0.6" strokeDasharray="1.5 1"
                    />
                  ))}
                </svg>
              )}
            </div>
            {canEdit && (
              <button
                className="btn btn-sm btn-ghost"
                style={{ flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); onManagePhases(site) }}
              >
                📋 จัดการขั้นตอน
              </button>
            )}
          </div>
        )
      })}
      {!sites.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไม่พบข้อมูลไซท์งาน</div>
      )}
    </div>
  )
}
