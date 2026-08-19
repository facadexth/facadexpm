// ============================================================
// Deposits — สรุปยอดมัดจำ (client deposit) คงเหลือต่อไซท์งาน
// ✅ อ่านอย่างเดียว -- การหักมัดจำเกิดอัตโนมัติทุกครั้งที่บันทึกรายรับ
//    'ปกติ' ในหน้า Income ไม่มี action ใดๆ ในหน้านี้
// ============================================================
import { useSiteDepositSummary } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'

function statusFor(row) {
  if (row.remaining_balance > 0) return { label: 'คงเหลือ', cls: 'badge-paid' }
  return { label: 'หักครบแล้ว', cls: 'badge-finished' }
}

export default function Deposits() {
  const { data: rows } = useSiteDepositSummary()

  const visible = (rows || []).filter(r => r.total_deposit > 0)

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
                <th>ไซท์งาน</th>
                <th>% มัดจำ</th>
                <th>ยอดมัดจำที่เก็บ</th>
                <th>หักไปแล้ว</th>
                <th>คงเหลือ</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => {
                const status = statusFor(row)
                return (
                  <tr key={row.site_id}>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</td>
                    <td className="font-mono" style={{ fontSize: 12, color: 'var(--text2)' }}>{row.default_deposit_pct ?? 0}%</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(row.total_deposit)}</td>
                    <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(row.total_deducted)}</td>
                    <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(row.remaining_balance)}</td>
                    <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                  </tr>
                )
              })}
              {!visible.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ยังไม่มีไซท์งานที่มีมัดจำ</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
