// Delivery report (รายงานส่งงาน, DR) card picker. Plan B task 4, mockup v10 order:
// (1) phase table with ☐ ส่งงวดนี้, (2) cards of ticked phases with photo ticks + caption,
// (3) ＋ รูป upload straight onto the card, (4) ⚠️ check list (never blocks), then save.
import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase, fmt } from '../../../lib/supabase.js'
import { Modal } from '../../../components/Modal.jsx'
import { useTenant } from '../../../hooks/useTenant.js'
import { useDeliveryReport, saveDeliveryReport, reissueDeliveryReport } from '../../../hooks/useDeliveryReport.js'
import { nextReportStatusOnEdit } from '../../../lib/deliveryReport.js'
import { uploadSitePhoto, bangkokTodayIso } from '../../../lib/photoUpload.js'

const REASON_TEXT = {
  over_billed: 'ยอดเบิกเกินมูลค่างาน',
}
const reasonText = r => REASON_TEXT[r] || r

const thumbStyle = on => ({
  width: 64, height: 64, borderRadius: 6, objectFit: 'cover', cursor: 'pointer', display: 'block',
  border: on ? '3px solid var(--accent)' : '1px solid var(--border)', boxSizing: 'border-box',
})

function initialState(data) {
  const { rows = [], current, cards = [], tasks = [] } = data
  if (current) {
    const sel = {}
    for (const c of cards) if (c.task_id) sel[c.task_id] = { photoIds: c.photo_ids || [], caption: c.caption || '' }
    return { phaseIds: current.phase_ids || [], sel }
  }
  const billed = rows.filter(r => r.phaseId && r.this > 0)
  const phaseIds = [...new Set(billed.map(r => r.phaseId))]
  const billedKeys = new Set(billed.map(r => r.key))
  const sel = {}
  for (const t of tasks) {
    if (t.boq_item_id && billedKeys.has(`${t.boq_item_id}|${t.phase_id}`)) sel[t.id] = { photoIds: [], caption: '' }
  }
  return { phaseIds, sel }
}

export default function DeliveryReportEditor({ invoiceId, onClose, onSaved }) {
  const { data, loading, error, refetch } = useDeliveryReport(invoiceId)
  if (loading && !data) return <Modal title="รายงานส่งงาน" onClose={onClose}><div className="modal-body">กำลังโหลด…</div></Modal>
  if (error) return <Modal title="รายงานส่งงาน" onClose={onClose}><div className="modal-body" style={{ color: 'var(--red, #dc2626)' }}>{String(error.message || error)}</div></Modal>
  if (!data) return null
  return <Editor data={data} refetch={refetch} onClose={onClose} onSaved={onSaved} />
}

