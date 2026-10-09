// src/pages/estimation/CutOptimizerPanel.jsx
// Cut optimizer (mockup screen 7), used for the WHOLE project: one profile at a time, every candidate bar length.
// Offcuts never lower a cost (reported only). Kerf and min-keep come from the settings and are shown, not edited.
import { useState, useMemo } from 'react'
import { fmt } from '../../lib/supabase.js'
import { optimizerView } from './projectBomHelpers.js'

const m2 = n => Number(n).toFixed(2)

export default function CutOptimizerPanel({ profiles, seriesMap, index, settings, asOf, canEdit, onUseLength }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const group = profiles.find(g => g.key === key) || profiles[0] || null
  const view = useMemo(() => (group ? optimizerView({ group, index, settings, asOf, seriesIds: seriesMap[group.key] || [] }) : null), [group, index, settings, asOf, seriesMap])
  if (!group || !view) return null

  const use = async L => {
    setBusy(true)
    try { await onUseLength(group.profile_id, L) } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }
  const best = view.rows.find(r => r.best)

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>ตัวช่วยเลือกความยาวเส้น <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(คิดรวมทั้งโครงการ ไม่ใช่ต่อรายการ)</span></div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div><label className="label">หน้าตัด</label>
          <select className="input" value={group.key} onChange={e => setKey(e.target.value)}>
            {profiles.map(g => <option key={g.key} value={g.key}>{g.die_no ? `${g.die_no} ` : ''}{g.name}{g.finish_name ? ` · ${g.finish_name}` : ''}</option>)}
          </select></div>
        <div style={{ fontSize: 12, color: 'var(--text2)' }}>ค่าใบเลื่อย 90°: {settings.kerf_square_mm} มม. · 45°: {settings.kerf_miter_mm} มม. (ชิ้น 45° วัดความยาวด้านนอก) · เศษขั้นต่ำที่เก็บใช้ต่อ: {settings.min_keep_offcut_m} ม. (แก้ที่ตั้งค่า)</div>
      </div>
      <div style={{ fontSize: 12 }} className="font-mono">
        {group.cuts.map(c => `${Number(c.length_m).toFixed(3)}×${c.quantity}${c.style === 'miter45' ? ' (45° ยาวด้านนอก)' : ''}`).join(' · ')}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>ความยาวเส้น (ม.)</th><th>จำนวนเส้น</th><th>เศษทิ้ง (ม.)</th><th>เศษเก็บใช้ต่อ (ม.)</th><th>เศษ %</th><th>ค่าอลูมิเนียม (฿)<div style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>ต้นทุนซื้อเป็นเส้น ใช้เทียบความยาวเท่านั้น ไม่ใช่ยอดอลูมิเนียมในรายการ</div></th><th>ผล</th><th></th></tr></thead>
          <tbody>
            {view.rows.map(r => (
              <tr key={r.length_m} style={r.status === 'infeasible' ? { color: 'var(--text3)' } : undefined}>
                <td className="font-mono">{m2(r.length_m)}{r.isCurrent ? ' (ใช้อยู่)' : ''}</td>
                {r.status === 'infeasible' ? (
                  <>
                    <td colSpan={5} style={{ color: 'var(--red)' }}>ตัดไม่ได้ — ไม่มีที่ลง {r.unplaced.length} ชิ้น ({[...new Set(r.unplaced)].map(x => Number(x).toFixed(3)).join(', ')} ม.)</td>
                    <td>ใช้ไม่ได้</td><td />
                  </>
                ) : (
                  <>
                    <td className="font-mono">{r.count}</td><td className="font-mono">{m2(r.scrap_m)}</td><td className="font-mono">{m2(r.reusable_m)}</td>
                    <td className="font-mono">{r.waste_pct.toFixed(1)}%</td>
                    <td className="font-mono">{r.cost == null ? '—' : fmt(r.cost)}</td>
                    <td>{r.best ? <span className="badge" style={{ color: 'var(--green)' }}>ดีที่สุด</span> : ''}</td>
                    <td>{canEdit && !r.isCurrent && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => use(r.length_m)}>ใช้ความยาวนี้</button>}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text2)', display: 'grid', gap: 2 }}>
        {best && <div>ดีที่สุด: {m2(best.length_m)} ม. (เทียบจาก{view.basis === 'cost' ? 'ค่าอลูมิเนียม' : 'เศษทิ้งน้อยที่สุด'})</div>}
        {!best && view.hasCuts && <div style={{ color: 'var(--red)' }}>ไม่มีความยาวไหนตัดได้ครบ</div>}
        {view.basis === 'scrap' && <div>บางความยาวไม่มีราคาต่อเส้นของความยาวนั้น จึงเทียบจากเศษทิ้งเท่านั้น (ไม่คิดราคาจากความยาวอื่นมาเฉลี่ย)</div>}
        <div>เศษที่เก็บใช้ต่อได้ รายงานไว้เฉยๆ ไม่นำมาลดต้นทุน</div>
        {view.rows.some(r => r.status === 'infeasible') && <div>แถวที่ "ตัดไม่ได้" ไม่นำมาเทียบราคา และไม่เป็นความยาวที่ดีที่สุด</div>}
      </div>
    </div>
  )
}
