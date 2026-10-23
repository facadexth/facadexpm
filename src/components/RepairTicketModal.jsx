// Detail modal of one repair ticket (งานซ่อม), opened from the board (src/pages/Repairs.jsx).
//   ticketId    -- repair_tickets.id
//   onClose()   -- closed and nothing was saved
//   onChanged() -- closed after something was saved; the board reloads
// Sections: header (number, site, warranty, site status, status pills + in-between moves),
// จากลูกค้า (description), นัดหมาย (date, time, hours, crew -> worker_assignments,
// optional LINE push), ผลการซ่อม (before/after photos, fix note, ปิดงาน + report push).
// Status changes go through movePatch (ruling R22). A push never undoes a saved schedule or close.
// Customer media (role 'customer') is shown in the ก่อนซ่อม gallery with a ลูกค้า tag (beforeGallery).
// Opening a ticket the customer added to from LINE marks the addition seen (board badge + bell).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from './Modal.jsx'
import { useWorkers } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { canEditPage } from '../lib/permissions.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import { formatThaiDate } from '../lib/thaiDate.js'
import { REPAIR_STATUS, canMove, startTime } from '../lib/repairStatus.js'
import { movePatch, warrantyOf, bangkokDateOf, hasUnseenCustomerUpdate, beforeGallery } from '../lib/repairBoard.js'
import { planRepairAssignments, repairShifts } from '../lib/repairAssign.js'
import { uploadRepairPhotos, REPAIR_BUCKET } from '../lib/repairUpload.js'
import { invokeRepairPush, customerPushDefault } from '../lib/repairPush.js'
import { releasesCrew, removeFutureUnconfirmedCrew } from '../lib/repairCrew.js'

const SIGNED_URL_SECONDS = 3600
const PILL_STEPS = ['pending_review', 'received', 'scheduled', 'in_progress', 'done']
const SHIFT_TH = { morning: 'เช้า', evening: 'บ่าย' }
const NOTIFY_LABEL = 'ส่งไลน์แจ้งนัดให้ลูกค้าเมื่อบันทึก + เตือนก่อน 1 วัน (13:00)'
const RESEND_CONFIRM = 'ส่งรายงานซ้ำให้ลูกค้า? (ใช้โควต้าไลน์ 1 ข้อความ)'
const NOTICE_CLASS = { success: 'alert-success', warning: 'alert-warning', error: 'alert-error', info: 'alert-info' }

// In-between moves offered as buttons. received -> scheduled is the นัดหมาย save, in_progress -> done is ปิดงาน.
const MOVE_LABEL = {
  'pending_review>received': 'เปิดงานซ่อม',
  'pending_review>declined': 'ไม่รับ',
  'received>declined': 'ไม่รับ',
  'scheduled>in_progress': 'เริ่มซ่อม',
  'scheduled>received': 'ย้อนกลับ: รับเรื่อง',
  'in_progress>scheduled': 'ย้อนกลับ: นัดเข้า',
  'done>in_progress': 'เปิดงานอีกครั้ง (กำลังซ่อม)',
}
export const CONFIRM_MOVE = {
  declined: 'ไม่รับงานซ่อมนี้? ช่างที่จองไว้ตั้งแต่วันนี้ (ที่ยังไม่เช็คอิน) จะถูกถอนออก ดูย้อนหลังได้จากตัวกรอง "ไม่รับ" บนบอร์ด',
  'scheduled>received': 'ย้อนกลับเป็น "รับเรื่อง"? ช่างที่จองไว้ตั้งแต่วันนี้ (ที่ยังไม่เช็คอิน) จะถูกถอนออก',
  'done>in_progress': 'เปิดงานที่เสร็จแล้วกลับมาเป็น "กำลังซ่อม"? วันที่เสร็จจะถูกล้าง ปิดงานใหม่แล้วส่งรายงานซ้ำได้',
}

const bkkTime = (iso) => {
  const ms = Date.parse(iso || '')
  return Number.isNaN(ms) ? '' : new Date(ms + 7 * 3600 * 1000).toISOString().slice(11, 16)
}
const workerLabel = (w) => (w ? `${w.name || '-'}${w.nickname ? ` (${w.nickname})` : ''}` : '-')
const box = { width: 84, height: 84, borderRadius: 8, overflow: 'hidden', flex: '0 0 auto', border: '1px solid var(--border)', background: 'var(--bg3)' }
const sec = { fontSize: 14, fontWeight: 700, marginTop: 4 }
const customerTag = {
  position: 'absolute', left: 3, top: 3, fontSize: 10, fontWeight: 700, lineHeight: 1.4, padding: '0 5px',
  borderRadius: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', pointerEvents: 'none',
}

