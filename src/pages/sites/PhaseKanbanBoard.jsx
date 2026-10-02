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
import { Modal, ConfirmDialog } from '../../components/Modal.jsx'
import { useSitePhases, usePhaseTasks, useWorkers, useSubtasks, useSites } from '../../hooks/useSupabase.js'
import { STATUS_COLOR } from './ganttTimeline.js'
import { groupSubtasksByParent, isLeaf } from './subtaskCalc.js'
import teamLeaderBadge from '../../assets/team-leader-badge.png'
import { uploadSitePhotos, bangkokTodayIso } from '../../lib/photoUpload.js'
import { useTenant } from '../../hooks/useTenant.js'

const ALL_PHASES = '__all__'

const COLUMNS = [
  { status: 'not_started', label: 'ยังไม่เริ่ม' },
  { status: 'in_progress', label: 'กำลังทำ' },
  { status: 'done', label: 'เสร็จแล้ว' },
]

const PHOTO_DRAG_MIME = 'application/x-line-site-photo-id'

const emptyDraft = (phaseId, status, sortOrder) => ({
  phase_id: phaseId, name: '', zone: '', status, due_date: '', sort_order: sortOrder, assigneeIds: [], leadWorkerId: null,
})

export default function PhaseKanbanBoard({ site, canEdit, onTasksChanged, initialLeafId }) {
  const { data: allPhases } = useSitePhases()
  const { data: allTasks, refetch } = usePhaseTasks()
  const { data: workers } = useWorkers()
  const { data: allSubtasks } = useSubtasks()
  const { data: allSites } = useSites()
  const { tenant } = useTenant()

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

  // งานเสร็จ ที่ส่งรูปแนบมาผ่านไลน์ (line_site_photos.task_id) -- ต่างจาก
  // รูปภาพหน้างานทั่วไปตรงที่ผูกกับ task โดยตรง เลยเอามาโชว์เป็น badge
  // บนการ์ดที่ตรงกันได้จริง (ไม่ใช่แค่ผูกกับไซต์เหมือนรูปทั่วไป/แจ้งปัญหา).
  // ดึงครั้งเดียวทั้งไซต์แทนที่จะยิงต่อการ์ด เพื่อไม่ให้ query ระเบิดตามจำนวนการ์ด.
  const [taskPhotoCounts, setTaskPhotoCounts] = useState({})
  const [viewingPhotosTaskId, setViewingPhotosTaskId] = useState(null)
  const [viewingPhotosTaskName, setViewingPhotosTaskName] = useState('')
  const [viewingPhotos, setViewingPhotos] = useState([])
  const [loadingViewPhotos, setLoadingViewPhotos] = useState(false)
  const [selectedPhotoIds, setSelectedPhotoIds] = useState(() => new Set())
  const [showSwitchSitePicker, setShowSwitchSitePicker] = useState(false)
  const [confirmBulkDeletePhotos, setConfirmBulkDeletePhotos] = useState(false)
  const [bulkActing, setBulkActing] = useState(false)

  const [unassignedPhotos, setUnassignedPhotos] = useState([])
  const [loadingPhotos, setLoadingPhotos] = useState(true)
  const [uploadingBulk, setUploadingBulk] = useState(false)
  const [assigningPhotoId, setAssigningPhotoId] = useState(null)
  const [myWorkerId, setMyWorkerId] = useState(null)

  useEffect(() => {
    let cancelled = false
    supabase.rpc('my_worker_id').then(({ data }) => { if (!cancelled) setMyWorkerId(data || null) })
    return () => { cancelled = true }
  }, [])

  // Per-task photo counts (📷 badge) AND the site's unassigned-photo tray
  // both come from line_site_photos -- fetched together so one refresh
  // (after an upload or a drag-assign) keeps both in sync. fetchPhotos
  // itself does no state writes so the mount effect below can guard
  // against a stale write after site.id changes; refreshPhotos (called
  // after a user action, when the component is definitely still mounted)
  // just applies the result directly.
  const fetchPhotos = async () => {
    const [{ data: assignedRows }, { data: unassignedRows }] = await Promise.all([
      supabase.from('line_site_photos').select('task_id').eq('site_id', site.id).not('task_id', 'is', null),
      supabase.from('line_site_photos').select('id, photo_path, workers(name, nickname), created_at').eq('site_id', site.id).is('task_id', null).order('created_at', { ascending: false }).limit(40),
    ])
    const counts = {}
    ;(assignedRows || []).forEach((r) => { counts[r.task_id] = (counts[r.task_id] || 0) + 1 })
    const rows = unassignedRows || []
    const paths = rows.map((p) => p.photo_path)
    let urlByPath = {}
    if (paths.length) {
      const { data: signed } = await supabase.storage.from('line-site-photos').createSignedUrls(paths, 3600)
      urlByPath = Object.fromEntries((signed || []).filter((s) => !s.error).map((s) => [s.path, s.signedUrl]))
    }
    return { counts, unassigned: rows.map((p) => ({ ...p, url: urlByPath[p.photo_path] })) }
  }

  useEffect(() => {
    let cancelled = false
    setLoadingPhotos(true)
    fetchPhotos().then(({ counts, unassigned }) => {
      if (cancelled) return
      setTaskPhotoCounts(counts)
      setUnassignedPhotos(unassigned)
      setLoadingPhotos(false)
    })
    return () => { cancelled = true }
  }, [site.id])

  const refreshPhotos = async () => {
    const { counts, unassigned } = await fetchPhotos()
    setTaskPhotoCounts(counts)
    setUnassignedPhotos(unassigned)
  }

  // วันนี้ ไซท์นี้ใครเป็นหัวหน้าทีม -- read-only display จาก
  // worker_assignments.is_team_leader (Assign Wizard เป็นจุดที่ตั้งค่านี้),
  // ไม่เกี่ยวกับ leadWorkerId ต่อการ์ดด้านบน (คนละ concept กัน)
  const [todayLeaders, setTodayLeaders] = useState({ morning: null, evening: null })
  useEffect(() => {
    let cancelled = false
    const todayIso = new Date().toISOString().slice(0, 10)
    supabase.from('worker_assignments').select('shift, workers(name, nickname)')
      .eq('site_id', site.id).eq('date', todayIso).eq('is_team_leader', true)
      .then(({ data }) => {
        if (cancelled) return
        const next = { morning: null, evening: null }
        ;(data || []).forEach((r) => { next[r.shift] = r.workers?.nickname || r.workers?.name || null })
        setTodayLeaders(next)
      })
    return () => { cancelled = true }
  }, [site.id])

  const handleViewPhotos = async (task, e) => {
    e.stopPropagation() // ไม่ให้ trigger onClick ของการ์ด (เปิด edit panel)
    setViewingPhotosTaskId(task.id)
    setViewingPhotosTaskName(task.name)
    setSelectedPhotoIds(new Set())
    setShowSwitchSitePicker(false)
    setLoadingViewPhotos(true)
    const { data } = await supabase.from('line_site_photos').select('id, photo_path, workers(name, nickname), created_at')
      .eq('task_id', task.id).order('created_at')
    const rows = data || []
    const paths = rows.map((p) => p.photo_path)
    let urlByPath = {}
    if (paths.length) {
      const { data: signed } = await supabase.storage.from('line-site-photos').createSignedUrls(paths, 3600)
      urlByPath = Object.fromEntries((signed || []).filter((s) => !s.error).map((s) => [s.path, s.signedUrl]))
    }
    setViewingPhotos(rows.map((p) => ({ ...p, url: urlByPath[p.photo_path] })))
    setLoadingViewPhotos(false)
  }

  const handleTogglePhotoSelected = (photoId) => {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev)
      if (next.has(photoId)) next.delete(photoId)
      else next.add(photoId)
      return next
    })
  }

  // Bulk switch-site: moves every selected photo to a different site and
  // clears task_id (the destination site's cards are different from this
  // one's -- the photo becomes "unassigned" there, same as a fresh LINE
  // upload, ready to be dragged onto a card via that site's own tray).
  // Single batched UPDATE (.in), not a loop -- same convention as the
  // single-photo handleAssignPhoto above re: alert()-on-failure, no
  // optimistic UI update before the request settles.
  const handleBulkSwitchSite = async (newSiteId) => {
    const ids = Array.from(selectedPhotoIds)
    if (!ids.length) return
    setBulkActing(true)
    try {
      const { error } = await supabase.from('line_site_photos')
        .update({ site_id: newSiteId, task_id: null }).in('id', ids)
      if (error) throw error
      setShowSwitchSitePicker(false)
      setSelectedPhotoIds(new Set())
      await handleViewPhotos({ id: viewingPhotosTaskId, name: viewingPhotosTaskName }, { stopPropagation: () => {} })
      await refreshPhotos()
    } catch (e) {
      alert('ย้ายไซต์ไม่สำเร็จ: ' + e.message)
    } finally {
      setBulkActing(false)
    }
  }

  // Bulk delete: storage.remove() accepts an array directly, and the
  // table delete uses .in() -- both single batched calls, not per-photo
  // loops. Storage files are removed first; if that fails we stop before
  // touching the DB rows (never want a live row with no photo behind it).
  const doBulkDeletePhotos = async () => {
    const ids = Array.from(selectedPhotoIds)
    if (!ids.length) return
    setConfirmBulkDeletePhotos(false)
    setBulkActing(true)
    try {
      const paths = viewingPhotos.filter((p) => selectedPhotoIds.has(p.id)).map((p) => p.photo_path)
      if (paths.length) {
        const { error: storageError } = await supabase.storage.from('line-site-photos').remove(paths)
        if (storageError) throw storageError
      }
      const { error } = await supabase.from('line_site_photos').delete().in('id', ids)
      if (error) throw error
      setSelectedPhotoIds(new Set())
      setViewingPhotos((prev) => prev.filter((p) => !selectedPhotoIds.has(p.id)))
      await refreshPhotos()
    } catch (e) {
      alert('ลบรูปไม่สำเร็จ: ' + e.message)
    } finally {
      setBulkActing(false)
    }
  }

  const handleBulkUpload = async (e) => {
    const files = e.target.files
    if (!files || !files.length) return
    if (!myWorkerId) { alert('ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้ — กรุณาติดต่อผู้ดูแลระบบ'); e.target.value = ''; return }
    if (!tenant?.id) { alert('กำลังโหลดข้อมูลบริษัท กรุณาลองใหม่อีกครั้ง'); e.target.value = ''; return }
    setUploadingBulk(true)
    try {
      const { failed } = await uploadSitePhotos(files, {
        tenantId: tenant.id, workerId: myWorkerId, siteId: site.id, taskId: null,
        date: bangkokTodayIso(),
      })
      if (failed.length) alert(`อัปโหลดไม่สำเร็จ ${failed.length} ไฟล์: ${failed.map((f) => f.file.name).join(', ')}`)
      await refreshPhotos()
    } finally {
      setUploadingBulk(false)
      e.target.value = ''
    }
  }

  // Called from a task card's onDrop when a photo (not another card) was
  // dropped on it -- see the PHOTO_DRAG_MIME check in PhaseBoard below.
  // A failed update never calls refreshPhotos, so the photo simply stays
  // in the tray exactly as it was (never optimistically removed before
  // the request settles) -- satisfies the spec's "don't silently lose
  // the photo on failure" intent via this file's own existing alert()
  // convention (every other write in this file -- saveDraft, doDelete,
  // quickMove -- already surfaces failures the same way) rather than a
  // new per-item inline-error UI this file has no other precedent for.
  const handleAssignPhoto = async (photoId, taskId) => {
    setAssigningPhotoId(photoId)
    try {
      const { error } = await supabase.from('line_site_photos').update({ task_id: taskId }).eq('id', photoId)
      if (error) throw error
      await refreshPhotos()
    } catch (e) {
      alert('มอบหมายรูปไม่สำเร็จ: ' + e.message)
    } finally {
      setAssigningPhotoId(null)
    }
  }

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
    taskPhotoCounts, onViewPhotos: handleViewPhotos, onAssignPhoto: handleAssignPhoto,
  }

  return (
    <div>
      {(todayLeaders.morning || todayLeaders.evening) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10,
          padding: '8px 14px', borderRadius: 8, background: 'rgba(255,193,7,.08)', border: '1px solid rgba(255,193,7,.3)',
        }}>
          <img src={teamLeaderBadge} alt="หัวหน้าทีม" style={{ width: 24, height: 24, objectFit: 'contain', flex: 'none' }} />
          {todayLeaders.morning && <span style={{ fontSize: 12.5 }}>🌅 เช้า: <b>{todayLeaders.morning}</b></span>}
          {todayLeaders.evening && <span style={{ fontSize: 12.5 }}>🌆 บ่าย: <b>{todayLeaders.evening}</b></span>}
        </div>
      )}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: unassignedPhotos.length ? 10 : 0, flexWrap: 'wrap', gap: 8 }}>
          <div className="card-title">📷 รูปที่รอมอบหมาย{unassignedPhotos.length > 0 ? ` (${unassignedPhotos.length})` : ''}</div>
          {canEdit && (
            <label className="btn btn-ghost btn-sm" style={{ cursor: uploadingBulk ? 'default' : 'pointer' }}>
              {uploadingBulk ? '⏳ กำลังอัปโหลด...' : '+ อัปโหลดรูป'}
              <input type="file" accept="image/*" multiple hidden disabled={uploadingBulk || !tenant?.id} onChange={handleBulkUpload} />
            </label>
          )}
        </div>
        {loadingPhotos ? (
          <div style={{ color: 'var(--text3)', fontSize: 12 }}>กำลังโหลด...</div>
        ) : unassignedPhotos.length > 0 ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {unassignedPhotos.map((p) => (
              <div key={p.id}
                draggable={canEdit}
                onDragStart={canEdit ? (e) => e.dataTransfer.setData(PHOTO_DRAG_MIME, p.id) : undefined}
                title={`${p.workers?.nickname || p.workers?.name || ''} · ลากไปวางบนการ์ดเพื่อมอบหมาย`}
                style={{ width: 90, opacity: assigningPhotoId === p.id ? 0.5 : 1, cursor: canEdit ? 'grab' : 'default' }}>
                {p.url ? (
                  <img src={p.url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '1', borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--text3)' }}>โหลดไม่สำเร็จ</div>
                )}
                <div style={{ fontSize: 9.5, marginTop: 3, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.workers?.nickname || p.workers?.name || '-'}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
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

      {confirmBulkDeletePhotos && (
        <ConfirmDialog
          title="ลบรูปภาพ"
          message={`ลบรูป ${selectedPhotoIds.size} รูปที่เลือกไว้? การลบนี้ย้อนกลับไม่ได้`}
          danger
          onCancel={() => setConfirmBulkDeletePhotos(false)}
          onConfirm={doBulkDeletePhotos}
        />
      )}

      {viewingPhotosTaskId && (
        <Modal title={`📷 รูปหลักฐานงานเสร็จ — ${viewingPhotosTaskName}`} onClose={() => setViewingPhotosTaskId(null)} maxWidth={520}>
          <div className="modal-body">
            {canEdit && selectedPhotoIds.size > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 10px',
                background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--border)', flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>เลือกไว้ {selectedPhotoIds.size} รูป</span>
                {showSwitchSitePicker ? (
                  <select
                    autoFocus
                    disabled={bulkActing}
                    defaultValue=""
                    onChange={(e) => { if (e.target.value) handleBulkSwitchSite(e.target.value) }}
                    style={{ fontSize: 13, padding: '4px 6px' }}
                  >
                    <option value="" disabled>เลือกไซต์ปลายทาง...</option>
                    {(allSites || []).filter((s) => s.id !== site.id).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                ) : (
                  <button type="button" className="btn-secondary" disabled={bulkActing} onClick={() => setShowSwitchSitePicker(true)} style={{ fontSize: 13 }}>
                    📍 ย้ายไซต์
                  </button>
                )}
                <button type="button" className="btn-secondary" disabled={bulkActing} onClick={() => setConfirmBulkDeletePhotos(true)} style={{ fontSize: 13, color: 'var(--red)' }}>
                  🗑️ ลบ
                </button>
                <button type="button" className="btn-secondary" disabled={bulkActing} onClick={() => { setSelectedPhotoIds(new Set()); setShowSwitchSitePicker(false) }} style={{ fontSize: 13, marginLeft: 'auto' }}>
                  ยกเลิก
                </button>
              </div>
            )}
            {loadingViewPhotos ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
            ) : !viewingPhotos.length ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>ไม่มีรูปภาพ</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
                {viewingPhotos.map((p) => (
                  <div key={p.id} style={{ position: 'relative' }}>
                    {canEdit && (
                      <input
                        type="checkbox"
                        checked={selectedPhotoIds.has(p.id)}
                        onChange={() => handleTogglePhotoSelected(p.id)}
                        style={{ position: 'absolute', top: 6, left: 6, width: 18, height: 18, zIndex: 1, cursor: 'pointer' }}
                      />
                    )}
                    <a href={p.url} target="_blank" rel="noreferrer" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                      {p.url ? (
                        <img src={p.url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                      ) : (
                        <div style={{ width: '100%', aspectRatio: '1', borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--text3)' }}>โหลดรูปไม่สำเร็จ</div>
                      )}
                      <div style={{ fontSize: 10.5, marginTop: 3, color: 'var(--text3)' }}>
                        {p.workers?.nickname || p.workers?.name || '-'} · {new Date(p.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}
                      </div>
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

function PhaseBoard({
  phaseId, tasks, canEdit, workers, workerById, editingId, draft, setDraft, onToggleAssignee, onSetLead,
  onStartEdit, onStartAdd, onCancelEdit, onSaveDraft, onDeleteRequest, onQuickMove, saving,
  dragOverKey, setDragOverKey, disableAdd, taskPhotoCounts, onViewPhotos, onAssignPhoto,
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
                  onDragOver={canEdit ? (e) => { if (e.dataTransfer.types.includes(PHOTO_DRAG_MIME)) e.preventDefault() } : undefined}
                  onDrop={canEdit ? (e) => {
                    const photoId = e.dataTransfer.getData(PHOTO_DRAG_MIME)
                    if (!photoId) return // not a photo drag -- let it bubble to the column's own onDrop (card-to-column move)
                    e.preventDefault()
                    e.stopPropagation()
                    onAssignPhoto(photoId, task.id)
                  } : undefined}
                  onClick={canEdit ? () => onStartEdit(task) : undefined}
                  style={{
                    background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `3px solid ${STATUS_COLOR[task.status] || STATUS_COLOR.not_started}`,
                    borderRadius: 9, padding: '11px 13px', marginBottom: 10, boxShadow: 'var(--shadow)', cursor: canEdit ? 'pointer' : 'default',
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{task.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {task.zone && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', background: 'rgba(78,205,196,.14)', borderRadius: 20, padding: '2px 9px' }}>{task.zone}</span>
                      )}
                      {taskPhotoCounts[task.id] > 0 && (
                        <span title="ดูรูปหลักฐานงานเสร็จ" onClick={(e) => onViewPhotos(task, e)}
                          style={{ fontSize: 10, fontWeight: 700, color: 'var(--green)', background: 'rgba(0,212,170,.14)', borderRadius: 20, padding: '2px 9px', cursor: 'pointer' }}>
                          📷 {taskPhotoCounts[task.id]}
                        </span>
                      )}
                    </div>
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
