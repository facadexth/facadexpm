// src/pages/bomTemplates/PartTable.jsx
// Components table grouped by part (mockup table()): one row per profile line, extra "↳ ความยาวไม่เท่ากัน" rows for
// pieces of a different length, part totals in the part header row. Click / Enter on a row selects that line.
import { RULE_LABELS, ISSUE_TEXT, fmt, fmtCount, posName, endText } from './partEditorView.js'

export default function PartTable({ model, view, sel, onSelect }) {
  const rows = []
  for (const P of view.parts) {
    rows.push(
      <tr className="ph" key={'p-' + P.key}>
        <td colSpan={8}>Part: {P.name} × {P.count}</td>
        <td className="n">{fmt(P.totalM, 2)}</td>
        <td className="n">{P.kgAny ? fmt(P.kg, 2) : '—'}</td>
      </tr>,
    )
    for (const key of P.keys) {
      (model.lines[key] || []).forEach((l, i) => {
        const r = view.lines[key]?.[i] || { groups: [] }
        const pick = {
          className: 'pick' + (key === sel.key ? ' sel' : ''), tabIndex: 0,
          onClick: () => onSelect({ key, line: i }),
          onKeyDown: e => { if (e.key === 'Enter') onSelect({ key, line: i }) },
        }
        const head = (
          <>
            <td>{i === 0 ? posName(model, key) : <span className="sub">↳ ในตำแหน่งเดียวกัน</span>}</td>
            <td>{l.profile_family || <span className="sub">—</span>}</td>
            <td>{RULE_LABELS[l.length_rule_type] || l.length_rule_type}</td>
            <td className="n">{l.length_factor ?? '—'}</td>
            <td>{endText(l)}</td>
            <td className="n">{l.quantity_value ?? '—'}</td>
            <td>{l.thickness_role === 'sash' ? 'บาน' : 'กรอบ'}</td>
          </>
        )
        if (r.unresolved || !r.groups.length) {
          rows.push(<tr key={`${key}-${i}`} {...pick}>{head}<td colSpan={3}><span className="tag">{ISSUE_TEXT[r.unresolved || 'no_model']}</span></td></tr>)
          return
        }
        r.groups.forEach((g, gi) => {
          rows.push(
            <tr key={`${key}-${i}-${gi}`} {...pick}>
              {gi === 0 ? head : <td colSpan={7}><span className="sub">↳ ความยาวไม่เท่ากัน เพิ่มบรรทัดให้</span></td>}
              <td className="n">{fmt(g.len)} × {fmtCount(g.n)}</td>
              <td className="n">{fmt(g.totalM, 2)}</td>
              <td className="n">{g.kg == null ? '—' : fmt(g.kg, 2)}</td>
            </tr>,
          )
        })
      })
    }
  }
  return (
    <div className="tw">
      <table>
        <thead>
          <tr><th>ตำแหน่ง</th><th>อลูมิเนียม</th><th>วิธีคิด</th><th>× ความยาว</th><th>ปลาย (แต่ละชิ้น)</th><th>จำนวน/ชิ้นที่วาด</th><th>ความหนา</th><th>ความยาวต่อชิ้น × ปริมาณ (มม.)</th><th>ยาวรวม (ม.)</th><th>น้ำหนัก (กก.)</th></tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}
