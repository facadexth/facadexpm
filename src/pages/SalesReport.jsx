// ============================================================
// SalesReport — รายงานการขาย
// ✅ Every line item from an ACCEPTED quotation (sales_report_view) —
//    draft/sent/rejected/expired quotations never became sales, excluded
//    server-side by the view itself
// ✅ Filter by date range / ไซท์งาน / ลูกค้า / ค้นหารายละเอียด
// ✅ Two views over the same filtered rows, toggled client-side (no extra
//    fetch): "ตามใบเสนอราคา" (one row per sale, expandable to its items —
//    for lookup) and "ตามสินค้า" (one row per product, totals across every
//    sale — for analysis). A flat table was confusing here because a
//    quotation always has multiple items, repeating date/client/site once
//    per line.
// ✅ Export Excel — read-only report, no add/edit/delete
// ============================================================
import { useState, useMemo, Fragment } from 'react'
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

/** rows -> [{ quotation_id, quotation_number, date, client_name, site_name, items, total }], newest first */
function groupByQuotation(rows) {
  const byId = new Map()
  for (const r of rows || []) {
    if (!byId.has(r.quotation_id)) {
      byId.set(r.quotation_id, {
        quotation_id: r.quotation_id, quotation_number: r.quotation_number, date: r.date,
        client_name: r.client_name, site_name: r.site_name, items: [], total: 0,
      })
    }
    const g = byId.get(r.quotation_id)
    g.items.push(r)
    g.total += r.line_total || 0
  }
  return Array.from(byId.values())
}

/** rows -> [{ key, name, unit, totalQty, totalRevenue, avgPrice, quotationCount }], revenue desc.
 *  Grouped by catalog_item_id when the line came from the catalog (so an
 *  item's per-quotation description tweaks don't split it into several
 *  rows), falling back to exact description text for free-typed lines. */
function groupByProduct(rows) {
  const byKey = new Map()
  for (const r of rows || []) {
    const key = r.catalog_item_id || `desc:${r.description}`
    if (!byKey.has(key)) {
      byKey.set(key, { key, name: r.description, unit: r.unit, totalQty: 0, totalRevenue: 0, quotationIds: new Set() })
    }
    const g = byKey.get(key)
    g.totalQty += r.quantity || 0
    g.totalRevenue += r.line_total || 0
    g.quotationIds.add(r.quotation_id)
  }
  return Array.from(byKey.values())
    .map(g => ({ ...g, avgPrice: g.totalQty ? g.totalRevenue / g.totalQty : 0, quotationCount: g.quotationIds.size }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
}

export default function SalesReport() {
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState('')
  const [clientId, setClientId] = useState('')
  const [search,   setSearch]   = useState('')
  const [view,      setView]     = useState('quotation') // 'quotation' | 'product'
  const [expanded,  setExpanded] = useState(() => new Set())

  const filters = { from: dateFrom, to: dateTo, siteId, clientId, search }
  const { data: rows } = useSalesReport(filters)
  const { data: sites }   = useSites()
  const { data: clients } = useClients()

  const totalAmount = useMemo(() => (rows || []).reduce((s, r) => s + (r.line_total || 0), 0), [rows])
  const totalQty    = useMemo(() => (rows || []).reduce((s, r) => s + (r.quantity || 0), 0), [rows])
  const byQuotation = useMemo(() => groupByQuotation(rows), [rows])
  const byProduct   = useMemo(() => groupByProduct(rows), [rows])

  const toggleExpanded = (id) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

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

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={`btn btn-sm ${view === 'quotation' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('quotation')}>ตามใบเสนอราคา</button>
        <button className={`btn btn-sm ${view === 'product' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('product')}>ตามสินค้า</button>
      </div>

      {view === 'quotation' ? (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>วันที่</th>
                  <th>เลขที่ใบเสนอราคา</th>
                  <th>ไซท์งาน</th>
                  <th>ลูกค้า</th>
                  <th>จำนวนรายการ</th>
                  <th>รวม</th>
                </tr>
              </thead>
              <tbody>
                {byQuotation.map(g => {
                  const open = expanded.has(g.quotation_id)
                  return (
                    <Fragment key={g.quotation_id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => toggleExpanded(g.quotation_id)}>
                        <td style={{ color: 'var(--text3)', width: 20 }}>{open ? '▾' : '▸'}</td>
                        <td style={{ whiteSpace: 'nowrap', color: 'var(--text2)', fontSize: 12 }}>{fmtDate(g.date)}</td>
                        <td className="font-mono" style={{ fontSize: 12 }}>{g.quotation_number}</td>
                        <td style={{ fontSize: 11, color: 'var(--accent)' }}>{g.site_name || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{g.client_name || '—'}</td>
                        <td style={{ fontSize: 11, color: 'var(--text3)' }}>{g.items.length} รายการ</td>
                        <td className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(g.total)}</td>
                      </tr>
                      {open && g.items.map(it => (
                        <tr key={it.id} style={{ background: 'var(--bg3)' }}>
                          <td></td>
                          <td colSpan={2}></td>
                          <td colSpan={2} style={{ fontSize: 12, paddingLeft: 16 }}>{it.description}</td>
                          <td style={{ fontSize: 12, color: 'var(--text3)' }}>{it.quantity} {it.unit || ''} × {fmt(it.unit_price)}</td>
                          <td className="font-mono" style={{ fontSize: 12 }}>{fmt(it.line_total)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  )
                })}
                {!byQuotation.length && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบข้อมูลการขายในช่วงเวลานี้</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>สินค้า</th>
                  <th>จำนวนขายรวม</th>
                  <th>ราคาเฉลี่ย/หน่วย</th>
                  <th>จำนวนใบเสนอราคา</th>
                  <th>ยอดขายรวม</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map(g => (
                  <tr key={g.key}>
                    <td style={{ fontSize: 13 }}>{g.name}</td>
                    <td style={{ fontSize: 12 }}>{fmt(g.totalQty, 2)} {g.unit || ''}</td>
                    <td className="font-mono" style={{ fontSize: 12 }}>{fmt(g.avgPrice)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{g.quotationCount}</td>
                    <td className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(g.totalRevenue)}</td>
                  </tr>
                ))}
                {!byProduct.length && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบข้อมูลการขายในช่วงเวลานี้</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
