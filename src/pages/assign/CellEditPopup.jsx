// ============================================================
// CellEditPopup — edit one worker×date×shift assignment, plus an
// optional OT entry for that worker+date (independent of shift;
// see docs/superpowers/specs/2026-08-14-ot-decouple-design.md).
// onSave(row), onDelete(), onSaveOT(row), onDeleteOT(), onClose
// ============================================================
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import { SITE_TYPES } from './constants.js'
import { computeOTHours } from './otMath.js'
import { useDraftForm } from '../../hooks/useDraftForm.js'

const TYPE_OPTS = [
  { k: 'site',            l: '🏗️ งานไซท์' },
  { k: 'factory',         l: '🏭 โรงงาน' },
  { k: 'office',          l: '🏢 ออฟฟิศ' },
  { k: 'leave_sick',      l: '🤒 ลาป่วย' },
  { k: 'leave_personal',  l: '🏖️ ลากิจ' },
  { k: 'holiday',         l: '🎌 หยุด' },
]

export default function CellEditPopup({ target, sites = [], onSave, onDelete, onSaveOT, onDeleteOT, onConfirm, onClose, saving }) {
  const { worker, date, shift, existing, existingOT } = target

  // Draft key is specific to this exact cell — a generic key would let a
  // draft typed for one worker/date/shift silently resurface on a totally
  // different cell the next time this popup opens. Only persists for a
  // genuinely blank cell (no existing shift AND no existing OT), matching
  // the isAdd convention used elsewhere: an abandoned edit to a row that
  // already has real saved data must not silently overwrite it later.
  const cellKey = `cell-edit:${worker.id}:${date}:${shift}`
  const isFreshCell = !existing && !existingOT

  const [form, setForm, clearFormDraft] = useDraftForm(cellKey, {
    // Historical rows may still carry the old undifferentiated 'leave' type
    // (no longer offered in TYPE_OPTS going forward). Falling back to 'site'
    // for it here would silently reclassify the row as a work day the
    // instant someone reopens and saves it without touching the type
    // buttons — treat it as leave_personal instead, matching how
    // handleCalcFromAssign already treats legacy 'leave' rows for payroll.
    type: existing?.type === 'leave' ? 'leave_personal' : (existing?.type || 'site'),
    siteId: existing?.site_id || '',
    notes: existing?.notes || '',
    otSiteId: existingOT?.site_id || existing?.site_id || '',
    otStart: existingOT?.start_time?.slice(0, 5) || '',
    otEnd: existingOT?.end_time?.slice(0, 5) || '',
    otOvernight: existingOT?.is_overnight || false,
    otNotes: existingOT?.notes || '',
  }, isFreshCell)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const needsSite = SITE_TYPES.includes(form.type)
  const otHours = computeOTHours(form.otStart, form.otEnd, form.otOvernight)
  const otStarted = form.otSiteId || form.otStart || form.otEnd  // user has begun filling in OT
  // True once the user has any actual shift intent: editing something that
  // already exists, or having changed the shift form away from its blank
  // default. False for a truly empty cell where only OT is being entered —
  // in that case we must NOT create a phantom shift row just to satisfy
  // needsSite validation, since that would silently add a half-day of
  // labor cost the worker never actually worked (the exact bug OT
  // decoupling was built to eliminate).
  const wantsShiftSave = !!existing || !!form.siteId || !!form.notes || form.type !== 'site'

  const save = () => {
    if (wantsShiftSave && needsSite && !form.siteId) return alert('เลือกไซท์งาน')
    if (otStarted && (!form.otSiteId || !form.otStart || !form.otEnd)) {
      return alert('กรอกไซท์งาน เวลาเริ่ม และเวลาจบของ OT ให้ครบ')
    }
    if (form.otStart && form.otEnd && otHours == null) {
      return alert('เวลาจบ OT ต้องอยู่หลังเวลาเริ่ม (ถ้าทำงานข้ามคืน ให้ติ๊ก "ทำงานข้ามคืน" ด้านล่าง)')
    }
    if (!wantsShiftSave && !otStarted) return alert('กรุณากรอกข้อมูลกะ หรือ OT อย่างน้อยหนึ่งอย่าง')
    clearFormDraft()
    if (wantsShiftSave) {
      onSave({
        worker_id: worker.id, date, shift,
        type: form.type, site_id: needsSite ? form.siteId : null,
        notes: form.notes || null,
      })
    }
    if (otStarted && otHours != null) {
      onSaveOT({
        worker_id: worker.id, date,
        site_id: form.otSiteId, start_time: form.otStart, end_time: form.otEnd,
        ot_hours: otHours, is_overnight: form.otOvernight, notes: form.otNotes || null,
      })
    }
  }

  // otSiteId/otStart/otEnd/etc. are only seeded from existingOT once, at
  // mount. Deleting OT doesn't close this popup, so without clearing these
  // explicitly the time inputs keep showing the just-deleted values — and
  // clicking "บันทึก" afterward (e.g. to save an unrelated shift edit)
  // would silently re-create the OT entry that was just deleted.
  const deleteOT = async () => {
    await onDeleteOT()
    setForm(f => ({ ...f, otSiteId: '', otStart: '', otEnd: '', otOvernight: false, otNotes: '' }))
  }

  const siteOptions = sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))

  return (
    <Modal title={`${worker.nickname || worker.name} · ${date} · ${shift === 'morning' ? 'เช้า' : 'บ่าย'}`} onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ประเภท</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TYPE_OPTS.map(o => (
              <button key={o.k} type="button" onClick={() => set('type', o.k)}
                className={`btn btn-sm ${form.type === o.k ? 'btn-primary' : 'btn-ghost'}`}>{o.l}</button>
            ))}
          </div>
        </div>
        {needsSite && (
          <div>
            <label className="label">ไซท์งาน</label>
            <SearchableSelect
              value={form.siteId} onChange={id => set('siteId', id)} placeholder="— เลือกไซท์ —"
              options={siteOptions}
            />
          </div>
        )}
        {needsSite && existing && (
          <div style={{ fontSize: 12.5 }}>
            {existing.confirmed_at ? (
              <span style={{ color: 'var(--green)' }}>
                ✅ {existing.confirmed_by === 'checkin' ? 'ยืนยันแล้ว (เช็คอินจริง)' : `ยืนยันโดยแอดมิน (${existing.confirmed_by})`}
                {' '}· {new Date(existing.confirmed_at).toLocaleString('th-TH')}
              </span>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--yellow)' }}>⏳ รอการยืนยัน (ยังไม่นับเป็นค่าแรง)</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onConfirm} disabled={saving}>ยืนยันเอง</button>
              </div>
            )}
          </div>
        )}
        <div>
          <label className="label">รายละเอียดเพิ่มเติม</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label className="label">⚡ OT (ไม่ผูกกับกะเช้า/บ่าย — สูงสุด 1 ช่วง/คน/วัน)</label>
          <div style={{ marginBottom: 8 }}>
            <SearchableSelect
              value={form.otSiteId} onChange={id => set('otSiteId', id)} placeholder="— เลือกไซท์งาน OT —"
              options={siteOptions}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 11 }}>เวลาเริ่ม</label>
              <input type="time" className="input" value={form.otStart} onChange={e => set('otStart', e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 11 }}>เวลาจบ</label>
              <input type="time" className="input" value={form.otEnd} onChange={e => set('otEnd', e.target.value)} />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.otOvernight} onChange={e => set('otOvernight', e.target.checked)} style={{ width: 14, height: 14 }} />
            🌙 ทำงานข้ามคืน (เลิกงานหลังเที่ยงคืน)
          </label>
          {form.otStart && form.otEnd && (
            <div style={{ fontSize: 12, color: otHours != null ? 'var(--yellow)' : 'var(--red)', marginBottom: 6 }}>
              {otHours != null ? `= ${otHours} ชม.` : 'เวลาจบต้องอยู่หลังเวลาเริ่ม (หรือติ๊ก "ทำงานข้ามคืน")'}
            </div>
          )}
          <input className="input" style={{ marginBottom: 6 }} value={form.otNotes} onChange={e => set('otNotes', e.target.value)} placeholder="หมายเหตุ OT (ถ้ามี)" />
          {existingOT && (
            <button type="button" className="btn btn-sm btn-danger" onClick={deleteOT} disabled={saving}>🗑️ ลบ OT</button>
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
