// ============================================================
// AssignOTWizard — bulk OT entry: one date, one shared site, many
// workers each with their own start/end time (and overnight flag).
// onSubmit(rows) with rows = { worker_id, date, site_id, start_time,
// end_time, ot_hours, is_overnight, notes }
// ============================================================
import { useState, useMemo } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import { computeOTHours } from './otMath.js'

export default function AssignOTWizard({ workers = [], sites = [], initialSiteId = '', initialDate = '', onSubmit, onClose, saving }) {
  const [date, setDate]     = useState(initialDate)
  const [siteId, setSiteId] = useState(initialSiteId)
  const [sel, setSel]       = useState({}) // worker_id -> { start, end, overnight }

  const toggleWorker = (id) => setSel(s => {
    const n = { ...s }
    if (n[id]) delete n[id]
    else n[id] = { start: '', end: '', overnight: false }
    return n
  })
  const updateWorker = (id, key, value) => setSel(s => ({ ...s, [id]: { ...s[id], [key]: value } }))

  const selCount = Object.keys(sel).length

  const rows = useMemo(() => Object.entries(sel).map(([worker_id, w]) => ({
    worker_id, ...w, hours: computeOTHours(w.start, w.end, w.overnight),
  })), [sel])

  const submit = () => {
    if (!date)    return alert('เลือกวันที่')
    if (!siteId)  return alert('เลือกไซท์งาน')
    if (!selCount) return alert('เลือกช่างอย่างน้อย 1 คน')
    const incomplete = rows.filter(r => !r.start || !r.end)
    if (incomplete.length) return alert(`กรอกเวลาเริ่ม/จบให้ครบทุกคนที่เลือก (ขาด ${incomplete.length} คน)`)
    const invalid = rows.filter(r => r.hours == null)
    if (invalid.length) return alert(`มี ${invalid.length} คนที่เวลาไม่ถูกต้อง (ถ้าทำงานข้ามคืน ให้ติ๊ก "ข้ามคืน" ของคนนั้น)`)
    onSubmit(rows.map(r => ({
      worker_id: r.worker_id, date, site_id: siteId,
      start_time: r.start, end_time: r.end, ot_hours: r.hours,
      is_overnight: r.overnight, notes: null,
    })))
  }

  return (
    <Modal title="⚡ Assign OT" onClose={onClose} maxWidth={620}>
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        <div className="form-grid-2">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>1 · วันที่</div>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>2 · ไซท์งาน (ใช้ร่วมกันทุกคน)</div>
            <SearchableSelect
              value={siteId} onChange={setSiteId} placeholder="— เลือกไซท์ —"
              options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
            />
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>3 · ช่าง (เลือกหลายคน · กำหนดเวลาแยกต่อคนได้)</div>
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 4 }}>
            {(workers || []).map(w => {
              const on = !!sel[w.id]
              const row = rows.find(r => r.worker_id === w.id)
              return (
                <div key={w.id} style={{
                  padding: '6px 10px', borderRadius: 6,
                  background: on ? 'rgba(255,209,102,.12)' : 'rgba(255,255,255,.04)',
                  border: on ? '1px solid var(--yellow)' : '1px solid transparent',
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggleWorker(w.id)} style={{ width: 16, height: 16 }} />
                    <span style={{ fontSize: 13 }}>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</span>
                  </label>
                  {on && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, marginLeft: 24, flexWrap: 'wrap' }}>
                      <input type="time" className="input input-sm" style={{ width: 110 }}
                        value={sel[w.id].start} onChange={e => updateWorker(w.id, 'start', e.target.value)} />
                      <span style={{ color: 'var(--text3)' }}>—</span>
                      <input type="time" className="input input-sm" style={{ width: 110 }}
                        value={sel[w.id].end} onChange={e => updateWorker(w.id, 'end', e.target.value)} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
                        <input type="checkbox" checked={sel[w.id].overnight} onChange={e => updateWorker(w.id, 'overnight', e.target.checked)} style={{ width: 13, height: 13 }} />
                        🌙 ข้ามคืน
                      </label>
                      {sel[w.id].start && sel[w.id].end && (
                        <span style={{ fontSize: 11, color: row?.hours != null ? 'var(--yellow)' : 'var(--red)' }}>
                          {row?.hours != null ? `= ${row.hours} ชม.` : 'เวลาไม่ถูกต้อง'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {!(workers || []).length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีช่าง</div>}
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>
          {saving ? '⏳ กำลังบันทึก...' : `✅ Assign OT (${selCount} คน)`}
        </button>
      </div>
    </Modal>
  )
}
