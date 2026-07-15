// ============================================================
// AssignWizard — single-panel: days → type → site → workers(+shift)
// onSubmit(rows) with rows = { worker_id, date, shift, site_id, type }
// ============================================================
import { useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import MultiDayPicker from './MultiDayPicker.jsx'

export default function AssignWizard({ workers = [], sites = [], initialSiteId = '', onSubmit, onClose, saving }) {
  const [days, setDays]     = useState(new Set())
  const [type, setType]     = useState('site')          // 'site' | 'factory'
  const [siteId, setSiteId] = useState(initialSiteId)
  const [sel, setSel]       = useState({})              // worker_id -> { am, pm }
  const [notes, setNotes]   = useState('')              // applied to every row in this batch

  const toggleWorker = (id) => setSel(s => {
    const n = { ...s }
    if (n[id]) delete n[id]
    else n[id] = { am: true, pm: true }
    return n
  })
  const toggleShift = (id, k) => setSel(s => {
    if (!s[id]) return s
    return { ...s, [id]: { ...s[id], [k]: !s[id][k] } }
  })

  const selCount = Object.keys(sel).length

  const submit = () => {
    if (!days.size) return alert('เลือกวันอย่างน้อย 1 วัน')
    if (!siteId)    return alert('เลือกไซท์งาน')
    if (!selCount)  return alert('เลือกช่างอย่างน้อย 1 คน')
    const rows = []
    for (const date of days) {
      for (const [worker_id, sh] of Object.entries(sel)) {
        if (sh.am) rows.push({ worker_id, date, shift: 'morning', site_id: siteId, type, notes: notes || null })
        if (sh.pm) rows.push({ worker_id, date, shift: 'evening', site_id: siteId, type, notes: notes || null })
      }
    }
    if (!rows.length) return alert('ทุกช่างถูกปิดกะทั้งเช้าและบ่าย')
    onSubmit(rows)
  }

  return (
    <Modal title="Assign งาน" onClose={onClose} maxWidth={620}>
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        {/* 1. days */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>1 · เลือกวันทำงาน</div>
          <MultiDayPicker value={days} onChange={setDays} />
        </div>

        {/* 2. type */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>2 · ประเภทงาน</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ k: 'site', l: '🏗️ งานไซท์' }, { k: 'factory', l: '🏭 ผลิตที่โรงงาน' }].map(o => (
              <button key={o.k} type="button" onClick={() => setType(o.k)}
                className={`btn btn-sm ${type === o.k ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1 }}>{o.l}</button>
            ))}
          </div>
          {type === 'factory' && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ผลิตที่โรงงานให้ไซท์นี้ — ลงค่าแรงให้ไซท์ แต่ไม่มีค่าเดินทาง</div>}
        </div>

        {/* 3. site */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>3 · ไซท์งาน</div>
          <SearchableSelect
            value={siteId} onChange={setSiteId} placeholder="— เลือกไซท์ —"
            options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
          />
        </div>

        {/* 4. workers */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>4 · ช่าง (เลือกหลายคน · ค่าเริ่มต้นเช้า+บ่าย)</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 4 }}>
            {(workers || []).map(w => {
              const on = !!sel[w.id]
              return (
                <div key={w.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
                  background: on ? 'rgba(108,99,255,.15)' : 'rgba(255,255,255,.04)',
                  border: on ? '1px solid var(--accent)' : '1px solid transparent',
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
                    <input type="checkbox" checked={on} onChange={() => toggleWorker(w.id)} style={{ width: 16, height: 16 }} />
                    <span style={{ fontSize: 13 }}>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</span>
                  </label>
                  {on && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[{ k: 'am', l: 'เช้า' }, { k: 'pm', l: 'บ่าย' }].map(s => (
                        <button key={s.k} type="button" onClick={() => toggleShift(w.id, s.k)}
                          className={`btn btn-sm ${sel[w.id][s.k] ? 'btn-primary' : 'btn-ghost'}`}
                          style={{ fontSize: 11, padding: '2px 8px' }}>{s.l}</button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {!(workers || []).length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีช่าง</div>}
          </div>
        </div>

        {/* 5. notes */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>5 · รายละเอียดเพิ่มเติม (ถ้ามี — ใช้ร่วมกันทุกวัน/ทุกคนที่เลือก)</div>
          <textarea className="textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>
          {saving ? '⏳ กำลังบันทึก...' : `✅ Assign (${days.size} วัน × ${selCount} ช่าง)`}
        </button>
      </div>
    </Modal>
  )
}