function Editor({ data, refetch, onClose, onSaved }) {
  const { tenant } = useTenant()
  const { invoice, rows, totals, current, tasks = [], phases = [], photosByTask = {} } = data
  const [init] = useState(() => initialState(data))
  const [phaseIds, setPhaseIds] = useState(init.phaseIds)
  const [sel, setSel] = useState(init.sel) // taskId -> { photoIds, caption }
  const [extraPhotos, setExtraPhotos] = useState({}) // taskId -> [photo] uploaded this session
  const [urls, setUrls] = useState({}) // photo_path -> signed url
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [myWorkerId, setMyWorkerId] = useState(null)
  const fileRefs = useRef({})

  useEffect(() => {
    let cancelled = false
    Promise.resolve(supabase.rpc?.('my_worker_id')).then(res => { if (!cancelled) setMyWorkerId(res?.data || null) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const photosOf = taskId => [...(photosByTask[taskId] || []), ...(extraPhotos[taskId] || [])]

  // Phase table: one row per phase, Σ contract value and Σ this-period amount.
  const phaseRows = useMemo(() => phases.map(p => {
    const rs = rows.filter(r => r.phaseId === p.id)
    const value = rs.reduce((s, r) => s + r.value, 0)
    const thisAmt = rs.reduce((s, r) => s + r.this, 0)
    return { ...p, value, thisAmt, pct: totals?.contract ? value / totals.contract * 100 : 0 }
  }), [phases, rows, totals])

  const ticked = new Set(phaseIds)
  const visibleTasks = tasks.filter(t => ticked.has(t.phase_id))

  // Signed URLs for every visible photo, batched.
  const visiblePaths = visibleTasks.flatMap(t => photosOf(t.id).map(p => p.photo_path)).filter(p => p && !urls[p])
  const pathsKey = visiblePaths.join('|')
  useEffect(() => {
    if (!visiblePaths.length) return
    let cancelled = false
    Promise.resolve(supabase.storage?.from('line-site-photos').createSignedUrls(visiblePaths, 3600))
      .then(res => {
        if (cancelled || !res?.data) return
        setUrls(u => {
          const next = { ...u }
          res.data.forEach((d, i) => { if (d?.signedUrl) next[visiblePaths[i]] = d.signedUrl })
          return next
        })
      }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey])

  const togglePhase = id => {
    if (phaseIds.includes(id)) {
      // unticking a phase also drops the ticks of its cards
      const drop = new Set(tasks.filter(t => t.phase_id === id).map(t => t.id))
      setSel(s => Object.fromEntries(Object.entries(s).filter(([k]) => !drop.has(k))))
      setPhaseIds(ids => ids.filter(x => x !== id))
    } else {
      setPhaseIds(ids => [...ids, id])
    }
  }
  const toggleCard = id => setSel(s => {
    const n = { ...s }
    if (n[id]) delete n[id]; else n[id] = { photoIds: [], caption: '' }
    return n
  })
  const togglePhoto = (taskId, photoId) => setSel(s => {
    const cur = s[taskId] || { photoIds: [], caption: '' }
    const has = cur.photoIds.includes(photoId)
    return { ...s, [taskId]: { ...cur, photoIds: has ? cur.photoIds.filter(x => x !== photoId) : [...cur.photoIds, photoId] } }
  })
  const setCaption = (taskId, caption) => setSel(s => ({ ...s, [taskId]: { ...(s[taskId] || { photoIds: [] }), caption } }))

  const handleUpload = async (task, files) => {
    if (!files?.length) return
    setUploading(task.id)
    setUploadError(null)
    const failed = []
    for (const file of Array.from(files)) {
      try {
        const res = await uploadSitePhoto({ file, tenantId: tenant?.id, workerId: myWorkerId || null, siteId: invoice.site_id, taskId: task.id, date: bangkokTodayIso() })
        if (!res.id) throw new Error('บันทึกรูปไม่สำเร็จ')
        const photo = { id: res.id, task_id: task.id, photo_path: res.photo_path }
        setExtraPhotos(x => ({ ...x, [task.id]: [...(x[task.id] || []), photo] }))
        setSel(s => {
          const cur = s[task.id] || { photoIds: [], caption: '' }
          return { ...s, [task.id]: { ...cur, photoIds: [...cur.photoIds, photo.id] } }
        })
      } catch (e) {
        failed.push(e)
      }
    }
    setUploading(null)
    if (failed.length) setUploadError(`อัปโหลดไม่สำเร็จ ${failed.length} รูป: ${failed[0]?.message || failed[0]}`)
  }

  const chosen = visibleTasks.filter(t => sel[t.id])
  const photoCount = chosen.reduce((s, t) => s + sel[t.id].photoIds.length, 0)
  const warnings = rows.filter(r => r.check !== 'ok')

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const draft = {
      reportId: current?.id ?? null, invoiceId: invoice.id, siteId: invoice.site_id, phaseIds,
      note: current?.note ?? null,
      cards: chosen.map(t => ({ taskId: t.id, cardTitle: t.name, photoIds: sel[t.id].photoIds, caption: sel[t.id].caption || null })),
    }
    try {
      const report = nextReportStatusOnEdit(current) === 'reissue'
        ? await reissueDeliveryReport(current, draft)
        : await saveDeliveryReport(draft)
      refetch?.()
      onSaved?.(report)
    } catch (e) {
      setSaveError(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const phaseName = id => phases.find(p => p.id === id)?.name ?? ''

  return (
    <Modal title={`รายงานส่งงาน — ${invoice.invoice_number ?? ''}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        {current?.status === 'signed' && (
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>รายงาน {current.report_number} เซ็นแล้ว — บันทึกจะออกฉบับใหม่แทน</div>
        )}
        <section>
          <b style={{ fontSize: 14 }}>ก. งวดนี้ส่งขั้นตอนไหน</b>
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <table className="table" style={{ width: '100%', fontSize: 13 }}>
              <thead><tr><th>ขั้นตอน</th><th style={{ textAlign: 'right' }}>มูลค่า</th><th style={{ textAlign: 'right' }}>weight</th><th style={{ textAlign: 'center' }}>ส่งงวดนี้</th></tr></thead>
              <tbody>
                {phaseRows.map(p => (
                  <tr key={p.id} data-phase={p.id}>
                    <td>{p.name}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(p.value)}</td>
                    <td style={{ textAlign: 'right' }}>{p.pct.toFixed(0)}%</td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" aria-label={`ส่งงวดนี้ ${p.name}`} checked={ticked.has(p.id)} onChange={() => togglePhase(p.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <b style={{ fontSize: 14 }}>ข. เลือกการ์ดและรูป (กรองตามขั้นตอนที่เลือก)</b>
          {!visibleTasks.length && <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 6 }}>ยังไม่ได้เลือกขั้นตอน หรือขั้นตอนนี้ไม่มีการ์ด</div>}
          {phaseIds.map(pid => {
            const group = visibleTasks.filter(t => t.phase_id === pid)
            if (!group.length) return null
            return (
              <div key={pid} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text3)' }}>{phaseName(pid)}</div>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', marginTop: 6 }}>
                  {group.map(t => {
                    const on = !!sel[t.id]
                    const photos = photosOf(t.id)
                    return (
                      <div key={t.id} data-card={t.id} style={{ border: on ? '2px solid var(--accent)' : '1px solid var(--border)', borderRadius: 8, padding: 10, minWidth: 0 }}>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
                          <input type="checkbox" checked={on} onChange={() => toggleCard(t.id)} aria-label={`เลือกการ์ด ${t.name}`} />
                          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.name}</span>
                        </label>
                        {!t.boq_item_id && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ไม่มี BOQ · 0%</span>}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {photos.map(ph => {
                            const picked = !!sel[t.id]?.photoIds.includes(ph.id)
                            return (
                              <button key={ph.id} type="button" aria-pressed={picked} aria-label="รูป" data-photo={ph.id}
                                onClick={() => togglePhoto(t.id, ph.id)} style={{ padding: 0, background: 'none', border: 0 }}>
                                {urls[ph.photo_path]
                                  ? <img src={urls[ph.photo_path]} alt="" style={thumbStyle(picked)} />
                                  : <div style={{ ...thumbStyle(picked), background: 'var(--border)' }} />}
                              </button>
                            )
                          })}
                          <button type="button" className="btn btn-sm" disabled={uploading === t.id}
                            onClick={() => fileRefs.current[t.id]?.click()} style={{ width: 64, height: 64 }}>
                            {uploading === t.id ? '…' : '＋ รูป'}
                          </button>
                          <input type="file" accept="image/*" multiple hidden data-testid={`upload-${t.id}`}
                            ref={el => { fileRefs.current[t.id] = el }}
                            onChange={e => { const f = e.target.files; handleUpload(t, f); e.target.value = '' }} />
                        </div>
                        {on && (
                          <input className="input" style={{ marginTop: 6, width: '100%', boxSizing: 'border-box' }} placeholder="คำบรรยาย"
                            value={sel[t.id].caption} onChange={e => setCaption(t.id, e.target.value)} />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
            เลือก {chosen.length} การ์ด · {photoCount} รูป · กด ＋ รูป เพื่ออัปโหลดรูปเพิ่มเข้าการ์ดนั้น (เก็บไว้ที่การ์ดด้วย งวดหน้าเห็น)
          </div>
        </section>

        {warnings.length > 0 && (
          <section data-testid="dr-warnings" style={{ fontSize: 13 }}>
            <b>ตรวจสอบก่อนบันทึก</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {warnings.map(r => (
                <li key={r.key}>⚠️ {r.description}{r.phaseName ? ` · ${r.phaseName}` : ''}: {r.reasons.map(reasonText).join(', ') || r.check}</li>
              ))}
            </ul>
          </section>
        )}

        {uploadError && <div role="alert" style={{ color: 'var(--red, #dc2626)', fontSize: 13 }}>{uploadError}</div>}
        {saveError && <div role="alert" style={{ color: 'var(--red, #dc2626)', fontSize: 13 }}>{saveError}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>ยกเลิก</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก…' : 'บันทึกรายงาน'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
