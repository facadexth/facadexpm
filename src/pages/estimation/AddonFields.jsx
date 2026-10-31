// src/pages/estimation/AddonFields.jsx
// "ของเพิ่มเติม" (add-on unit) of the item popup: type, BOM template (same series as the main item), size, panels,
// position (บน/ล่าง/ซ้าย/ขวา) and offset from the left or top edge (blank = centred). Half filled = no add-on yet.
import { Field } from './ItemFields.jsx'

const POSITIONS = [['top', 'ด้านบน'], ['bottom', 'ด้านล่าง'], ['left', 'ด้านซ้าย'], ['right', 'ด้านขวา']]
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }

export default function AddonFields({ form, update, typeId, typeOptions, templateOptions, onPickType, violations, dis }) {
  const offsetHint = form.addon_position === 'left' || form.addon_position === 'right' ? 'วัดจากขอบบน ว่าง = กึ่งกลาง' : 'วัดจากขอบซ้าย ว่าง = กึ่งกลาง'
  return (
    <div style={{ display: 'grid', gap: 10, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>ของเพิ่มเติม <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>เลือกจากประเภทที่ซีรีส์เดียวกันผลิตได้</span></div>
      <div style={grid}>
        <Field label="ประเภท">
          <select className="input" disabled={dis} value={form.has_addon ? typeId || '?' : ''} onChange={e => onPickType(e.target.value)}>
            <option value="">— ไม่มี —</option>
            {form.has_addon && !typeId && <option value="?">ไม่ระบุประเภท</option>}
            {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        {form.has_addon && (
          <Field label="เทมเพลต BOM ★">
            <select className="input" disabled={dis} value={form.addon_template_id} onChange={e => update({ addon_template_id: e.target.value })}>
              {!form.addon_template_id && <option value="">— เลือก —</option>}
              {templateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        )}
      </div>
      {form.has_addon && (
        <div style={grid}>
          <Field label="กว้าง (มม.) ★"><input className="input" type="number" min="0" step="1" disabled={dis} value={form.addon_width_m} onChange={e => update({ addon_width_m: e.target.value })} /></Field>
          <Field label="สูง (มม.) ★"><input className="input" type="number" min="0" step="1" disabled={dis} value={form.addon_height_m} onChange={e => update({ addon_height_m: e.target.value })} /></Field>
          <Field label="แบ่งกี่ช่อง (ใน 1 ชุด)" hint="ปกติ 1 · ใส่ 2 ขึ้นไปเมื่อมีเสากลางแบ่ง"><input className="input" type="number" min="1" step="1" disabled={dis} value={form.addon_panel_count} onChange={e => update({ addon_panel_count: e.target.value })} /></Field>
          <Field label="ตำแหน่ง">
            <select className="input" disabled={dis} value={form.addon_position} onChange={e => update({ addon_position: e.target.value })}>
              {POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="ระยะจากขอบ (มม.)" hint={offsetHint}><input className="input" type="number" min="0" step="1" disabled={dis} value={form.addon_offset_m} onChange={e => update({ addon_offset_m: e.target.value })} /></Field>
        </div>
      )}
      {(violations || []).map((msg, i) => <div key={i} className="alert alert-error" style={{ fontSize: 13 }}>⚠️ ของเพิ่มเติม: {msg}</div>)}
    </div>
  )
}
