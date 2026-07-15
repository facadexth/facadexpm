// ============================================================
// CellEditPopup — edit one worker×date×shift assignment
// onSave(row), onDelete(), onClose
// ============================================================
import { useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import { SITE_TYPES } from './constants.js'

const TYPE_OPTS = [
  { k: 'site',    l: '🏗️ งานไซท์' },
  { k: 'factory', l: '🏭 โรงงาน' },
  { k: 'office',  l: '🏢 ออฟฟิศ' },
  { k: 'leave',   l: '🏖️ ลา' },
  { k: 'holiday', l: '🎌 หยุด' },
]

export default function CellEditPopup({ target, sites = [], onSave, onDelete, onClose, saving }) {
  const { worker, date, shift, existing } = target
  const [type, setType]     = useState(existing?.type || 'site')
  const [siteId, setSiteId] = useState(existing?.site_id || '')
  const [ot, setOt]         = useState(existing?.ot || 0)
  const [notes, setNotes]   = useState(existing?.notes || '')

  const needsSite = SITE_TYPES.includes(type)

  const save = () => {
    if (needsSite && !siteId) return alert('เลือกไซท์งาน')
    onSave({
      worker_id: worker.id, date, shift,
      type, site_id: needsSite ? siteId : null,
      ot_hours: parseFloat(ot) || 0,
      notes: notes || null,
    })
  }

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
              options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
            />
          </div>
        )}
        {type === 'site' && (
          <div>
            <label className="label">OT (ชั่วโมง)</label>
            <input type="number" className="input" min="0" step="0.5" value={ot}
              onChange={e => setOt(e.target.value)} placeholder="0 = ไม่มี OT" />
          </div>
        )}
        <div>
          <label className="label">รายละเอียดเพิ่มเติม</label>
          <textarea className="textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
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