function WarrantyPill({ ticket, today }) {
  const w = warrantyOf(ticket, today)
  if (w.kind === 'active') return <span className="badge badge-accepted" style={{ cursor: 'default' }}>ในประกัน ถึง {formatThaiDate(w.end)}</span>
  if (w.kind === 'expired') return <span className="badge badge-expired" style={{ cursor: 'default' }}>หมดประกัน {formatThaiDate(w.end)}</span>
  if (w.kind === 'none') return <span className="badge badge-expired" style={{ cursor: 'default' }}>ไม่มีประกัน</span>
  return <span className="badge badge-draft" style={{ cursor: 'default' }}>ยังไม่ส่งมอบ</span>
}

// One gallery tile: image (opens the lightbox), inline video, or a file download link.
function mediaTile(m, url, onOpenImage) {
  if (m.media_type === 'image') {
    return (
      <button key={m.id} type="button" title={m.file_name || ''} onClick={() => url && onOpenImage(url)}
        style={{ ...box, padding: 0, cursor: url ? 'zoom-in' : 'default' }}>
        {url ? <img src={url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : '🖼️'}
      </button>
    )
  }
  if (m.media_type === 'video') {
    return url
      ? <video key={m.id} src={url} controls preload="metadata" style={{ width: 200, height: 112, borderRadius: 8, background: '#000' }} />
      : <div key={m.id} style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎬</div>
  }
  return (
    <a key={m.id} href={url || undefined} target="_blank" rel="noreferrer" download={m.file_name || true}
      style={{ ...box, width: 'auto', minWidth: 84, maxWidth: 200, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)', textDecoration: 'none' }}>
      📄 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.file_name || 'ไฟล์'}</span>
    </a>
  )
}

function MediaTiles({ items, urls, onOpenImage, onAdd, adding }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
      {items.map((m) => {
        const tile = mediaTile(m, urls[m.storage_path], onOpenImage)
        // Customer media sits in the ก่อนซ่อม gallery; a small tag tells it apart from the crew's photos.
        return m.fromCustomer
          ? <div key={m.id} style={{ position: 'relative', display: 'flex' }}>{tile}<span style={customerTag}>ลูกค้า</span></div>
          : tile
      })}
      {onAdd && (
        <label style={{ ...box, border: '2px dashed var(--border)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: adding ? 12 : 22, color: 'var(--text3)', cursor: adding ? 'wait' : 'pointer' }}
          title="เพิ่มรูป">
          {adding ? 'กำลังอัปโหลด…' : '+'}
          <input type="file" accept="image/*" multiple hidden disabled={adding}
            onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) onAdd(f) }} />
        </label>
      )}
      {items.length === 0 && !onAdd && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ไม่มี</span>}
    </div>
  )
}

const conflictBtn = { minHeight: 44, flex: '1 1 180px' }

