// src/pages/bomTemplates/PartSidePanel.jsx
// "แก้ชิ้นที่เลือก" panel (mockup panel()): part name / count, sash overlap (auto / manual + ↺), highlighted pieces,
// position name, one PartLine per profile, "+ เพิ่มโปรไฟล์ในตำแหน่งนี้", position total and the position note.
import { commitPartCount, updatePart, setPositionName, addLineAndSelect, removeLineAndSelect, LAYOUTS } from '../../lib/partModel.js'
import NumInput from './NumInput.jsx'
import PartLine from './PartLine.jsx'
import { ISSUE_TEXT, fmt, posName, partOfKey, positionNote } from './partEditorView.js'

export default function PartSidePanel({ model, view, sel, families, canEdit, onChange, onSelect }) {
  const layout = LAYOUTS[model.layout_kind]
  const key = sel.key
  const pk = partOfKey(model, key)
  const part = model.parts.find(p => p.key === pk) || {}
  const lines = model.lines[key] || []
  const tot = view.positionTotal(key)
  const issues = view.positionIssues(key).filter(r => r !== 'no_profile_family' && r !== 'corner_violation')
  const note = positionNote(model, view, key)
  const posKeys = layout.parts.find(p => p.key === pk)?.positions || []
  const onSelLine = (i) => onSelect({ key, line: i })
  const auto = part.overlap_mode === 'auto_hook'
  return (
    <>
      <div className="parthead">
        <div className="f"><span>Part (sub assembly)</span>
          <input disabled={!canEdit} value={part.name ?? ''} onChange={e => onChange(updatePart(model, pk, { name: e.target.value }))} />
        </div>
        <div className="f"><span>จำนวน part ต่อ 1 ชุด</span>
          <NumInput min={1} step={1} disabled={!canEdit} value={part.count} onChange={v => { const m = commitPartCount(model, pk, v); if (m !== model) onChange(m) }} />
        </div>
      </div>
      {pk === 'sash' && (
        <div className="f">
          <span>ระยะซ้อนบาน (มม.) {auto
            ? <span className="tag">อัตโนมัติ = ความกว้างเสาเกี่ยว</span>
            : <>แก้เอง {canEdit && <button type="button" className="x" title="กลับไปใช้ค่าอัตโนมัติ" onClick={() => onChange(updatePart(model, pk, { overlap_mode: 'auto_hook' }))}>↺</button>}</>}</span>
          <NumInput disabled={!canEdit} value={auto ? view.overlap() : part.overlap_mm}
            onChange={v => onChange(updatePart(model, pk, { overlap_mode: 'manual', overlap_mm: v }))} />
          <small className="h">รางบน/ล่างต่อบาน = (ช่องเปิดวงกบ − เสากุญแจ × 2 − เสาเกี่ยว × 2 + ระยะซ้อน) ÷ 2 โดยค่าอัตโนมัติ = เสาเกี่ยว × 1 เพราะเสาเกี่ยวสองบานซ้อนกัน</small>
        </div>
      )}
      <p className="hint" style={{ margin: '-4px 0 8px' }}>ไฮไลต์ในภาพ: {posKeys.map(k => posName(model, k)).join(' · ')}</p>
      <div className="f"><span>ตำแหน่ง (ชื่อชิ้นส่วนในภาพ)</span>
        <input disabled={!canEdit} value={model.names?.[key] ?? ''} onChange={e => onChange(setPositionName(model, key, e.target.value))} />
      </div>
      {lines.map((l, i) => (
        <PartLine key={i} model={model} view={view} posKey={key} line={l} i={i} n={lines.length} selLine={sel.line}
          families={families} canEdit={canEdit} onChange={onChange} onSelLine={onSelLine}
          onRemove={(idx) => { const r = removeLineAndSelect(model, key, idx); onChange(r.model); onSelect(r.sel) }} />
      ))}
      {canEdit && (
        <button type="button" className="add" onClick={() => { const r = addLineAndSelect(model, key); onChange(r.model); onSelect(r.sel) }}>
          + เพิ่มโปรไฟล์ในตำแหน่งนี้ (เช่น ฝา หรือ คิ้ว)
        </button>
      )}
      <div className="res tot">
        <span><b>รวมตำแหน่งนี้</b> {fmt(tot.totalM, 2)} ม. · {tot.kgAny ? fmt(tot.kg, 2) : '—'} กก. · {tot.bars} เส้น</span>
        {issues.map(r => <span key={r} className="warnline">{ISSUE_TEXT[r] || r}</span>)}
      </div>
      {note && <p className="hint">{note}</p>}
    </>
  )
}
