// ============================================================
// Deposits — สรุปยอดมัดจำ (client deposit) คงเหลือต่อไซท์งาน
// ✅ อ่านอย่างเดียว -- การหักมัดจำเกิดอัตโนมัติทุกครั้งที่บันทึกรายรับ
//    'ปกติ' ในหน้า Income ไม่มี action ใดๆ ในหน้านี้
// ============================================================
import { useState, useMemo } from 'react'
import { useSiteDepositSummary } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { depositStatusFor } from '../lib/depositCalc.js'

export default function Deposits({ openSiteOverview }) {
  const { data: rows } = useSiteDepositSummary()
  const [sortCol, setSortCol] = useState('name')
  const [sortDir, setSortDir] = useState('asc')

  const visible = (rows || []).filter(r => r.total_deposit > 0)

  const sorted = useMemo(() => [...visible].sort((a, b) => {
    const va = sortCol === 'status' ? depositStatusFor(a).label : (a[sortCol] ?? '')
    const vb = sortCol === 'status' ? depositStatusFor(b).label : (b[sortCol] ?? '')
    if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
    return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
  }), [visible, sortCol, sortDir])

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>💰 มัดจำ</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          สรุปยอดมัดจำที่เก็บจากลูกค้าต่อไซท์งาน และยอดคงเหลือหลังหักอัตโนมัติจากรายรับแต่ละงวด
        </p>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('name')}>ไซท์งาน{si('name')}</th>
                <th className="sortable" onClick={() => toggleSort('default_deposit_pct')}>% มัดจำ{si('default_deposit_pct')}</th>
                <th className="sortable" onClick={() => toggleSort('total_deposit')}>ยอดมัดจำที่เก็บ{si('total_deposit')}</th>
                <th className="sortable" onClick={() => toggleSort('total_deducted')}>หักไปแล้ว{si('total_deducted')}</th>
                <th className="sortable" onClick={() => toggleSort('remaining_balance')}>คงเหลือ{si('remaining_balance')}</th>
                <th className="sortable" onClick={() => toggleSort('status')}>สถานะ{si('status')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => {
                const status = depositStatusFor(row)
                return (
                  <tr key={row.site_id}>
                    <td style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => openSiteOverview(row.site_id)}>{row.name}</td>
                    <td className="font-mono" style={{ fontSize: 12, color: 'var(--text2)' }}>{row.default_deposit_pct ?? 0}%</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(row.total_deposit)}</td>
                    <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(row.total_deducted)}</td>
                    <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(row.remaining_balance)}</td>
                    <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                  </tr>
                )
              })}
              {!sorted.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ยังไม่มีไซท์งานที่มีมัดจำ</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
