// src/pages/estimation/CustomLengthSummary.jsx
// "สรุปการซื้อเส้น" of a project job (custom lengths): per profile + colour, the stock-length baseline, the least-kg
// length, what the cut plan actually uses, and why custom lengths were dropped (minimum order) or what they save.
import { useState } from 'react'
import { fmt } from '../../lib/supabase.js'
import { customLengthSummaryModel } from './projectBomHelpers.js'
import InlineError from './InlineError.jsx'

const f2 = n => Number(n).toFixed(2)
const note = { fontSize: 11, color: 'var(--text3)' }

export default function CustomLengthSummary({ plan, compare, prices, kgPerM, settings, canEdit, onUse, onUseAll }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const stockL = f2(settings.stock_length_m)
  const m = customLengthSummaryModel({ plan, compare, prices, kgPerM })
  const run = async fn => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  const anyUse = m.rows.some(r => r.canUse)

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }}>สรุปการซื้อเส้น</div>
        {canEdit && anyUse && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(onUseAll)}>ใช้ทั้งหมด</button>}
      </div>
      {error && <InlineError title="บันทึกไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>หน้าตัด</th><th>กก./ม.</th><th>{stockL} ม.: เส้น / กก.</th><th>ความยาวที่ดีที่สุด</th><th>ใช้</th>
            <th>เส้นใหม่</th><th>เศษสต็อก</th><th>กก. ที่ซื้อ</th><th>ค่าอลูมิเนียม ฿</th>{canEdit && <th />}
          </tr></thead>
          <tbody>
            {m.rows.map(r => (
              <tr key={r.key}>
                <td>
                  {r.die_no ? <b>{r.die_no}</b> : null} {r.name}{r.finish_name ? ` · ${r.finish_name}` : ''}
                  {r.no_weight && <div style={note}>ไม่มีน้ำหนัก/ม. ใช้ {stockL} ม.</div>}
                  {r.overrideRejected && <div style={note}>ความยาวที่เลือกตัดไม่ได้ ใช้ความยาวที่ดีที่สุดแทน</div>}
                  {r.unplaced > 0 && <div style={{ fontSize: 11, color: 'var(--red)' }}>ตัดไม่ได้ {r.unplaced} ท่อน</div>}
                </td>
                <td className="font-mono">{r.kgPerM == null ? '—' : f2(r.kgPerM)}</td>
                <td className="font-mono">{!r.baseFeasible ? <span style={{ color: 'var(--red)' }}>{stockL} ตัดไม่ได้</span> : r.baseBars == null ? '—' : `${r.baseBars} / ${f2(r.baseKg)}`}</td>
                <td className="font-mono">
                  {r.bestLength == null ? '—' : Math.abs(r.bestLength - settings.stock_length_m) < 1e-9 ? `${stockL} ดีอยู่แล้ว` : `${f2(r.bestLength)} ม.`}
                  {r.bestSavingKg > 0 && <> <span className="badge" style={{ color: 'var(--green)' }}>−{f2(r.bestSavingKg)} กก.</span></>}
                </td>
                <td className="font-mono">{f2(r.useLength)}</td>
                <td className="font-mono">{r.newBars}</td>
                <td className="font-mono">{r.offcutBars}</td>
                <td className="font-mono">{f2(r.kg)}</td>
                <td className="font-mono">{r.cost == null ? '—' : fmt(r.cost)}</td>
                {canEdit && <td>{r.canUse && <>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => onUse(r.profile_id, r.bestLength))}>ใช้ {f2(r.bestLength)}</button>
                  {r.sharedProfile && <div style={note}>ใช้กับทุกสีของหน้าตัดนี้</div>}
                </>}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            <td colSpan={7}><b>รวม</b></td><td className="font-mono"><b>{f2(m.totalKg)}</b></td>
            <td className="font-mono"><b>{m.cost == null ? '—' : fmt(m.cost)}</b></td>{canEdit && <td />}
          </tr></tfoot>
        </table>
      </div>
      {plan.reason === 'moq'
        ? <div className="alert alert-warning" style={{ fontSize: 13 }}>สั่งความยาวพิเศษรวม <b className="font-mono">{f2(plan.customKg)}</b> กก. ไม่ถึงขั้นต่ำ <b className="font-mono">{Number(settings.custom_moq_kg).toLocaleString('en-US')}</b> กก. — ใช้เส้น {stockL} ม. ทั้งโครงการ</div>
        : m.savingKg > 1e-6
          ? <div className="alert alert-success" style={{ fontSize: 13 }}>สั่งความยาวพิเศษรวม <b className="font-mono">{f2(plan.customKg)}</b> กก. · ประหยัด <b className="font-mono">{f2(m.savingKg)}</b> กก.{m.savingBaht != null && <> ≈ <b className="font-mono">{fmt(m.savingBaht)}</b> ฿</>} เทียบกับ {stockL} ม.</div>
          : !m.anyCustom
            ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>ความยาวพิเศษไม่ช่วยลดน้ำหนักที่ซื้อ — ใช้ {stockL} ม.</div>
            : <div style={{ fontSize: 12, color: 'var(--text2)' }}>สั่งความยาวพิเศษรวม <b className="font-mono">{f2(plan.customKg)}</b> กก.</div>}
      {plan.reason !== 'moq' && m.excluded > 0 && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ไม่รวม {m.excluded} หน้าตัดที่ {stockL} ม. ตัดไม่ได้ (ไม่นำมาเทียบน้ำหนักที่ประหยัด)</div>}
    </div>
  )
}
