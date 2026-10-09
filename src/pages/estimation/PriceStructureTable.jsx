// Price structure table: one row per item, cost categories, price steps, SUMPRODUCT footer.
import { useState } from 'react'
import { supabase, fmt } from '../../lib/supabase.js'
import { visibleColumns, columnValue, sumproductRow, COLUMN_LABELS, glassHover } from '../../lib/priceStructureView.js'
import { unresolvedSummary } from './projectDefaults.js'

const NO_TEMPLATE = 'ไม่พบแบบ (Template) ของรายการนี้'
const DASH = '—'
const num = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? DASH : fmt(v))

function ProfitCell({ item, row, canEdit, onSaved }) {
  const own = item.profit_pct !== null && item.profit_pct !== undefined && item.profit_pct !== ''
  const [text, setText] = useState(own ? String(item.profit_pct) : '')
  const [busy, setBusy] = useState(false)
  const write = async (value) => {
    setBusy(true)
    try {
      const { error } = await supabase.from('estimation_openings').update({ profit_pct: value }).eq('id', item.id)
      if (error) throw error
      await onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }
  const commit = () => {
    const raw = text.trim()
    const x = Number(raw)
    if (raw === '' || !Number.isFinite(x) || x < 0) { setText(own ? String(item.profit_pct) : ''); return }
    if (own && x === Number(item.profit_pct)) return
    write(x)
  }
  const id = `follow-${item.id}`
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <label htmlFor={id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, cursor: canEdit ? 'pointer' : 'default' }}>
        <input id={id} type="checkbox" checked={!own} disabled={!canEdit || busy} onChange={e => write(e.target.checked ? null : (row && Number.isFinite(row.profitPct) ? row.profitPct : 0))} />
        ตามโปรเจกต์
      </label>
      {own
        ? <input className="input" type="number" min="0" step="any" style={{ width: 70, padding: '2px 6px' }} disabled={!canEdit || busy} value={text}
          onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        : (row && row.resolved && <span className="font-mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{fmt(row.profitPct)}%</span>)}
    </div>
  )
}

export default function PriceStructureTable({ items, rows, costs, infillTypesById, canEdit, onItemsSaved }) {
  const cols = visibleColumns(rows)
  const sp = sumproductRow(rows, cols)
  const rowById = Object.fromEntries((rows || []).map(r => [r.id, r]))
  const span = 2 + cols.length + 12
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>เลขช่อง</th><th>ขนาด (ม.)</th>
              {cols.map(k => <th key={k}>{COLUMN_LABELS[k]}</th>)}
              <th>รวมต้นทุน</th><th>เผื่อเสียเศษ</th><th>กำไร</th><th>ราคาขาย</th><th>ค่าขนส่ง</th><th>PM</th><th>รวม/ชุด</th>
              <th>ราคาขายจริง</th><th>ราคาต่อชุดต่อตร.ม.</th><th>จำนวน</th><th>รวม</th>
            </tr>
          </thead>
          <tbody>
            {(items || []).map(it => {
              const row = rowById[it.id]
              const ok = !!(row && row.resolved)
              const cost = costs ? costs[it.id] : null
              const reason = cost ? unresolvedSummary(cost.unresolved) : NO_TEMPLATE
              const infillId = cost && cost.resolved ? cost.resolved.infill_type_id : null
              const infill = infillId && infillTypesById ? infillTypesById[infillId] : null
              const hover = glassHover(infill)
              return (
                <tr key={it.id}>
                  <td style={{ fontWeight: 600 }}>
                    {it.opening_no}
                    {!ok && <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 400, whiteSpace: 'pre-line' }}>{reason || 'คิดราคาไม่ได้'}</div>}
                  </td>
                  <td className="font-mono">{num(it.width_m)} × {num(it.height_m)}</td>
                  {cols.map(k => {
                    if (k === 'glass' && hover) {
                      return <td key={k} className="font-mono" title={`${hover.name} · ${fmt(hover.perSqm)} ฿/ตร.ม. · ${fmt(hover.perSqft)} ฿/ตร.ฟ.`}>
                        {ok ? fmt(columnValue(row, k)) : DASH} <span style={{ fontSize: 10, color: 'var(--text3)' }}>{hover.code}</span>
                      </td>
                    }
                    return <td key={k} className="font-mono">{ok ? fmt(columnValue(row, k)) : DASH}</td>
                  })}
                  <td className="font-mono">{ok ? fmt(row.v) : DASH}</td>
                  <td className="font-mono">{ok ? fmt(row.w) : DASH}</td>
                  <td>
                    <div className="font-mono">{ok ? fmt(row.x) : DASH}</div>
                    <ProfitCell item={it} row={row} canEdit={canEdit} onSaved={onItemsSaved} />
                  </td>
                  <td className="font-mono">{ok ? fmt(row.y) : DASH}</td>
                  <td className="font-mono">{ok ? fmt(row.z) : DASH}</td>
                  <td className="font-mono">{ok ? fmt(row.pm) : DASH}</td>
                  <td className="font-mono">{ok ? fmt(row.perSet) : DASH}</td>
                  <td className="font-mono" style={{ fontWeight: 600 }}>{ok ? num(row.price) : DASH}</td>
                  <td className="font-mono">{ok ? num(row.perSqm) : DASH}</td>
                  <td className="font-mono">{row ? row.quantity : DASH}</td>
                  <td className="font-mono" style={{ fontWeight: 600 }}>{ok ? fmt(row.lineTotal) : DASH}</td>
                </tr>
              )
            })}
            {!(items || []).length && <tr><td colSpan={span} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่องเปิด</td></tr>}
          </tbody>
          {(items || []).length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={2}>SUMPRODUCT</td>
                {cols.map(k => <td key={k} className="font-mono">{fmt(sp[k])}</td>)}
                <td className="font-mono">{fmt(sp.v)}</td><td className="font-mono">{fmt(sp.w)}</td><td className="font-mono">{fmt(sp.x)}</td>
                <td className="font-mono">{fmt(sp.y)}</td><td className="font-mono">{fmt(sp.z)}</td><td className="font-mono">{fmt(sp.pm)}</td>
                <td /><td /><td /><td />
                <td className="font-mono">{fmt(sp.lineTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
