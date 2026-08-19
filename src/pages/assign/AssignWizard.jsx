// ============================================================
// AssignWizard — single-panel: days → type → site → workers(+shift)
// onSubmit(rows) with rows = { worker_id, date, shift, site_id, type }
// ============================================================
import { useMemo } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import MultiDayPicker from './MultiDayPicker.jsx'
import { useDraftForm } from '../../hooks/useDraftForm.js'

const EMPTY_FORM = { days: [], type: 'site', siteId: '', sel: {}, notes: '' }

export default function AssignWizard({ workers = [], sites = [], initialSiteId = '', onSubmit, onClose, saving }) {
  // days persists as a plain array (localStorage-safe) and is only a Set
  // at the edges, where MultiDayPicker requires one.
  const [form, setForm, clearFormDraft] = useDraftForm('assign-wizard', { ...EMPTY_FORM, siteId: initialSiteId })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const days = useMemo(() => new Set(form.days), [form.days])
  const setDays = (nextSet) => set('days', Array.from(nextSet))

  const toggleWorker = (id) => setForm(f => {
    const n = { ...f.sel }
    if (n[id]) delete n[id]
    else n[id] = { am: true, pm: true }
    return { ...f, sel: n }
  })
  const toggleShift = (id, k) => setForm(f => {
    if (!f.sel[id]) return f
    return { ...f, sel: { ...f.sel, [id]: { ...f.sel[id], [k]: !f.sel[id][k] } } }
  })

  const selCount = Object.keys(form.sel).length

  const submit = () => {
    if (!days.size)        return alert('เลือกวันอย่างน้อย 1 วัน')
    if (!form.siteId)      return alert('เลือกไซท์งาน')
    if (!selCount)         return alert('เลือกช่างอย่างน้อย 1 คน')
    const rows = []
    for (const date of days) {
      for (const [worker_id, sh] of Object.entries(form.sel)) {
        if (sh.am) rows.push({ worker_id, date, shift: 'morning', site_id: form.siteId, type: form.type, notes: form.notes || null })
        if (sh.pm) rows.push({ worker_id, date, shift: 'evening', site_id: form.siteId, type: form.type, notes: form.notes || null })
      }
    }
    if (!rows.length) return alert('ทุกช่างถูกปิดกะทั้งเช้าและบ่าย')
    clearFormDraft()
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
              <button key={o.k} type="button" onClick={() => set('type', o.k)}
                className={`btn btn-sm ${form.type === o.k ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1 }}>{o.l}</button>
            ))}
          </div>
          {form.type === 'factory' && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ผลิตที่โรงงานให้ไซท์นี้ — ลงค่าแรงให้ไซท์ แต่ไม่มีค่าเดินทาง</div>}
        </div>

        {/* 3. site */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>3 · ไซท์งาน</div>
          <SearchableSelect
            value={form.siteId} onChange={id => set('siteId', id)} placeholder="— เลือกไซท์ —"
            options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
          />
        </div>

        {/* 4. workers */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>4 · ช่าง (เลือกหลายคน · ค่าเริ่มต้นเช้า+บ่าย)</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 4 }}>
            {(workers || []).map(w => {
              const on = !!form.sel[w.id]
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
                          className={`btn btn-sm ${form.sel[w.id][s.k] ? 'btn-primary' : 'btn-ghost'}`}
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
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
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