// Crew already busy on the chosen date (schedule_repair_ticket returned conflicts). เขียนทับ re-calls the RPC
// with p_overwrite; a checked-in conflict cannot be moved, so เขียนทับ stays disabled while that worker is ticked.
export function ConflictBox({ conflicts, workerIds, nameOf, busy, onOverwrite, onCancel }) {
  const line = (c) => `• ${nameOf(c.worker_id)} — กะ${SHIFT_TH[c.shift] || c.shift}: ${c.label || c.type || 'งานอื่น'}`
  const movable = conflicts.list.filter((c) => !c.checked_in)
  const checkedIn = conflicts.list.filter((c) => c.checked_in)
  const blocked = checkedIn.some((c) => workerIds.includes(c.worker_id))
  return (
    <div role="alert" style={{ border: '1px solid var(--orange, #dd6b20)', background: 'rgba(221,107,32,0.1)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <div style={{ fontWeight: 700 }}>ช่างมีงานอื่นในวันที่ {formatThaiDate(conflicts.date)} อยู่แล้ว</div>
      {movable.map((c) => <div key={`${c.worker_id}|${c.shift}`} style={{ overflowWrap: 'anywhere' }}>{line(c)}</div>)}
      {checkedIn.length > 0 && (
        <>
          <div style={{ fontWeight: 700, color: 'var(--red)' }}>เช็คอินแล้ว — ย้ายไม่ได้</div>
          {checkedIn.map((c) => <div key={`ci|${c.worker_id}|${c.shift}`} style={{ overflowWrap: 'anywhere' }}>{line(c)}</div>)}
          {blocked && <div style={{ fontSize: 12, color: 'var(--red)' }}>เอาช่างที่เช็คอินแล้วออกจากทีมก่อน แล้วกดเขียนทับ</div>}
        </>
      )}
      <div>กด "เขียนทับ" เพื่อย้ายช่างมางานซ่อมนี้ งานเดิมของกะนั้นจะถูกถอนออก</div>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>ช่างที่เช็คอินงานเดิมไปแล้ว จะไม่ถูกย้าย (ต้องเอาออกเอง)</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-warning" style={{ ...conflictBtn, fontWeight: 700 }} disabled={busy || blocked} onClick={onOverwrite}>เขียนทับ แล้วบันทึกนัด</button>
        <button type="button" className="btn btn-ghost" style={conflictBtn} disabled={busy} onClick={onCancel}>ยกเลิก (เลือกช่างใหม่)</button>
      </div>
    </div>
  )
}

export default function RepairTicketModal({ ticketId, onClose, onChanged }) {
  const { role, isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'repairs')
  const { data: workers } = useWorkers()
  // Crew booking writes worker_assignments, which RLS limits to tenants with the payroll module.
  const { hasModuleAccess, loading: tenantLoading } = useTenant()
  const hasCrew = !tenantLoading && hasModuleAccess('payroll')
  const today = bangkokTodayIso()

  const [ticket, setTicket] = useState(null)
  const [media, setMedia] = useState([])
  const [urls, setUrls] = useState({})
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(null) // { kind, text }
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(null) // 'before' | 'after'
  const [changed, setChanged] = useState(false)
  const [lightbox, setLightbox] = useState(null) // signed image URL
  const [confirmMove, setConfirmMove] = useState(null) // target status
  const [confirmResend, setConfirmResend] = useState(false)
  const [conflicts, setConflicts] = useState(null) // { date, list } from schedule_repair_ticket, waiting for เขียนทับ

  // form
  const [formReady, setFormReady] = useState(false)
  const [date, setDate] = useState('')
  const [start, setStart] = useState('09:00')
  const [hours, setHours] = useState('2')
  const [workerIds, setWorkerIds] = useState([])
  const [workerQuery, setWorkerQuery] = useState('')
  const [crewNames, setCrewNames] = useState({}) // worker id -> label, for crew not in useWorkers()
  const [notify, setNotify] = useState(false) // set from customerPushDefault once the ticket loads
  const [sendReport, setSendReport] = useState(false) // R32 (off until the ticket loads): close also pushes the report to the customer
  const [fixNote, setFixNote] = useState('')

  const loadMedia = useCallback(async () => {
    const { data, error: e } = await supabase.from('repair_ticket_media')
      .select('id, ticket_id, role, media_type, storage_path, file_name, created_at')
      .eq('ticket_id', ticketId).order('created_at', { ascending: true })
    if (e) { setLoadError(`โหลดรูป/ไฟล์ไม่สำเร็จ: ${e.message}`); return }
    const rows = data || []
    setMedia(rows)
    const paths = rows.map((m) => m.storage_path).filter(Boolean)
    if (!paths.length) { setUrls({}); return }
    const { data: signed, error: e2 } = await supabase.storage.from(REPAIR_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS)
    if (e2) setLoadError(`ลิงก์รูป/ไฟล์ไม่สำเร็จ: ${e2.message}`)
    const map = {}
    for (const s of signed || []) if (s.signedUrl && s.path) map[s.path] = s.signedUrl
    setUrls(map)
  }, [ticketId])

  // Returns the fresh ticket row (or null).
  const loadTicket = useCallback(async () => {
    const { data, error: e } = await supabase.from('repair_tickets')
      .select('*, sites(name, site_number, status, handover_date, warranty_months), clients(name)')
      .eq('id', ticketId).maybeSingle()
    if (e) { setLoadError(`โหลดงานซ่อมไม่สำเร็จ: ${e.message}`); return null }
    if (!data) { setLoadError('ไม่พบงานซ่อมนี้ (อาจถูกลบ หรือไม่มีสิทธิ์)'); return null }
    setTicket(data)
    return data
  }, [ticketId])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const t = await loadTicket()
      if (!alive || !t) return
      loadMedia()
      // The customer added something from LINE: opening the ticket marks it seen. The stored value is the
      // customer_update_at we just read (not this device's clock), so a newer addition stays unseen.
      // Runs alongside the form prefill below; onChanged on close then reloads the board.
      if (hasUnseenCustomerUpdate(t)) {
        supabase.from('repair_tickets')
          .update({ customer_update_seen_at: t.customer_update_at }).eq('id', t.id).select('id')
          .then(({ data: seen, error: seenErr }) => {
            if (seenErr) console.error('repair: mark customer update seen failed', seenErr.message)
            else if (alive && (seen || []).length > 0) setChanged(true)
          })
      }
      // Prefill the form from the saved appointment and the crew assigned on that date.
      let crew = []
      const names = {}
      if (t.scheduled_date) {
        const { data } = await supabase.from('worker_assignments').select('worker_id, workers(name, nickname)')
          .eq('repair_ticket_id', t.id).eq('date', t.scheduled_date)
        crew = [...new Set((data || []).map((a) => a.worker_id))]
        for (const a of data || []) if (a.workers) names[a.worker_id] = workerLabel(a.workers)
      }
      if (!alive) return
      setCrewNames(names)
      // R32: LINE tickets notify by default, staff tickets do not (first open only). R29: never in_progress.
      setNotify(t.status !== 'in_progress' && customerPushDefault(t))
      setSendReport(customerPushDefault(t))
      setDate(t.scheduled_date || '')
      setStart(startTime(t.scheduled_start) || '09:00')
      setHours(Number(t.duration_hours) > 0 ? String(Number(t.duration_hours)) : '2')
      setWorkerIds(crew)
      setFixNote(t.fix_note || '')
      setFormReady(true)
    })()
    return () => { alive = false }
  }, [loadTicket, loadMedia])

  const handleClose = () => {
    if (lightbox) { setLightbox(null); return false }
    if (confirmMove) { setConfirmMove(null); return false }
    if (confirmResend) { setConfirmResend(false); return false }
    if (busy || uploading) return false
    if (changed) onChanged()
    else onClose()
  }

  const t = ticket
  const status = t?.status
  const canSchedule = canEdit && ['received', 'scheduled', 'in_progress'].includes(status)
  const closeAllowed = canEdit && !!status && canMove(status, 'done')
  const showClose = canEdit && ['received', 'scheduled', 'in_progress'].includes(status)
  // R29: no schedule push for a repair already in progress (the server refuses it anyway).
  const notifyAllowed = status !== 'in_progress'
  const canUpload = canEdit && !!status && !['pending_review', 'declined'].includes(status)

  const byRole = useMemo(() => {
    const g = { customer: [], before: [], after: [] }
    for (const m of media) (g[m.role] || (g[m.role] = [])).push(m)
    return g
  }, [media])
  const beforeItems = useMemo(() => beforeGallery(media), [media])

  const workerById = useMemo(() => Object.fromEntries((workers || []).map((w) => [w.id, w])), [workers])
  const shownWorkers = useMemo(() => {
    const q = workerQuery.trim().toLowerCase()
    const list = workers || []
    return q ? list.filter((w) => `${w.name || ''} ${w.nickname || ''}`.toLowerCase().includes(q) || workerIds.includes(w.id)) : list
  }, [workers, workerQuery, workerIds])
  // Crew assigned earlier who no longer show up in Assign (inactive / hidden) still count until unticked.
  const hiddenCrew = workers ? workerIds.filter((id) => !workerById[id]) : []

  const shiftsText = useMemo(() => {
    try { return repairShifts(start, Number(hours)).map((s) => SHIFT_TH[s]).join(' + ') } catch { return '' }
  }, [start, hours])

  const moves = useMemo(() => {
    if (!canEdit || !status) return []
    return ['received', 'scheduled', 'in_progress', 'done', 'declined']
      .filter((to) => canMove(status, to) && MOVE_LABEL[`${status}>${to}`])
      .map((to) => ({ to, label: MOVE_LABEL[`${status}>${to}`] }))
  }, [canEdit, status])

  const toggleWorker = (id) => setWorkerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  // Status write guarded on the status we saw (0 rows -> someone moved it meanwhile, or RLS refused).
  const guardedUpdate = async (patch) => {
    const { data, error: e } = await supabase.from('repair_tickets').update(patch)
      .eq('id', t.id).eq('status', t.status).select('id')
    if (e) throw e
    if (!data || data.length === 0) {
      const { data: now } = await supabase.from('repair_tickets').select('status').eq('id', t.id).maybeSingle()
      throw new Error(now && now.status !== t.status
        ? `งานซ่อมนี้ถูกเปลี่ยนสถานะเป็น "${REPAIR_STATUS[now.status] || now.status}" ไปแล้ว ปิดแล้วเปิดใหม่อีกครั้ง`
        : 'บันทึกไม่ได้ (สิทธิ์หรือแพ็กเกจหมดอายุ)')
    }
  }

  const doMove = async (to) => {
    setConfirmMove(null)
    setError(''); setNotice(null); setBusy(true)
    try {
      await guardedUpdate(movePatch(t.status, to, new Date().toISOString()))
      setChanged(true)
      setNotice({ kind: 'success', text: `ย้ายเป็น "${REPAIR_STATUS[to]}" แล้ว` })
      if (releasesCrew(t.status, to)) {
        // R30: release the booked crew (from today on, not yet checked in).
        const { error: e2 } = await removeFutureUnconfirmedCrew(t.id, t.site_id)
        if (e2) setError(`ย้ายสถานะแล้ว แต่ถอนช่างที่จองไว้ไม่สำเร็จ: ${e2.message} (ลบเองได้ในหน้าจ่ายงาน)`)
        else if (to === 'received') setWorkerIds([])
      }
      if (to === 'in_progress') setNotify(false)
    } catch (e) {
      setError(`เปลี่ยนสถานะไม่สำเร็จ: ${e.message}`)
    }
    await loadTicket()
    setBusy(false)
  }

  const askMove = (to) => {
    if (CONFIRM_MOVE[to] || CONFIRM_MOVE[`${status}>${to}`]) setConfirmMove(to)
    else doMove(to)
  }

  // Ruling R28: one atomic RPC (lock ticket, conflict check, diff own rows keeping check-ins, update ticket).
  // The shifts come from the tested repairShifts; the push runs after the save and never undoes it.
  // overwrite = true (เขียนทับ, like Assign): the crew's other rows in those shifts are removed and replaced,
  // except checked-in ones, which still come back as conflicts.
  const saveSchedule = async (overwrite = false) => {
    if (!canSchedule) return
    setError(''); setNotice(null); setConflicts(null)
    if (!date) { setError('กรุณาเลือกวันที่เข้า'); return }
    if (date < today) { setError('วันที่เข้าต้องไม่ก่อนวันนี้'); return }
    if (!/^\d{2}:\d{2}$/.test(start)) { setError('กรุณาระบุเวลาเริ่ม'); return }
    const hrs = Number(hours)
    if (!(hrs > 0 && hrs <= 24)) { setError('ระยะเวลาต้องมากกว่า 0 และไม่เกิน 24 ชม.'); return }
    const crewIds = hasCrew ? workerIds : []
    const { rows } = planRepairAssignments({ workerIds: crewIds, date, start, durationHours: hrs, existing: [] })
    const shifts = repairShifts(start, hrs)
    const wantPush = notifyAllowed && notify
    setBusy(true)
    try {
      const { data, error: e } = await supabase.rpc('schedule_repair_ticket', {
        p_ticket: t.id, p_expected_status: t.status, p_date: date, p_start: start, p_hours: hrs,
        p_worker_ids: crewIds, p_shifts: shifts, p_notify: wantPush, p_overwrite: overwrite,
      })
      if (e) throw e
      if (!data?.ok) {
        setConflicts({ date, list: data?.conflicts || [] })
        return
      }
      setChanged(true)
      const crewCount = new Set(rows.map((r) => r.worker_id)).size
      const over = Number(data?.overwritten) > 0 ? ` · ถอนจากงานเดิม ${Number(data.overwritten)} กะ` : ''
      const saved = `บันทึกนัด ${formatThaiDate(date)} ${start}${hasCrew ? ` · ช่าง ${crewCount} คน` : ''} แล้ว${over}`
      if (wantPush) {
        const push = await invokeRepairPush('schedule', t.id)
        setNotice({ kind: push.kind, text: `${saved} · ${push.text}` })
      } else {
        setNotice({ kind: 'success', text: `${saved} · ไม่ได้แจ้งลูกค้า และไม่เตือนก่อน 1 วัน` })
      }
      await loadTicket()
    } catch (e) {
      setError(`บันทึกนัดไม่สำเร็จ: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Ruling R25: at least one after photo + a fix note; done via movePatch; then the report push.
  const closeTicket = async () => {
    if (!closeAllowed) return
    setError(''); setNotice(null)
    if (byRole.after.length === 0) { setError('ต้องมีรูปหลังซ่อมอย่างน้อย 1 รูปก่อนปิดงาน'); return }
    if (!fixNote.trim()) { setError('กรุณากรอก "สิ่งที่แก้ไข" ก่อนปิดงาน'); return }
    setBusy(true)
    try {
      await guardedUpdate({ fix_note: fixNote.trim(), ...movePatch(t.status, 'done', new Date().toISOString(), t) })
      setChanged(true)
      if (sendReport) {
        const push = await invokeRepairPush('report', t.id, !!t.reported_at)
        setNotice({ kind: push.kind, text: `ปิดงานแล้ว · ${push.text}` })
      } else {
        setNotice({ kind: 'success', text: 'ปิดงานแล้ว · ไม่ได้ส่งรายงานให้ลูกค้า (ส่งภายหลังได้)' })
      }
      await loadTicket()
    } catch (e) {
      setError(`ปิดงานไม่สำเร็จ: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const resendReport = async () => {
    setConfirmResend(false)
    setError(''); setNotice(null); setBusy(true)
    try {
      const push = await invokeRepairPush('report', t.id, !!t.reported_at)
      setNotice({ kind: push.kind, text: push.text })
      await loadTicket()
    } finally {
      setBusy(false)
    }
  }

  const upload = async (role, files) => {
    setError(''); setNotice(null); setUploading(role)
    try {
      const { succeeded, failed } = await uploadRepairPhotos(files, { tenantId: t.tenant_id, ticketId: t.id, role })
      if (succeeded.length) setChanged(true)
      if (failed.length) setError(`อัปโหลดไม่สำเร็จ ${failed.length} จาก ${files.length} รูป: ${failed[0].error?.message || failed[0].error}`)
      await loadMedia()
    } finally {
      setUploading(null)
    }
  }

  const title = t ? `🔧 ${t.ticket_number} · ${t.sites?.name || '-'}` : '🔧 งานซ่อม'

  return (
    <Modal title={title} onClose={handleClose} maxWidth={860}>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!t ? (
          loadError ? <div className="alert alert-error">{loadError}</div> : <div style={{ color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <WarrantyPill ticket={t} today={today} />
              <span style={{ flexGrow: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>สถานะไซท์: {t.sites?.status || '-'} (ไม่เปลี่ยน)</span>
            </div>

            <div style={{ display: 'flex', gap: 6, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              {status === 'declined' ? (
                <span style={{ padding: '5px 12px', borderRadius: 999, background: 'var(--red)', color: 'var(--on-red)', fontWeight: 700 }}>{REPAIR_STATUS.declined}</span>
              ) : PILL_STEPS.map((s) => (
                <span key={s} style={s === status
                  ? { padding: '5px 12px', borderRadius: 999, background: 'var(--accent-fill)', color: 'var(--on-accent)', fontWeight: 700 }
                  : { padding: '5px 12px', borderRadius: 999, background: 'var(--bg3)', color: 'var(--text2)' }}>
                  {REPAIR_STATUS[s]}
                </span>
              ))}
              {moves.length > 0 && <span style={{ flexGrow: 1 }} />}
              {moves.map((m) => (
                <button key={m.to} type="button" className={`btn btn-sm ${m.to === 'declined' ? 'btn-danger' : 'btn-ghost'}`} disabled={busy} onClick={() => askMove(m.to)}>{m.label}</button>
              ))}
            </div>

            {loadError && <div className="alert alert-error">{loadError}</div>}

            <div style={sec}>
              {t.source === 'line'
                ? `จากลูกค้า (LINE · ${t.clients?.name || '-'} · ${formatThaiDate(bangkokDateOf(t.created_at))} ${bkkTime(t.created_at)})`
                : `รายละเอียด (เปิดเอง${t.created_by ? ` โดย ${t.created_by}` : ''} · ${formatThaiDate(bangkokDateOf(t.created_at))} ${bkkTime(t.created_at)})`}
            </div>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.description || <span style={{ color: 'var(--text3)' }}>ไม่มีรายละเอียด</span>}</div>
            {/* No ผลการซ่อม section on these statuses, so the customer's media is shown here (read-only). */}
            {(status === 'pending_review' || status === 'declined') && beforeItems.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>ก่อนซ่อม</div>
                <MediaTiles items={beforeItems} urls={urls} onOpenImage={setLightbox} />
              </div>
            )}

            <div style={sec}>นัดหมาย</div>
            {!canSchedule && status !== 'done' && status !== 'declined' && canEdit && (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>กด "เปิดงานซ่อม" ก่อน แล้วจึงนัดวันเข้าซ่อมได้</div>
            )}
            {(status === 'done' || status === 'declined' || !canEdit) ? (
              <div style={{ fontSize: 13 }}>
                {t.scheduled_date
                  ? `${formatThaiDate(t.scheduled_date)} ${startTime(t.scheduled_start)}${Number(t.duration_hours) > 0 ? ` · ${Number(t.duration_hours)} ชม.` : ''}`
                  : <span style={{ color: 'var(--text3)' }}>ยังไม่ได้นัด</span>}
              </div>
            ) : (
              <fieldset disabled={!canSchedule || busy || !formReady} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                <div className="form-grid-4">
                  <div className="form-group">
                    <label className="label">วันที่เข้า</label>
                    <input type="date" className="input" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
                    {date && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{formatThaiDate(date)}</div>}
                  </div>
                  <div className="form-group">
                    <label className="label">เวลา</label>
                    <input type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="label">ระยะเวลา (ชม.)</label>
                    <input type="number" className="input num-spin" min="0.5" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
                    {shiftsText && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>ลงกะ{shiftsText}</div>}
                  </div>
                  <div className="form-group">
                    <label className="label">ทีมช่าง</label>
                    <div className="input" style={{ color: hasCrew && workerIds.length ? 'var(--text)' : 'var(--text3)' }}>
                      {!hasCrew ? '-' : workerIds.length ? `${workerIds.length} คน` : 'ยังไม่เลือก'}
                    </div>
                  </div>
                </div>
                {!hasCrew ? (
                  !tenantLoading && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ต้องเปิดโมดูลค่าแรง/จ่ายงานช่าง เพื่อจัดช่าง</div>
                ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(workers || []).length > 12 && (
                    <input className="input input-sm" placeholder="ค้นหาช่าง..." value={workerQuery} onChange={(e) => setWorkerQuery(e.target.value)} />
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                    {shownWorkers.map((w) => {
                      const on = workerIds.includes(w.id)
                      return (
                        <label key={w.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', border: '1px solid var(--border)', background: on ? 'rgba(var(--accent-rgb), 0.15)' : 'var(--bg2)' }}>
                          <input type="checkbox" checked={on} onChange={() => toggleWorker(w.id)} />
                          {workerLabel(w)}
                        </label>
                      )
                    })}
                    {hiddenCrew.map((id) => (
                      <label key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)', background: 'rgba(var(--accent-rgb), 0.15)' }}>
                        <input type="checkbox" checked onChange={() => toggleWorker(id)} />
                        {crewNames[id] || 'ช่างที่ไม่แสดงในหน้าจ่ายงาน'}
                      </label>
                    ))}
                    {(workers || []).length === 0 && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ไม่มีช่างที่ใช้งานอยู่</span>}
                  </div>
                </div>
                )}
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={notifyAllowed && notify} disabled={!notifyAllowed} onChange={(e) => setNotify(e.target.checked)} />
                  {NOTIFY_LABEL}
                  {!notifyAllowed && <span style={{ fontSize: 12, color: 'var(--text3)' }}>(กำลังซ่อมอยู่ ไม่แจ้งซ้ำ)</span>}
                </label>
                {hasCrew && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ช่างเห็นงานนี้ในหน้าจ่ายงาน (กะเช้า/บ่ายตามเวลานัด) และเช็คอินที่ไซท์ได้ตามปกติ</div>}
              </fieldset>
            )}

            {status !== 'pending_review' && status !== 'declined' && (
              <>
                <div style={sec}>ผลการซ่อม (ตอนปิดงาน)</div>
                <div className="form-grid-2" style={{ gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>ก่อนซ่อม</div>
                    <MediaTiles items={beforeItems} urls={urls} onOpenImage={setLightbox}
                      onAdd={canUpload ? (f) => upload('before', f) : null} adding={uploading === 'before'} />
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>รูปจากลูกค้า + ช่างถ่ายก่อนเริ่ม</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--green)' }}>หลังซ่อม</div>
                    <MediaTiles items={byRole.after} urls={urls} onOpenImage={setLightbox}
                      onAdd={canUpload ? (f) => upload('after', f) : null} adding={uploading === 'after'} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="label">สิ่งที่แก้ไข</label>
                  <textarea className="textarea" rows={3} value={fixNote} disabled={!showClose || busy}
                    onChange={(e) => setFixNote(e.target.value)} placeholder="เช่น เปลี่ยนลูกล้อ 2 ตัว ปรับตั้งล็อก" />
                </div>
                {status === 'done' && (
                  <div style={{ fontSize: 12, color: t.reported_at ? 'var(--green)' : 'var(--text3)' }}>
                    {t.done_at ? `เสร็จ ${formatThaiDate(bangkokDateOf(t.done_at))} · ` : ''}
                    {t.reported_at ? `✓ ส่งรายงานแล้ว ${formatThaiDate(bangkokDateOf(t.reported_at))} ${bkkTime(t.reported_at)}` : 'ยังไม่ได้ส่งรายงานให้ลูกค้า'}
                  </div>
                )}
                {showClose && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={sendReport} disabled={busy} onChange={(e) => setSendReport(e.target.checked)} />
                    ส่งรายงานให้ลูกค้าทางไลน์
                    <span style={{ fontSize: 12, color: 'var(--text3)' }}>(ลูกค้าเห็นรายละเอียด สิ่งที่แก้ไข และรูปก่อน/หลังซ่อม)</span>
                  </label>
                )}
                {showClose && !closeAllowed && status === 'received' && (
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>นัดวันก่อน แล้วปิดงานได้</div>
                )}
              </>
            )}

            {conflicts && (
              <ConflictBox conflicts={conflicts} workerIds={workerIds} busy={busy}
                nameOf={(id) => (workerById[id] ? workerLabel(workerById[id]) : (crewNames[id] || 'ช่าง'))}
                onOverwrite={() => saveSchedule(true)} onCancel={() => setConflicts(null)} />
            )}
            {notice && <div className={`alert ${NOTICE_CLASS[notice.kind] || 'alert-info'}`}>{notice.text}</div>}
            {error && <div className="alert alert-error" style={{ whiteSpace: 'pre-line' }}>{error}</div>}
          </>
        )}
      </div>
      <div className="modal-footer" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" disabled={busy || !!uploading} onClick={handleClose}>ปิด</button>
        {t && canSchedule && (
          <button type="button" className="btn btn-ghost" style={{ borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }} disabled={busy || !!uploading || !formReady || tenantLoading} onClick={() => saveSchedule(false)}>
            {busy ? 'กำลังบันทึก...' : notifyAllowed && notify ? 'บันทึกนัด + แจ้งลูกค้า' : 'บันทึกนัด'}
          </button>
        )}
        {t && showClose && (
          <button type="button" className="btn btn-success" disabled={busy || !!uploading || !closeAllowed} onClick={closeTicket}
            title={closeAllowed ? '' : 'นัดวันก่อน แล้วปิดงานได้'}>
            {sendReport ? 'ปิดงาน (เสร็จ) + ส่งรายงาน' : 'ปิดงาน (เสร็จ)'}
          </button>
        )}
        {t && canEdit && status === 'done' && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmResend(true)}>
            {t.reported_at ? 'ส่งรายงานอีกครั้ง' : 'ส่งรายงานให้ลูกค้า'}
          </button>
        )}
      </div>

      {lightbox && createPortal(
        <div role="dialog" aria-label="ดูรูป" onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-out' }}>
          <img src={lightbox} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }} />
          <button type="button" aria-label="ปิดรูป" onClick={() => setLightbox(null)}
            style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(0,0,0,0.5)', color: '#fff', border: 0, borderRadius: 999, width: 36, height: 36, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>,
        document.body,
      )}

      {confirmResend && (
        <ConfirmDialog
          title="ส่งรายงานให้ลูกค้า"
          message={RESEND_CONFIRM}
          confirmDisabled={busy}
          onCancel={() => setConfirmResend(false)}
          onConfirm={resendReport}
        />
      )}

      {confirmMove && (
        <ConfirmDialog
          title={MOVE_LABEL[`${status}>${confirmMove}`] || 'เปลี่ยนสถานะ'}
          message={CONFIRM_MOVE[`${status}>${confirmMove}`] || CONFIRM_MOVE[confirmMove]}
          danger
          confirmDisabled={busy}
          onCancel={() => setConfirmMove(null)}
          onConfirm={() => doMove(confirmMove)}
        />
      )}
    </Modal>
  )
}
