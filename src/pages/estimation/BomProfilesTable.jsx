// src/pages/estimation/BomProfilesTable.jsx
// Section 1 of the project BOM: aluminium by profile + colour. Merged cut list, total metres, stock length
// (editable per profile), bars and offcut. Lengths are metres (stored rows), as in the mockup.
import { useState } from 'react'
import { parseStockLength } from './projectBomHelpers.js'

const m2 = n => Number(n).toFixed(2)
const m3 = n => Number(n).toFixed(3)

function StockCell({ group, overridden, canEdit, onSave }) {
  const [text, setText] = useState(overridden ? String(group.stock_length_m) : '')
  const [busy, setBusy] = useState(false)
  const commit = async () => {
    const v = parseStockLength(text)
    if (Number.isNaN(v)) { alert('ความยาวเส้นต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 20 ม.'); setText(overridden ? String(group.stock_length_m) : ''); return }
    if ((v === null && !overridden) || v === group.stock_length_m && overridden) return
    setBusy(true)
    try { await onSave(group.profile_id, v) } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }
  return (
    <div>
      <input className="input input-sm font-mono" style={{ width: 80 }} inputMode="decimal" disabled={!canEdit || busy} value={text}
        placeholder={m2(group.stock_length_m)} onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>{overridden ? 'ตั้งเอง' : 'ใช้ค่าของโปรเจกต์/ค่ามาตรฐาน'}</div>
    </div>
  )
}

export default function BomProfilesTable({ profiles, overrides, canEdit, onSaveStock }) {
  if (!profiles.length) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีเส้นอลูมิเนียมที่คิดราคาได้</div>
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>หน้าตัด</th><th>สี</th><th>รายการตัด (ม. × ชิ้น)</th><th>ความยาวรวม (ม.)</th><th>ความยาวเส้น (ม.)</th><th>จำนวนเส้น</th><th>เศษเก็บใช้ต่อได้ (ม.)</th><th>เศษทิ้ง (ม.)</th></tr></thead>
        <tbody>
          {profiles.map(g => (
            <tr key={g.key}>
              <td>{g.die_no ? <b>{g.die_no}</b> : null} {g.name}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{g.openings.join(', ')}</div></td>
              <td>{g.finish_name || '—'}</td>
              <td style={{ fontSize: 12 }}>{g.cuts.map(c => <div key={`${c.length_m}|${c.style}`} className="font-mono">{m3(c.length_m)} × {c.quantity} <span style={{ color: 'var(--text3)' }}>{c.style === 'miter45' ? '45°' : '90°'}</span></div>)}</td>
              <td className="font-mono">{m2(g.cut_total_m)}</td>
              <td><StockCell key={`${g.key}|${g.stock_length_m}`} group={g} overridden={Object.prototype.hasOwnProperty.call(overrides, g.profile_id)} canEdit={canEdit} onSave={onSaveStock} /></td>
              <td className="font-mono">{g.unplaced.length ? <span style={{ color: 'var(--red)' }}>วางไม่ได้ {g.unplaced.length} ชิ้น (ยาวเกินเส้น)</span> : g.count}</td>
              <td className="font-mono">{m2(g.reusable_m)}</td>
              <td className="font-mono">{m2(g.scrap_m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
