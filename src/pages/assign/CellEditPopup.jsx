// ============================================================
// CellEditPopup — edit one worker×date×shift assignment, plus an
// optional OT entry for that worker+date (independent of shift;
// see docs/superpowers/specs/2026-08-14-ot-decouple-design.md).
// onSave(row), onDelete(), onSaveOT(row), onDeleteOT(), onClose
// ============================================================
import { useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import { SITE_TYPES } from './constants.js'
import { computeOTHours } from './otMath.js'

const TYPE_OPTS = [
  { k: 'site',    l: '🏗️ งานไซท์' },
  { k: 'factory', l: '🏭 โรงงาน' },
  { k: 'office',  l: '🏢 ออฟฟิศ' },
  { k: 'leave',   l: '🏖️ ลา' },
  { k: 'holiday', l: '🎌 หยุด' },
]

export default function CellEditPopup({ target, sites = [], onSave, onDelete, onSaveOT, onDeleteOT, onClose, saving }) {
  const { worker, date, shift, existing, existingOT } = target
  const [type, setType]     = useState(existing?.type || 'site')
  const [siteId, setSiteId] = useState(existing?.site_id || '')
  const [notes, setNotes]   = useState(existing?.notes || '')

  const [otSiteId, setOtSiteId] = useState(existingOT?.site_id || existing?.site_id || '')
  const [otStart, setOtStart]   = useState(existingOT?.start_time?.slice(0, 5) || '')
  const [otEnd, setOtEnd]       = useState(existingOT?.end_time?.slice(0, 5) || '')
  const [otNotes, setOtNotes]   = useState(existingOT?.notes || '')

  const needsSite = SITE_TYPES.includes(type)
  const otHours = computeOTHours(otStart, otEnd)
  const otStarted = otSiteId || otStart || otEnd  // user has begun filling in OT
  // True once the user has any actual shift intent: editing something that
  // already exists, or having changed the shift form away from its blank
  // default. False for a truly empty cell where only OT is being entered —
  // in that case we must NOT create a phantom shift row just to satisfy
  // needsSite validation, since that would silently add a half-day of
  // labor cost the worker never actually worked (the exact bug OT
  // decoupling was built to eliminate).
  const wantsShiftSave = !!existing || !!siteId || !!notes || type !== 'site'

  const save = () => {
    if (wantsShiftSave && needsSite && !siteId) return alert('เลือกไซท์งาน')
    if (otStarted && (!otSiteId || !otStart || !otEnd)) {
      return alert('กรอกไซท์งาน เวลาเริ่ม และเวลาจบของ OT ให้ครบ')
    }
    if (otStart && otEnd && otHours == null) {
      return alert('เวลาจบ OT ต้องอยู่หลังเวลาเริ่ม')
    }
    if (!wantsShiftSave && !otStarted) return alert('กรุณากรอกข้อมูลกะ หรือ OT อย่างน้อยหนึ่งอย่าง')
    if (wantsShiftSave) {
      onSave({
        worker_id: worker.id, date, shift,
        type, site_id: needsSite ? siteId : null,
        notes: notes || null,
      })
    }
    if (otStarted && otHours != null) {
      onSaveOT({
        worker_id: worker.id, date,
        site_id: otSiteId, start_time: otStart, end_time: otEnd,
        ot_hours: otHours, notes: otNotes || null,
      })
    }
  }

  const siteOptions = sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))

  return (
    <Modal title={`${worker.nickname || worker.name} · ${date} · ${shift === 'morning' ? 'เช้า' : 'บ่าย'}`} onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ประเภท</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TYPE_OPTS.map(o => (
              <button key={o.k} type="button" onClick={() => setType(o.k)}
                className={`btn btn-sm ${type === o.k ? 'btn-primary' : 'btn-ghost'}`}>{o.l}</button>
            ))}
          </div>
        </div>
        {needsSite && (
          <div>
            <label className="label">ไซท์งาน</label>
            <SearchableSelect
              value={siteId} onChange={setSiteId} placeholder="— เลือกไซท์ —"
              options={siteOptions}
            />
          </div>
        )}
        <div>
          <label className="label">รายละเอียดเพิ่มเติม</label>
          <textarea className="textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label className="label">⚡ OT (ไม่ผูกกับกะเช้า/บ่าย — สูงสุด 1 ช่วง/คน/วัน)</label>
          <div style={{ marginBottom: 8 }}>
            <SearchableSelect
              value={otSiteId} onChange={setOtSiteId} placeholder="— เลือกไซท์งาน OT —"
              options={siteOptions}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 11 }}>เวลาเริ่ม</label>
              <input type="time" className="input" value={otStart} onChange={e => setOtStart(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 11 }}>เวลาจบ</label>
              <input type="time" className="input" value={otEnd} onChange={e => setOtEnd(e.target.value)} />
            </div>
          </div>
          {otStart && otEnd && (
            <div style={{ fontSize: 12, color: otHours != null ? 'var(--yellow)' : 'var(--red)', marginBottom: 6 }}>
              {otHours != null ? `= ${otHours} ชม.` : 'เวลาจบต้องอยู่หลังเวลาเริ่ม'}
            </div>
          )}
          <input className="input" style={{ marginBottom: 6 }} value={otNotes} onChange={e => setOtNotes(e.target.value)} placeholder="หมายเหตุ OT (ถ้ามี)" />
          {existingOT && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onDeleteOT} disabled={saving}>🗑️ ลบ OT</button>
          )}
        </div>
      </div>
      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <div>
          {existing && <button className="btn btn-sm btn-danger" onClick={onDelete} disabled={saving}>🗑️ ลบ</button>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '⏳...' : '✅ บันทึก'}</button>
        </div>
      </div>
    </Modal>
  )
}
