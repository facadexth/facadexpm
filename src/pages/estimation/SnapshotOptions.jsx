// src/pages/estimation/SnapshotOptions.jsx
// "บันทึกภาพตัวอย่างพร้อมรายการ": the drawing saved with the item for the quotation (always double-line, no part
// lengths, whatever style is on screen) and the warning when the stored drawing is older than the item.
import { Check } from './ItemFields.jsx'

export default function SnapshotOptions({ snap, onChange, stale, savedAt, onResave, busy, dis }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <Check checked={snap.on} disabled={dis} onChange={v => onChange({ ...snap, on: v })}>
        บันทึกภาพตัวอย่างพร้อมรายการ (เก็บเป็นแบบเส้นคู่เสมอ ไม่มีตัวเลขความยาวชิ้นส่วน)
      </Check>
      {snap.on && (
        <div style={{ display: 'flex', gap: 14, marginLeft: 22 }}>
          <Check checked={snap.out} disabled={dis} onChange={v => onChange({ ...snap, out: v })}>ภายนอก</Check>
          <Check checked={snap.in} disabled={dis} onChange={v => onChange({ ...snap, in: v })}>ภายใน</Check>
        </div>
      )}
      {savedAt && !stale && <div style={{ fontSize: 11, color: 'var(--text3)' }}>มีภาพที่บันทึกไว้เมื่อ {new Date(savedAt).toLocaleString('th-TH')}</div>}
      {stale && (
        <div className="alert" style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', border: '1px solid var(--yellow)' }}>
          <span>ภาพที่บันทึกไว้เก่ากว่าข้อมูล</span>
          {!dis && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onResave}>บันทึกภาพใหม่จากข้อมูลที่บันทึกไว้</button>}
        </div>
      )}
    </div>
  )
}
