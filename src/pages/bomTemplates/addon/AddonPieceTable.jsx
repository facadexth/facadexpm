// src/pages/bomTemplates/addon/AddonPieceTable.jsx
// Every row of the add-on's piece set (mockup v12 #azTable). "ความยาว × ท่อน (มม.)" is the row's own expandAddons
// result (addonView.pieceTableRows); ext / main_facing show their effect on the main unit; a row that cannot be
// priced shows the unresolved Thai text instead of a number. Clicking a row selects it in the side panel.
import { fmt, fmtCount } from '../partEditorView.js'

export function lengthCell(r) {
  if (r.effect) return r.effect
  if (r.length != null) return `${fmt(r.length)} × ${fmtCount(r.qty)}` + (r.factor != null && r.factor !== 1 ? ` (× ${r.factor})` : '')
  if (r.unresolved) return null
  return r.qty > 0 ? '—' : 'ไม่ใช้ (0 ท่อน)'
}

export default function AddonPieceTable({ rows, selIdx, onPick }) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr><th>ชิ้นส่วน</th><th>โปรไฟล์</th><th>อ้างอิงจาก</th><th>× ความยาว</th><th>หัก</th><th>ปริมาณ</th><th>ความยาว × ท่อน (มม.)</th></tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const cell = lengthCell(r)
            return (
              <tr key={r.i} className={'pick' + (r.i === selIdx ? ' sel' : '')} data-pc={r.key} tabIndex={0}
                onClick={() => onPick(r.i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.i) } }}>
                <td>{r.label}</td>
                <td>{r.family || 'ไม่ระบุ'}</td>
                <td>{r.refLabel}</td>
                <td className="n">{r.factor ?? '—'}</td>
                <td className="n">{fmt(r.ded)}</td>
                <td>{r.qtyLabel} = {fmtCount(r.qty)}</td>
                <td className={r.effect ? '' : 'n'}>{cell}{r.unresolved && <span className="warnline">{cell ? ' · ' : ''}{r.unresolved}</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
