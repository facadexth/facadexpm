// src/pages/estimation/ProjectStockField.jsx
// The project's own stock length (estimation_projects.stock_length_m). The text is seeded from the project once;
// the parent renders it with key={project.id}, so another project always starts from its own value.
import { useState } from 'react'
import { parseStockLength } from './projectBomHelpers.js'

export default function ProjectStockField({ project, defaultM, canEdit, onSave }) {
  const [text, setText] = useState(project.stock_length_m ? String(project.stock_length_m) : '')
  const commit = async () => {
    const v = parseStockLength(text)
    const was = project.stock_length_m ? Number(project.stock_length_m) : null
    if (Number.isNaN(v)) { alert('ความยาวเส้นต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 20 ม.'); setText(was ? String(was) : ''); return }
    if (v === was) return
    try { await onSave(project.id, v) } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <label className="label" style={{ margin: 0 }}>ความยาวเส้นของโปรเจกต์ (ม.)</label>
      <input className="input" style={{ width: 100 }} inputMode="decimal" disabled={!canEdit} value={text} placeholder={String(defaultM)}
        onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      <span style={{ fontSize: 12, color: 'var(--text3)' }}>ว่าง = ค่ามาตรฐานของบริษัท {defaultM} ม. · ลำดับ: ตั้งเองต่อหน้าตัด &gt; ของโปรเจกต์ &gt; มาตรฐาน</span>
    </div>
  )
}
