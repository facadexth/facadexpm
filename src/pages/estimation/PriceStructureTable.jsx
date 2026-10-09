// Price structure table: one row per item, cost categories, price steps, SUMPRODUCT footer.
import { useState } from 'react'
import { supabase, fmt } from '../../lib/supabase.js'
import { visibleColumns, columnValue, sumproductRow, COLUMN_LABELS, glassHover } from '../../lib/priceStructureView.js'
import { unresolvedSummary } from './projectDefaults.js'
import { nextProfitCellState, profitInputValue, isOwnProfit, SQFT_PER_SQM } from './priceStructureTabModel.js'

const NO_TEMPLATE = 'ไม่พบแบบ (Template) ของรายการนี้'
const DASH = '—'
const num = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? DASH : fmt(v))

function ProfitCell({ item, row, canEdit, onSaved }) {
  const own = isOwnProfit(item.profit_pct)
  const [draft, setDraft] = useState(null)   // text while typing; null = show the saved value
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const write = async (value) => {
    setBusy(true)
    try {
      const { error } = await supabase.from('estimation_openings').update({ profit_pct: value }).eq('id', item.id)
      if (error) throw error
      setDraft(null); setErr(null)
      await onSaved()
    } catch (e) { setErr('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }
  const commit = () => {
    if (draft === null) return
    const r = nextProfitCellState(draft, item.profit_pct)
    if (r.action === 'error') { setErr(r.message); return }
    setErr(null)
    if (r.action === 'noop') { setDraft(null); return }
    write(r.value)
  }
  const id = `follow-${item.id}`
  const projectPct = row && Number.isFinite(row.profitPct) ? row.profitPct : 0
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <label htmlFor={id} style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end', fontSize: 11, cursor: canEdit ? 'pointer' : 'default' }}>
        <input id={id} type="checkbox" checked={!own} disabled={!canEdit || busy} onChange={e => { setErr(null); write(e.target.checked ? null : projectPct) }} />
        {own ? 'ตามโปรเจกต์' : `ตามโปรเจกต์ ${projectPct.toFixed(1)}%`}
      </label>
      {own && (
        <span style={{ display: 'flex', gap: 3, alignItems: 'center', justifyContent: 'flex-end' }}>
          <input className="input" type="number" min="0" step="any" style={{ width: 64, padding: '2px 4px' }} disabled={!canEdit || busy} value={profitInputValue(item.profit_pct, draft)}
            onChange={e => { setDraft(e.target.value); setErr(null) }} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />%
        </span>
      )}
      {err && <div style={{ color: 'var(--red)', fontSize: 11 }}>{err}</div>}
    </div>
  )
}

export default function PriceStructureTable({ items, rows, costs, infillTypesById, canEdit, onItemsSaved, total, actions }) {
  const cols = visibleColumns(rows)
  const sp = sumproductRow(rows, cols)
  const ok = (rows || []).filter(r => r && r.resolved)
  const qtySum = ok.reduce((s, r) => s + (Number(r.quantity) || 0), 0)
  const kgSum = ok.reduce((s, r) => s + (Number(r.aluWeightKg) || 0) * (Number(r.quantity) || 0), 0)
  const perSetSum = ok.reduce((s, r) => s + (Number(r.perSet) || 0) * (Number(r.quantity) || 0), 0)
  const rowById = Object.fromEntries((rows || []).map(r => [r.id, r]))
  const span = 4 + cols.length + 10
  return (
    <div className="card">
      <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text3)' }}>
        ค่าเผื่อเศษ กำไร ขนส่ง PM และขั้นการปัด ตั้งต่อโปรเจกต์ที่เดียว ยกเว้นกำไรที่ติ๊กออกเพื่อปรับ % รายรายการได้ (ใต้ตัวเลขกำไรของแต่ละแถว) ต้นทุนแต่ละหมวดมาจากการคิดของแต่ละรายการ (อลูมิเนียม อุปกรณ์ กระจก ค่าแรง) ส่วน Fire Barrier / Bracket / ดัดโค้ง กรอกในฟอร์มรายการเป็นจำนวนเงินต่อชุด
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>รายการ</th><th>กว้าง×สูง (ม.)</th><th>จำนวน</th><th>นน.อลูมิเนียม กก./ชุด</th>
              {cols.map(k => <th key={k}>{k === 'glass' ? 'กระจก (รหัส)' : COLUMN_LABELS[k]}</th>)}
              <th>รวมต้นทุน</th><th>เผื่อเสียเศษ</th><th>กำไร</th><th>ราคาขาย</th><th>ค่าขนส่ง</th><th>PM</th>
              <th>ราคาต่อชุด (รวม)</th><th>ราคาขายจริง</th><th>฿/ตร.ม.</th><th>รวม</th>
            </tr>
          </thead>
          <tbody>
            {(items || []).map(it => {
              const row = rowById[it.id]
              const good = !!(row && row.resolved)
              const cost = costs ? costs[it.id] : null
              const reason = cost ? unresolvedSummary(cost.unresolved) : NO_TEMPLATE
              const infillId = cost && cost.resolved ? cost.resolved.infill_type_id : null
              const infill = infillId && infillTypesById ? infillTypesById[infillId] : null
              const hover = glassHover(infill)
              const area = Number(it.width_m) * Number(it.height_m)
              return (
                <tr key={it.id}>
                  <td>
                    <b>{it.opening_no}</b> {it.item_name || ''}
                    {!good && <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 400, whiteSpace: 'pre-line' }}>{reason || 'คิดราคาไม่ได้'}</div>}
                  </td>
                  <td className="font-mono">{num(it.width_m)} × {num(it.height_m)}</td>
                  <td className="font-mono">{row ? row.quantity : DASH}</td>
                  <td className="font-mono">{good ? fmt(row.aluWeightKg) : DASH}</td>
                  {cols.map(k => {
                    if (k === 'glass' && hover) {
                      const areaTxt = Number.isFinite(area) && area > 0 ? ` · พื้นที่ ${fmt(area)} ตร.ม. (${fmt(area * SQFT_PER_SQM)} ตร.ฟ.)` : ''
                      return <td key={k} className="font-mono" style={{ cursor: 'help' }} title={`${hover.code} ${hover.name} · ${fmt(hover.perSqm)} บาท/ตร.ม. (${fmt(hover.perSqft)} บาท/ตร.ฟ.)${areaTxt}`}>
                        <span style={{ color: 'var(--text3)' }}>{hover.code}</span> {good ? fmt(columnValue(row, k)) : DASH}
                      </td>
                    }
                    return <td key={k} className="font-mono">{good ? fmt(columnValue(row, k)) : DASH}</td>
                  })}
                  <td className="font-mono">{good ? fmt(row.v) : DASH}</td>
                  <td className="font-mono">{good ? fmt(row.w) : DASH}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="font-mono">{good ? fmt(row.x) : DASH}</div>
                    <ProfitCell item={it} row={row} canEdit={canEdit} onSaved={onItemsSaved} />
                  </td>
                  <td className="font-mono">{good ? fmt(row.y) : DASH}</td>
                  <td className="font-mono">{good ? fmt(row.z) : DASH}</td>
                  <td className="font-mono">{good ? fmt(row.pm) : DASH}</td>
                  <td className="font-mono">{good ? fmt(row.perSet) : DASH}</td>
                  <td className="font-mono" style={{ fontWeight: 600 }}>{good ? num(row.price) : DASH}</td>
                  <td className="font-mono">{good ? num(row.perSqm) : DASH}</td>
                  <td className="font-mono" style={{ fontWeight: 600 }}>{good ? fmt(row.lineTotal) : DASH}</td>
                </tr>
              )
            })}
            {!(items || []).length && <tr><td colSpan={span} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่องเปิด</td></tr>}
          </tbody>
          {(items || []).length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>SUMPRODUCT (ต้นทุน × จำนวน)</td><td />
                <td className="font-mono">{qtySum}</td><td className="font-mono">{fmt(kgSum)} กก.</td>
                {cols.map(k => <td key={k} className="font-mono">{fmt(sp[k])}</td>)}
                <td className="font-mono">{fmt(sp.v)}</td><td className="font-mono">{fmt(sp.w)}</td><td className="font-mono">{fmt(sp.x)}</td>
                <td className="font-mono">{fmt(sp.y)}</td><td className="font-mono">{fmt(sp.z)}</td><td className="font-mono">{fmt(sp.pm)}</td>
                <td className="font-mono">{fmt(perSetSum)}</td><td className="font-mono">{fmt(sp.lineTotal)}</td><td />
                <td className="font-mono">{fmt(sp.lineTotal)}</td>
              </tr>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={span - 1} style={{ textAlign: 'right' }}>
                  <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
                    <span>รวมทั้งโปรเจกต์ (ก่อน VAT) = ผลรวมราคาขายจริง × จำนวน</span>{actions}
                  </span>
                </td>
                <td className="font-mono">{fmt(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)' }}>
        ราคาขาย = รวมต้นทุน + เผื่อเสียเศษ + กำไร · ค่าขนส่ง = ขนส่งทั้งโปรเจกต์กระจายตามสัดส่วนราคาขาย · ราคาต่อชุด = ราคาขาย + ค่าขนส่ง + PM · ราคาขายจริง = ปัดขึ้น · คอลัมน์ต้นทุนที่ทุกรายการเป็น 0 ซ่อนอัตโนมัติ · เอาเมาส์ชี้ที่ช่องกระจกเพื่อดูรหัสและราคาต่อ ตร.ม./ตร.ฟ.
      </div>
    </div>
  )
}
