// ============================================================
// Repairs — 🔧 งานซ่อม: one Kanban board of every repair ticket across all sites.
// Columns รอพิจารณา / รับเรื่อง / นัดเข้า / กำลังซ่อม / เสร็จ (last 60 days); a chip adds ไม่รับ.
// Native HTML5 drag between columns, only where canMove() allows. Dropping on นัดเข้า (needs a
// date) or เสร็จ (needs an after photo) opens the detail modal instead of moving.
// Pure rules: src/lib/repairBoard.js. Status rules: supabase/functions/_shared/repair.ts.
// repair_tickets / repair_ticket_media are admin/owner RLS, so this page reads and writes directly.
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { ConfirmDialog } from '../components/Modal.jsx'
import RepairTicketModal, { CONFIRM_MOVE } from '../components/RepairTicketModal.jsx'
import NewRepairTicketModal from '../components/NewRepairTicketModal.jsx'
import { bangkokTodayIso } from '../lib/photoUpload.js'
import { releasesCrew, removeFutureUnconfirmedCrew } from '../lib/repairCrew.js'
import { formatThaiDate } from '../lib/thaiDate.js'
import { REPAIR_STATUS, startTime } from '../lib/repairStatus.js'
import {
  BOARD_COLUMNS, DONE_WINDOW_DAYS, groupTickets, dropAction, movePatch, ageText, crewCounts,
  warrantyOf, matchesWarrantyFilter, pickThumbs, bangkokDateOf,
} from '../lib/repairBoard.js'

const OPEN_STATUSES = 'pending_review,received,scheduled,in_progress'
const SIGNED_URL_SECONDS = 3600
const DECLINED_COLUMN = { status: 'declined', label: REPAIR_STATUS.declined, icon: '❌' }
const SOURCE_LABEL = { line: 'LINE', staff: 'เปิดเอง' }

const chipStyle = (on) => ({
  font: 'inherit', border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', background: on ? 'var(--accent-fill)' : 'var(--bg3)', color: on ? 'var(--on-accent)' : 'var(--text2)',
})

function WarrantyBadge({ ticket, today }) {
  const w = warrantyOf(ticket, today)
  if (w.kind === 'active') return <span className="badge badge-accepted" style={{ cursor: 'default' }} title={`หมดประกัน ${formatThaiDate(w.end)}`}>ในประกัน</span>
  if (w.kind === 'expired') return <span className="badge badge-expired" style={{ cursor: 'default' }} title={`หมดประกัน ${formatThaiDate(w.end)}`}>หมดประกัน</span>
  return null
}

function Thumbs({ thumbs, urls }) {
  if (!thumbs || thumbs.shown.length === 0) return null
  const box = { width: 34, height: 34, borderRadius: 6, background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, overflow: 'hidden', flex: '0 0 auto' }
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {thumbs.shown.map((m) => (
        <div key={m.id} style={box} title={m.file_name || ''}>
          {m.media_type === 'image' && urls[m.storage_path]
            ? <img src={urls[m.storage_path]} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : m.media_type === 'video' ? '🎬' : m.media_type === 'file' ? '📄' : '🖼️'}
        </div>
      ))}
      {thumbs.more > 0 && <span style={{ fontSize: 11, color: 'var(--text3)' }}>+{thumbs.more}</span>}
    </div>
  )
}

