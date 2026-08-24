// ============================================================
// SalesReport — รายงานการขาย
// ✅ Every line item from an ACCEPTED quotation (sales_report_view) —
//    draft/sent/rejected/expired quotations never became sales, excluded
//    server-side by the view itself
// ✅ Filter by date range / ไซท์งาน / ลูกค้า / ค้นหารายละเอียด
// ✅ Export Excel — read-only report, no add/edit/delete
// ============================================================
import { useState, useMemo } from 'react'
import { useSalesReport, useSites, useClients } from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { exportToExcel } from '../lib/exportExcel.js'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))
const clientOpts = (clients) => (clients || []).map(c => ({
  value: c.id, label: `${c.client_number} · ${c.name}`, keywords: `${c.client_number} ${c.name}`,
}))

export default function SalesReport() {
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState('')
  const [clientId, setClientId] = useState('')
  const [search,   setSearch]   = useState('')

  const filters = { from: dateFrom, to: dateTo, siteId, clientId, search }
  const { data: rows } = useSalesReport(filters)
  const { data: sites }   = useSites()
  const { data: clients } = useClients()

  const totalAmount = useMemo(() => (rows || []).reduce((s, r) => s + (r.line_total || 0), 0), [rows])
  const totalQty    = useMemo(() => (rows || []).reduce((s, r) => s + (r.quantity || 0), 0), [rows])

  const handleExport = () => {
    const columns = [
      { header: 'วันที่', accessor: r => new Date(r.date) },
      { header: 'เลขที่ใบเสนอราคา', accessor: r => r.quotation_number || '' },
      { header: 'ไซท์งาน', accessor: r => r.site_name || '' },
      { header: 'ลูกค้า', accessor: r => r.client_name || '' },
      { header: 'รายการ', accessor: r => r.description || '' },
      { header: 'จำนวน', accessor: r => r.quantity || 0 },
      { header: 'หน่วย', accessor: r => r.unit || '' },
      { header: 'ราคา/หน่วย', accessor: r => r.unit_price || 0 },
      { header: 'รวม', accessor: r => r.line_total || 0 },
    ]
    exportToExcel(rows || [], columns, `รายงานการขาย_${dateFrom}_ถึง_${dateTo}`)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={handleExport}>📤 Export Excel</button>
        <div style={{ flex: 1 }} />
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหารายการ..." value={search} onChange={e => setSearch(e.target.value)} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={clientId} onChange={setClientId} placeholder="ทุกลูกค้า" options={clientOpts(clients)} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm green"><div className="kpi-label">ยอดขายรวม</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{fmt(totalAmount)} บาท</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">จำนวนรายการ</div><div className="kpi-value">{(rows || []).length} รายการ</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">จำนวนหน่วยรวม</div><div className="kpi-value">{fmt(totalQty, 2)}</div></div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>วันที่</th>
                <th>เลขที่ใบเสนอราคา</th>
                <th>ไซท์งาน</th>
                <th>ลูกค้า</th>
                <th>รายการ</th>
                <th>จำนวน</th>
                <th>ราคา/หน่วย</th>
                <th>รวม</th>
              </tr>
            </thead>
            <tbody>
              {(rows || []).map(r => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text2)', fontSize: 12 }}>{fmtDate(r.date)}</td>
                  <td className="font-mono" style={{ fontSize: 12 }}>{r.quotation_number}</td>
                  <td style={{ fontSize: 11, color: 'var(--accent)' }}>{r.site_name || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.client_name || '—'}</td>
                  <td style={{ fontSize: 13, maxWidth: 260 }}>{r.description}</td>
                  <td style={{ fontSize: 12 }}>{r.quantity} {r.unit || ''}</td>
                  <td className="font-mono" style={{ fontSize: 12 }}>{fmt(r.unit_price)}</td>
                  <td className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(r.line_total)}</td>
                </tr>
              ))}
              {!(rows || []).length && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบข้อมูลการขายในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
