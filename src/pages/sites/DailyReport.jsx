// ============================================================
// DailyReport -- printable/exportable daily log for one site + one
// date: crew assigned, still-open tasks, ปัญหา filed that day (with a
// live "แก้ไขแล้ว" button, not just a read-only list), รูปภาพหน้างาน
// sent that day, and any tasks closed that day WITH their completion
// photo(s) as evidence. User's own framing: "kind of a daily report
// about problem / photo / evidence of completion... plus who worked +
// what's still open."
//
// "Completed today" is inferred from line_site_photos rows that have
// task_id set, that task's own status = 'done', AND date = the report
// date -- not from phase_tasks.updated_at, which bumps on any edit
// (rename, zone change), not specifically on the งานเสร็จ closing event.
// The status check (added post-launch, see byTask below) matters because
// task_id alone stopped being a done-only signal once the Kanban Photo
// Upload & Assignment plan let an admin drag any photo onto any card, or
// a worker attach one to their own task, regardless of its status.
//
// PDF export reuses the existing downloadPDF() helper (html2pdf.js)
// already used by Quotations/Invoices/LaborContractors -- captures
// whatever's currently in #daily-report-paper, buttons included (this
// is an internal working report, not a formal signed document, so a
// non-clickable "แก้ไขแล้ว" button showing up in the PDF snapshot is an
// acceptable tradeoff for not building a second read-only render).
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { downloadPDF } from '../../lib/pdf.js'
import PendingMark from '../../components/PendingMark.jsx'
import { isIssueOpen } from '../../lib/pendingRules.js'

function todayLocal() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function workerLabel(w) {
  return w?.nickname || w?.name || 'ไม่ทราบชื่อ'
}

async function signPhotoUrls(photos) {
  const paths = photos.map((p) => p.photo_path)
  if (!paths.length) return {}
  const { data: signed } = await supabase.storage.from('line-site-photos').createSignedUrls(paths, 3600)
  return Object.fromEntries((signed || []).filter((s) => !s.error).map((s) => [s.path, s.signedUrl]))
}