function TicketCard({ ticket, today, nowMs, thumbs, urls, crew, canEdit, busy, onOpen, onAccept, onDecline, onDragStart, onDragEnd }) {
  const t = ticket
  const draggable = canEdit && t.status !== 'declined'
  const meta = [SOURCE_LABEL[t.source] || t.source, t.clients?.name, ageText(t.created_at, nowMs)].filter(Boolean).join(' · ')
  const muted = { color: 'var(--text3)' }
  const time = startTime(t.scheduled_start)
  const hours = Number(t.duration_hours) > 0 ? `${Math.round(Number(t.duration_hours) * 100) / 100} ชม.` : ''
  return (
    <div
      draggable={draggable}
      onDragStart={draggable ? (e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(t) } : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={() => onOpen(t.id)}
      style={{
        background: 'var(--bg2)', border: t.status === 'pending_review' ? '2px solid var(--red)' : '1px solid var(--border)',
        borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12,
        cursor: 'pointer', opacity: busy ? 0.5 : 1,
      }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <b style={{ fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>{t.sites?.name || '-'}</b>
        <WarrantyBadge ticket={t} today={today} />
      </div>
      {t.description && (
        <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{t.description}</div>
      )}
      <Thumbs thumbs={thumbs} urls={urls} />

      {t.status === 'received' && !t.scheduled_date && <div style={{ color: 'var(--red)' }}>ยังไม่นัดวัน</div>}
      {t.status === 'scheduled' && (
        <>
          <div style={{ background: 'rgba(43,108,176,0.12)', borderRadius: 6, padding: '4px 6px', lineHeight: 1.6 }}>
            📅 {formatThaiDate(t.scheduled_date)}{time ? ` ${time}` : ''}{hours ? ` · ${hours}` : ''}<br />
            {crew > 0 ? `👷 ${crew} คน` : <span style={{ color: 'var(--red)' }}>👷 ยังไม่จัดทีม</span>}
          </div>
          {t.notified_schedule_at && <div style={{ color: 'var(--green)' }}>✓ แจ้งลูกค้าแล้ว</div>}
        </>
      )}
      {t.status === 'done' && (
        t.reported_at
          ? <div style={{ color: 'var(--green)' }}>✓ ส่งรายงานแล้ว {formatThaiDate(bangkokDateOf(t.reported_at))}</div>
          : <div style={muted}>เสร็จ {formatThaiDate(bangkokDateOf(t.done_at))}</div>
      )}
      {t.status === 'declined' && <div style={muted}>ไม่รับ {formatThaiDate(bangkokDateOf(t.declined_at))}</div>}

      <div style={muted}>{t.ticket_number}{meta ? ` · ${meta}` : ''}</div>

      {t.status === 'pending_review' && canEdit && (
        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn btn-primary btn-sm" style={{ flex: 1, justifyContent: 'center' }} disabled={busy} onClick={() => onAccept(t)}>เปิดงานซ่อม</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDecline(t)}>ไม่รับ</button>
        </div>
      )}
    </div>
  )
}

export default function Repairs() {
  const { role, isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'repairs')
  const today = bangkokTodayIso()

  const [tickets, setTickets] = useState([])
  const [thumbs, setThumbs] = useState({})
  const [urls, setUrls] = useState({})
  const [crew, setCrew] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('') // from the newest load
  const [error, setError] = useState('') // from the last move
  const [warrantyFilter, setWarrantyFilter] = useState('all')
  const [showDeclined, setShowDeclined] = useState(false)
  const [openTicketId, setOpenTicketId] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [declineTicket, setDeclineTicket] = useState(null)
  const [confirmDrag, setConfirmDrag] = useState(null) // { ticket, to } for drags that need a confirm
  const [busyId, setBusyId] = useState(null)
  const [dragging, setDragging] = useState(null) // the ticket being dragged
  const [dragOver, setDragOver] = useState(null) // column status under the pointer
  const [nowMs, setNowMs] = useState(() => Date.now())
  const loadSeq = useRef(0) // only the newest load may apply its result

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const stale = () => seq !== loadSeq.current
    // Open tickets, plus done/declined ones from the window (one day of slack; groupTickets cuts exactly).
    const cutoff = new Date(Date.now() - (DONE_WINDOW_DAYS + 1) * 86400000).toISOString()
    const { data, error: e1 } = await supabase
      .from('repair_tickets')
      .select('id, ticket_number, site_id, client_id, source, status, description, scheduled_date, scheduled_start, duration_hours, created_at, received_at, started_at, done_at, declined_at, notified_schedule_at, reported_at, sites(name, site_number, handover_date, warranty_months), clients(name)')
      .or(`status.in.(${OPEN_STATUSES}),done_at.gte.${cutoff},declined_at.gte.${cutoff}`)
      .order('created_at', { ascending: false })
    if (stale()) return
    if (e1) { setLoadError(`โหลดงานซ่อมไม่สำเร็จ: ${e1.message}`); setLoading(false); return }
    const rows = data || []
    setTickets(rows)
    setNowMs(Date.now())
    setLoading(false)

    const ids = rows.map((t) => t.id)
    const scheduled = rows.filter((t) => t.status === 'scheduled' && t.scheduled_date)
    const [mediaRes, crewRes] = await Promise.all([
      ids.length
        ? supabase.from('repair_ticket_media').select('id, ticket_id, role, media_type, storage_path, file_name, created_at').in('ticket_id', ids)
        : Promise.resolve({ data: [] }),
      scheduled.length
        ? supabase.from('worker_assignments').select('repair_ticket_id, worker_id, date').in('repair_ticket_id', scheduled.map((t) => t.id))
        : Promise.resolve({ data: [] }),
    ])
    if (stale()) return
    const problems = []
    if (mediaRes.error) problems.push(`รูป/ไฟล์: ${mediaRes.error.message}`)
    if (crewRes.error) problems.push(`ทีมช่าง: ${crewRes.error.message}`)
    const picked = pickThumbs(mediaRes.data || [])
    setThumbs(picked)
    setCrew(crewCounts(scheduled, crewRes.data || []))
    // One batch of signed URLs for every thumbnail image on the board (private bucket).
    const paths = Object.values(picked).flatMap((p) => p.shown).filter((m) => m.media_type === 'image').map((m) => m.storage_path)
    if (paths.length) {
      const { data: signed, error: e3 } = await supabase.storage.from('repair-media').createSignedUrls(paths, SIGNED_URL_SECONDS)
      if (stale()) return
      if (e3) problems.push(`ลิงก์รูป: ${e3.message}`)
      const map = {}
      for (const s of signed || []) if (s.signedUrl && s.path) map[s.path] = s.signedUrl
      setUrls(map)
    } else {
      setUrls({})
    }
    setLoadError(problems.length ? `โหลดบางส่วนไม่สำเร็จ: ${problems.join(' · ')}` : '')
  }, [])

  useEffect(() => { load() }, [load])

  const visible = useMemo(() => tickets.filter((t) => matchesWarrantyFilter(t, warrantyFilter, today)), [tickets, warrantyFilter, today])
  const grouped = useMemo(() => groupTickets(visible, today), [visible, today])
  const columns = showDeclined ? [...BOARD_COLUMNS, DECLINED_COLUMN] : BOARD_COLUMNS
  const declinedCount = useMemo(() => groupTickets(tickets, today).declined.length, [tickets, today])

  // Status move straight from the board. Guarded on the status we saw, so a ticket somebody else
  // moved meanwhile is not overwritten (0 rows -> reload and say so).
  const move = async (ticket, to) => {
    if (dropAction(ticket.status, to) !== 'move') return
    setBusyId(ticket.id)
    setError('')
    const { data, error: e } = await supabase
      .from('repair_tickets').update(movePatch(ticket.status, to, new Date().toISOString()))
      .eq('id', ticket.id).eq('status', ticket.status).select('id')
    if (e) setError(`ย้ายงานซ่อม ${ticket.ticket_number} ไม่สำเร็จ: ${e.message}`)
    else if (!data || data.length === 0) {
      // 0 rows: either someone moved it meanwhile, or the write was refused (RLS: role or expired plan).
      const { data: now } = await supabase.from('repair_tickets').select('status').eq('id', ticket.id).maybeSingle()
      setError(now && now.status !== ticket.status
        ? `งานซ่อม ${ticket.ticket_number} ถูกเปลี่ยนสถานะไปแล้ว โหลดใหม่ให้แล้ว`
        : `บันทึกไม่ได้ (สิทธิ์หรือแพ็กเกจหมดอายุ)`)
    } else if (releasesCrew(ticket.status, to)) {
      // R30: release the booked crew (from today on, not yet checked in).
      const { error: e2 } = await removeFutureUnconfirmedCrew(ticket.id)
      if (e2) setError(`ย้ายงานซ่อม ${ticket.ticket_number} แล้ว แต่ถอนช่างที่จองไว้ไม่สำเร็จ: ${e2.message} (ลบเองได้ในหน้าจ่ายงาน)`)
    }
    setBusyId(null)
    load()
  }

  const onDrop = (to) => {
    const t = dragging
    setDragging(null)
    setDragOver(null)
    if (!t) return
    const action = dropAction(t.status, to)
    if (action === 'move' && to === 'declined') setDeclineTicket(t) // ไม่รับ always asks first
    else if (action === 'move' && CONFIRM_MOVE[`${t.status}>${to}`]) setConfirmDrag({ ticket: t, to }) // releases crew / reopens
    else if (action === 'move') move(t, to)
    else if (action === 'modal') setOpenTicketId(t.id)
  }

  const toggleWarranty = (k) => setWarrantyFilter((f) => (f === k ? 'all' : k))

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>งานซ่อม (ทุกไซท์)</div>
        <span style={{ flexGrow: 1 }} />
        <button type="button" aria-pressed={warrantyFilter === 'active'} style={chipStyle(warrantyFilter === 'active')} onClick={() => toggleWarranty('active')}>ในประกัน</button>
        <button type="button" aria-pressed={warrantyFilter === 'expired'} style={chipStyle(warrantyFilter === 'expired')} onClick={() => toggleWarranty('expired')}>หมดประกัน</button>
        <button type="button" aria-pressed={showDeclined} style={chipStyle(showDeclined)} onClick={() => setShowDeclined((v) => !v)}>ไม่รับ ({declinedCount})</button>
        {canEdit && <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ เปิดงานซ่อมเอง</button>}
      </div>

      {[error, loadError].filter(Boolean).map((msg) => (
        <div key={msg} className="alert alert-error" style={{ marginBottom: 12, fontSize: 13 }}>{msg}</div>
      ))}

      {loading ? (
        <div style={{ color: 'var(--text3)', padding: 20 }}>กำลังโหลด...</div>
      ) : tickets.length === 0 && !loadError ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ยังไม่มีงานซ่อม</div>
      ) : (
        <div data-phone="kanban" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
          {columns.map((col) => {
            const list = grouped[col.status] || []
            const droppable = !!dragging && dropAction(dragging.status, col.status) !== 'none'
            return (
              <div key={col.status}
                onDragOver={droppable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(col.status) } : undefined}
                onDragLeave={droppable ? () => setDragOver((k) => (k === col.status ? null : k)) : undefined}
                onDrop={droppable ? (e) => { e.preventDefault(); onDrop(col.status) } : undefined}
                style={{
                  background: 'var(--bg3)', borderRadius: 12, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 120,
                  outline: dragOver === col.status ? '2px dashed var(--accent)' : droppable ? '1px dashed var(--accent)' : 'none',
                  opacity: dragging && !droppable && dragging.status !== col.status ? 0.6 : 1,
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, padding: '2px 4px' }}>
                  <span>{col.icon} {col.label}{col.status === 'pending_review' ? ' (จากไลน์)' : ''}{col.status === 'done' ? ` (${DONE_WINDOW_DAYS} วัน)` : ''}</span>
                  <span>{list.length}</span>
                </div>
                {list.map((t) => (
                  <TicketCard key={t.id} ticket={t} today={today} nowMs={nowMs} thumbs={thumbs[t.id]} urls={urls} crew={crew[t.id] || 0}
                    canEdit={canEdit} busy={busyId === t.id}
                    onOpen={setOpenTicketId}
                    onAccept={(x) => move(x, 'received')}
                    onDecline={setDeclineTicket}
                    onDragStart={setDragging}
                    onDragEnd={() => { setDragging(null); setDragOver(null) }} />
                ))}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text3)' }}>
        ไซท์ยังเป็น Completed ตลอด · งานซ่อมไม่นับโควตาไซท์ Ongoing{canEdit ? ' · ลากการ์ดข้ามคอลัมน์ได้' : ''}
      </div>

      {openTicketId && (
        <RepairTicketModal ticketId={openTicketId} onClose={() => setOpenTicketId(null)} onChanged={() => { setOpenTicketId(null); load() }} />
      )}
      {showNew && (
        <NewRepairTicketModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />
      )}
      {confirmDrag && (
        <ConfirmDialog
          title={`ย้ายงานซ่อม ${confirmDrag.ticket.ticket_number}`}
          message={CONFIRM_MOVE[`${confirmDrag.ticket.status}>${confirmDrag.to}`]}
          danger
          confirmDisabled={busyId === confirmDrag.ticket.id}
          onCancel={() => setConfirmDrag(null)}
          onConfirm={async () => { const { ticket, to } = confirmDrag; await move(ticket, to); setConfirmDrag(null) }}
        />
      )}
      {declineTicket && (
        <ConfirmDialog
          title="ไม่รับงานซ่อม"
          message={`ไม่รับงานซ่อม ${declineTicket.ticket_number} (${declineTicket.sites?.name || '-'})? ช่างที่จองไว้ตั้งแต่วันนี้ (ที่ยังไม่เช็คอิน) จะถูกถอนออก ดูย้อนหลังได้จากตัวกรอง "ไม่รับ"`}
          danger
          confirmDisabled={busyId === declineTicket.id}
          onCancel={() => setDeclineTicket(null)}
          onConfirm={async () => { const t = declineTicket; await move(t, 'declined'); setDeclineTicket(null) }}
        />
      )}
    </div>
  )
}
