// src/pages/estimation/ItemsTable.jsx
// Items of one project with their live price. Unresolved prices read "—" and say why in a tooltip, never 0.
import { useState } from 'react'
import { supabase, fmt } from '../../lib/supabase.js'
import { typeLabel } from '../../lib/typeTree.js'
import { seriesLabelShort } from '../../lib/aluCatalog.js'
import { itemStatus, unresolvedSummary, parseQuantity } from './projectDefaults.js'

const STATUS = { ok: ['ok', 'var(--green)'], unresolved: ['ราคาไม่ครบ', 'var(--red)'], old_preview: ['ภาพเก่า', 'var(--amber, #b88600)'] }

function QuantityCell({ item, canEdit, onSaved }) {
  const [text, setText] = useState(String(item.quantity))
  const [busy, setBusy] = useState(false)
  const commit = async () => {
    if (text === String(item.quantity)) return
    const q = parseQuantity(text)
    if (q === null) { alert('จำนวนชุดต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป'); setText(String(item.quantity)); return }
    setBusy(true)
    try {
      const { error } = await supabase.from('estimation_openings').update({ quantity: q }).eq('id', item.id)
      if (error) throw error
      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message); setText(String(item.quantity)) }
    finally { setBusy(false) }
  }
  return (
    <input className="input input-sm font-mono" style={{ width: 70 }} inputMode="numeric" disabled={!canEdit || busy} value={text}
      onClick={e => e.stopPropagation()} onChange={e => setText(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}

export default function ItemsTable({ items, costs, project, index, templatesById, canEdit, onOpen, onQuantitySaved }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead><tr><th>เลขช่อง</th><th>ชื่อรายการ</th><th>ประเภท</th><th>ซีรีส์</th><th>สถานะ</th><th>ขนาด</th><th>จำนวนชุด</th><th>ราคา/ชุด</th><th>รวม</th><th></th></tr></thead>
          <tbody>
            {items.map(o => {
              const cost = costs[o.id]
              const status = itemStatus(o, cost)
              const priced = cost && status !== 'unresolved' && Number.isFinite(cost.total)
              const tpl = templatesById[o.template_id]
              const seriesId = o.series_id || project.default_series_id
              const series = seriesId ? index.series[seriesId] : null
              const reasons = cost ? unresolvedSummary(cost.unresolved) : 'ไม่พบแบบ (Template) ของรายการนี้'
              const qty = Number(o.quantity) || 1
              return (
                <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(o.id)}>
                  <td style={{ fontWeight: 600 }}>{o.opening_no}</td>
                  <td>{o.item_name || '—'}</td>
                  <td>{tpl && tpl.type_id ? typeLabel(index.types, tpl.type_id) : (tpl ? tpl.name : '—')}</td>
                  <td>{series ? seriesLabelShort(series, index.providers[series.provider_id]) : (o.series || '—')}</td>
                  <td><span title={status === 'unresolved' ? reasons : undefined} style={{ color: STATUS[status][1], fontWeight: 600 }}>{STATUS[status][0]}</span></td>
                  <td className="font-mono">{o.width_m} x {o.height_m} m</td>
                  <td><QuantityCell key={`${o.id}-${o.quantity}`} item={o} canEdit={canEdit} onSaved={onQuantitySaved} /></td>
                  <td className="font-mono" title={priced ? undefined : reasons}>{priced ? fmt(cost.total) : '—'}</td>
                  <td className="font-mono" title={priced ? undefined : reasons}>{priced ? fmt(cost.total * qty) : '—'}</td>
                  <td><button className="btn btn-sm btn-ghost">แก้ไข</button></td>
                </tr>
              )
            })}
            {!items.length && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่องเปิด</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