export default function DailyReport({ site }) {
  const [date, setDate] = useState(todayLocal())
  const [loading, setLoading] = useState(true)
  const [crew, setCrew] = useState({ morning: [], evening: [] })
  const [openTasks, setOpenTasks] = useState([])
  const [issues, setIssues] = useState([])
  const [completions, setCompletions] = useState([])
  const [generalPhotos, setGeneralPhotos] = useState([])
  const [resolvingId, setResolvingId] = useState(null)
  const [downloading, setDownloading] = useState(false)

  const fetchReport = async () => {
    setLoading(true)
    const dayStart = `${date}T00:00:00+07:00`
    const dayEnd = `${date}T23:59:59+07:00`

    const [assignRes, taskRes, issueRes, photoRes] = await Promise.all([
      supabase.from('worker_assignments').select('shift, type, workers(name, nickname)')
        .eq('site_id', site.id).eq('date', date).in('type', ['site', 'factory', 'subcontract']),
      supabase.from('phase_tasks').select('id, name, status, zone')
        .eq('site_id', site.id).neq('status', 'done').order('sort_order'),
      supabase.from('line_issue_reports').select('id, message, status, created_at, workers(name, nickname)')
        .eq('site_id', site.id).gte('created_at', dayStart).lte('created_at', dayEnd).order('created_at'),
      supabase.from('line_site_photos').select('id, photo_path, task_id, created_at, workers(name, nickname), phase_tasks(name, status)')
        .eq('site_id', site.id).eq('date', date),
    ])

    const assignments = assignRes.data || []
    setCrew({
      morning: assignments.filter((r) => r.shift !== 'evening').map((r) => workerLabel(r.workers)),
      evening: assignments.filter((r) => r.shift === 'evening').map((r) => workerLabel(r.workers)),
    })
    setOpenTasks(taskRes.data || [])
    setIssues(issueRes.data || [])

    const photos = photoRes.data || []
    const urlByPath = await signPhotoUrls(photos)
    const withUrl = photos.map((p) => ({ ...p, url: urlByPath[p.photo_path] }))

    // Before Kanban Photo Upload & Assignment, task_id could ONLY get set
    // by the LINE bot's job-done-pick flow, so "task_id set" reliably
    // meant "this task was marked done." That plan added two more ways to
    // set it -- an admin dragging any unassigned photo onto any card, and
    // a worker attaching a photo straight to their own assigned task --
    // both regardless of the task's current status. So task_id alone no
    // longer proves completion; only phase_tasks.status === 'done' does.
    // A photo attached to a still-open task falls through to
    // generalPhotos below instead of silently disappearing from the report.
    setGeneralPhotos(withUrl.filter((p) => !p.task_id || p.phase_tasks?.status !== 'done'))

    const byTask = new Map()
    withUrl.filter((p) => p.task_id && p.phase_tasks?.status === 'done').forEach((p) => {
      const group = byTask.get(p.task_id) || { taskName: p.phase_tasks?.name || 'ไม่ทราบชื่องาน', photos: [] }
      group.photos.push(p)
      byTask.set(p.task_id, group)
    })
    setCompletions([...byTask.values()])

    setLoading(false)
  }
  useEffect(() => { fetchReport() }, [site.id, date]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleResolve = async (id) => {
    setResolvingId(id)
    try {
      const { error } = await supabase.from('line_issue_reports').update({ status: 'resolved' }).eq('id', id)
      if (error) throw error
      setIssues((list) => list.map((r) => (r.id === id ? { ...r, status: 'resolved' } : r)))
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setResolvingId(null)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      await downloadPDF('daily-report-paper', `รายงานประจำวัน_${site.name}_${date}.pdf`)
    } finally {
      setDownloading(false)
    }
  }

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  return (
    <div>
      <div className="card" style={{ marginBottom: 16, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label className="label" style={{ marginBottom: 0 }}>วันที่</label>
        <input type="date" className="input" style={{ width: 170 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={downloading || loading} onClick={handleDownload}>
          {downloading ? '⏳ กำลังสร้าง...' : '🖨️ ดาวน์โหลด PDF'}
        </button>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
      ) : (
        <div id="daily-report-paper" className="card" style={{ padding: 24 }}>
          <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '.05em' }}>รายงานประจำวัน</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{site.site_number ? `${site.site_number} · ` : ''}{site.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 2 }}>{dateLabel}</div>
          </div>

          <ReportSection title="👷 ทีมงานที่มอบหมาย">
            {!crew.morning.length && !crew.evening.length ? (
              <Empty text="ไม่มีการมอบหมายงานวันนี้" />
            ) : (
              <div style={{ display: 'grid', gap: 6, fontSize: 13.5 }}>
                {crew.morning.length > 0 && <div>🌅 เช้า: {crew.morning.join(', ')}</div>}
                {crew.evening.length > 0 && <div>🌆 บ่าย: {crew.evening.join(', ')}</div>}
              </div>
            )}
          </ReportSection>

          <ReportSection title={`🔧 งานที่ยังไม่เสร็จ (${openTasks.length})`}>
            {!openTasks.length ? <Empty text="ไม่มีงานค้าง" /> : (
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, display: 'grid', gap: 4 }}>
                {openTasks.map((t) => (
                  <li key={t.id}>{t.name}{t.zone ? ` (${t.zone})` : ''} — <span style={{ color: 'var(--text3)' }}>{t.status === 'in_progress' ? 'กำลังทำ' : 'ยังไม่เริ่ม'}</span></li>
                ))}
              </ul>
            )}
          </ReportSection>

          <ReportSection title={`🚧 แจ้งปัญหาวันนี้ (${issues.length})`}>
            {!issues.length ? <Empty text="ไม่มีการแจ้งปัญหา" /> : (
              <div style={{ display: 'grid', gap: 10 }}>
                {issues.map((r) => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, fontSize: 13.5, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div>
                      {isIssueOpen(r) && <PendingMark label="ยังไม่แก้ไข" />}<b>{workerLabel(r.workers)}</b>: {r.message}
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>{new Date(r.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                    {r.status === 'open' ? (
                      <button className="btn btn-sm btn-primary" style={{ flex: 'none' }} disabled={resolvingId === r.id} onClick={() => handleResolve(r.id)}>แก้ไขแล้ว</button>
                    ) : (
                      <span className="badge" style={{ flex: 'none', background: 'rgba(var(--green-rgb), 0.2)', color: 'var(--green)' }}>✅ แก้ไขแล้ว</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ReportSection>

          <ReportSection title={`📷 รูปภาพหน้างานวันนี้ (${generalPhotos.length})`}>
            {!generalPhotos.length ? <Empty text="ไม่มีรูปภาพ" /> : (
              <PhotoGrid
                photos={generalPhotos}
                labelFor={(p) => (p.task_id ? `${workerLabel(p.workers)} · มอบหมายให้: ${p.phase_tasks?.name || 'ไม่ทราบชื่องาน'}` : workerLabel(p.workers))}
                italicFor={(p) => !!p.task_id}
              />
            )}
          </ReportSection>

          <ReportSection title={`✅ งานที่เสร็จวันนี้ (${completions.length})`} last>
            {!completions.length ? <Empty text="ไม่มีงานที่ปิดพร้อมรูปหลักฐานวันนี้" /> : (
              <div style={{ display: 'grid', gap: 16 }}>
                {completions.map((c, i) => (
                  <div key={i}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>{c.taskName}</div>
                    <PhotoGrid photos={c.photos} labelFor={(p) => workerLabel(p.workers)} />
                  </div>
                ))}
              </div>
            )}
          </ReportSection>
        </div>
      )}
    </div>
  )
}

function ReportSection({ title, children, last }) {
  return (
    <div style={{ marginBottom: last ? 0 : 20, paddingBottom: last ? 0 : 20, borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )
}

function Empty({ text }) {
  return <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>{text}</div>
}

function PhotoGrid({ photos, labelFor, italicFor }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
      {photos.map((p) => (
        <a key={p.id} href={p.url} target="_blank" rel="noreferrer" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          {p.url ? (
            <img src={p.url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
          ) : (
            <div style={{ width: '100%', aspectRatio: '1', borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--text3)' }}>โหลดรูปไม่สำเร็จ</div>
          )}
          <div style={{ fontSize: 10.5, marginTop: 3, color: 'var(--text3)', fontStyle: italicFor?.(p) ? 'italic' : 'normal' }}>{labelFor(p)}</div>
        </a>
      ))}
    </div>
  )
}
