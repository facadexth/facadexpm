// A4 document for a delivery report (รายงานส่งงาน, DR). Plan B task 6.
// Page 1 summary table + 3-colour bar, then one page per site plan, then card blocks
// (1 or 2 per page by size, up to 4 photos each), signature block at the end (own page when the
// last card page is over ~60% full). Pagination is by simple size estimates, not DOM measurement.
// Pages use fixed mm heights like WorkPhotosDocumentModal (Invoices.jsx): 270mm, not 277mm,
// so html2pdf.js page-break padding never adds an empty page.
import { useEffect, useMemo, useState } from 'react'
import { supabase, fmt } from '../../../lib/supabase.js'
import { useTenant } from '../../../hooks/useTenant.js'
import { useDeliveryReport } from '../../../hooks/useDeliveryReport.js'
import { markColour, MARK_PREV, MARK_THIS, MARK_REMAINING, buildCompactRows, defaultReportMode } from '../../../lib/deliveryReport.js'
import { downloadPDF } from '../../../lib/pdf.js'
import { Modal } from '../../../components/Modal.jsx'
import RowActionsMenu from '../../../components/RowActionsMenu.jsx'
import PlanMarkup from './PlanMarkup.jsx'

const PAGE_HEIGHT_MM = 270
const ROWS_PER_PAGE = 14
const COMPACT_ROWS_PER_PAGE = 16
const qtyTxt = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100))
const DESC_MAX = 90
const clip = (t, n) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n - 1) + '…' : x }
const thDate = d => (d ? new Date(d).toLocaleDateString('th-TH') : '')
const pct = (n, total) => (total ? Math.round(n / total * 1000) / 10 : 0)

async function signUrls(bucket, paths) {
  if (!paths.length) return {}
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, 3600)
  if (error) throw error
  const out = {}
  ;(data || []).forEach((d, i) => { if (d?.signedUrl) out[paths[i]] = d.signedUrl })
  return out
}

// Card size in page units (a page holds 2): >2 photos or a long caption takes a whole page.
// A card with no photos is a title line only: 4 fit on a page.
function cardUnits(c, shownCount) {
  if (shownCount === 0 && String(c.caption || '').length <= 120) return 0.5
  return shownCount > 2 || String(c.caption || '').length > 120 ? 2 : 1
}

export function DeliveryReportDocument({ data, report, tenant, urls = {}, receipt = null, signatureUrl = null, elementId = 'dr-doc', mode = 'detailed', showAll = false }) {
  const { invoice, rows = [], totals = {}, cards = [], tasks = [], phases = [], photosByTask = {}, plans = [], marksByPlan = {}, reports = [], replacedBy = null, site = null } = data
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const phaseName = new Map(phases.map(p => [p.id, p.name]))
  const replaced = report?.replaces_id ? reports.find(r => r.id === report.replaces_id) : null

  // Plan colours: this report's cards = orange; cards of issued/signed reports of earlier
  // invoices (from the hook) = green; rest grey.
  const thisTaskIds = new Set(cards.map(c => c.task_id).filter(Boolean))
  const prevTaskIds = new Set((data.prevTaskIds || []).filter(id => !thisTaskIds.has(id)))
  const colourFor = id => markColour(id, { prevTaskIds, thisTaskIds })
  const cardOrder = cards.map(c => c.task_id)

  const contract = Number(totals.contract) || 0
  const prevPct = pct(totals.prev || 0, contract)
  const thisPct = pct(totals.this || 0, contract)
  const remPct = pct(totals.remaining || 0, contract)

  // Phases with 0% weight and nothing billed are all zeros: leave them off the paper.
  const shownRows = rows.filter(r => r.value || r.prev || r.this || r.remaining)
  // Grouped by phase (site phase order), each group led by a subtotal line; rows with no phase
  // (no-BOQ lines) go last under "อื่น ๆ". A group header counts as one table line.
  const phaseOrder = new Map(phases.map((p, i) => [p.id, i]))
  const groups = new Map()
  for (const r of shownRows) {
    const k = r.phaseId ?? '_other'
    if (!groups.has(k)) groups.set(k, { key: `g|${k}`, name: r.phaseId ? (r.phaseName || phaseName.get(r.phaseId) || '–') : 'อื่น ๆ', rows: [] })
    groups.get(k).rows.push(r)
  }
  const sumOf = (rs, f) => rs.reduce((a, r) => a + (Number(r[f]) || 0), 0)
  const lines = [...groups.entries()]
    .sort(([a], [b]) => (a === '_other' ? 1e9 : phaseOrder.get(a) ?? 1e8) - (b === '_other' ? 1e9 : phaseOrder.get(b) ?? 1e8))
    .flatMap(([, g], gi) => [
      { group: true, key: g.key, n: gi + 1, name: g.name, value: sumOf(g.rows, 'value'), prev: sumOf(g.rows, 'prev'), this: sumOf(g.rows, 'this'), remaining: sumOf(g.rows, 'remaining') },
      ...g.rows,
    ])
  // Compact (แบบย่อ): one line per item, phases as columns. Whole rows per page, header repeated
  // on every page (each page is its own table), so no row is ever split.
  const compact = mode === 'compact' ? buildCompactRows(rows, phases, { showAll }) : null
  const tableLines = compact ? compact.rows : lines
  const perPage = compact ? COMPACT_ROWS_PER_PAGE : ROWS_PER_PAGE
  const rowPages = []
  for (let i = 0; i < tableLines.length; i += perPage) rowPages.push(tableLines.slice(i, i + perPage))
  if (!rowPages.length) rowPages.push([])
  const shownPhotos = c => {
    const task = c.task_id ? taskById.get(c.task_id) : null
    if (!task) return []
    const byId = new Map((photosByTask[task.id] || []).map(p => [p.id, p]))
    return (c.photo_ids || []).map(id => byId.get(id)).filter(p => p && urls[p.photo_path]).slice(0, 4)
  }
  const cardPages = []
  let cur = null
  cards.forEach((c, i) => {
    const u = cardUnits(c, shownPhotos(c).length)
    if (!cur || cur.units + u > 2) { cur = { items: [], units: 0 }; cardPages.push(cur) }
    cur.items.push({ c, n: i + 1 })
    cur.units += u
  })
  // Signature goes on the last card page only when that page is at most ~60% full (1 small card).
  const sigOwnPage = !cardPages.length || cardPages[cardPages.length - 1].units / 2 > 0.6

  const pages = [
    ...rowPages.map((r, i) => ({ kind: 'table', rows: r, last: i === rowPages.length - 1 })),
    ...plans.map(p => ({ kind: 'plan', plan: p })),
    ...cardPages.map((p, i) => ({ kind: 'cards', items: p.items, sig: !sigOwnPage && i === cardPages.length - 1 })),
    ...(sigOwnPage ? [{ kind: 'cards', items: [], sig: true }] : []),
  ]

  const header = (title, n) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '5mm', marginBottom: '3mm', borderBottom: '1px solid #e4e6ef', paddingBottom: '2mm' }}>
      <div style={{ display: 'flex', gap: '3mm', alignItems: 'center' }}>
        {tenant?.logo_url && <img src={tenant.logo_url} alt="" crossOrigin="anonymous" style={{ maxHeight: '14mm', width: 'auto' }} />}
        <div>
          <div style={{ fontSize: 12, fontWeight: 800 }}>{tenant?.company_name}</div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
        </div>
      </div>
      <div style={{ textAlign: 'right', fontSize: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 12 }}>รายงานส่งงาน {report?.report_number || ''}</div>
        <div>อ้างอิงใบแจ้งหนี้ {invoice?.invoice_number}</div>
        {replaced && <div>แทนฉบับ {replaced.report_number}</div>}
        {site?.name && <div>{site.site_number ? `${site.site_number} · ` : ''}{site.name}</div>}
        <div>{thDate(report?.date)}</div>
        <div style={{ color: '#9296a8' }}>หน้า {n} / {pages.length}</div>
      </div>
    </div>
  )
  const banner = replacedBy && (
    <div data-testid="dr-replaced" style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fca5a5', borderRadius: 4, padding: '1.5mm 3mm', fontSize: 11, fontWeight: 800, marginBottom: '3mm', textAlign: 'center' }}>
      ฉบับนี้ถูกแทนด้วย {replacedBy.report_number}
    </div>
  )
  const withBanner = (title, n) => <>{header(title, n)}{banner}</>

  const td = { padding: '1mm 1.5mm', borderBottom: '1px solid #eee' }
  const num = { ...td, textAlign: 'right', whiteSpace: 'nowrap' }

  return (
    <div id={elementId} className="printable-document" style={{ fontFamily: 'Sarabun,sans-serif', background: '#fff', color: '#17181f', width: '190mm' }}>
      {pages.map((pg, idx) => (
        <div key={idx} style={{
          height: `${PAGE_HEIGHT_MM}mm`, boxSizing: 'border-box', padding: '6mm 8mm', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          pageBreakAfter: idx < pages.length - 1 ? 'always' : 'auto', breakAfter: idx < pages.length - 1 ? 'page' : 'auto',
        }}>
          {pg.kind === 'table' && compact && <>
            {withBanner('สรุปการส่งงาน (บาท ก่อน VAT)', idx + 1)}
            <div data-testid="dr-compact-sum" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '2mm', fontSize: 9, marginBottom: '2mm' }}>
              {[['มูลค่าสัญญา', fmt(contract)], ['งวดนี้', fmt(totals.this), MARK_THIS], ['สะสมรวมงวดนี้', fmt((Number(totals.prev) || 0) + (Number(totals.this) || 0))], ['ส่งแล้ว', `${totals.pctDone ?? 0}%`]].map(([l, v, c]) => (
                <div key={l} style={{ border: '1px solid #e4e6ef', borderRadius: 3, padding: '1mm 2mm' }}>{l}<div style={{ fontSize: 12, fontWeight: 800, color: c }}>{v}</div></div>
              ))}
            </div>
            <table data-testid="dr-compact" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 8.5, tableLayout: 'fixed' }}>
              <thead><tr style={{ background: '#3d3a34', color: '#fff', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
                <th style={{ ...td, textAlign: 'left', width: '30%' }}>รายการ</th>
                {compact.columns.map(c => <th key={c.id} style={{ ...td, textAlign: 'center', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.2 }}>{c.name}</th>)}
                <th style={{ ...td, textAlign: 'right', width: '13%' }}>มูลค่างวดนี้</th>
                <th style={{ ...td, textAlign: 'right', width: '15%' }}>สะสม</th>
              </tr></thead>
              <tbody>
                {pg.rows.map(r => (
                  <tr key={r.key} style={{ pageBreakInside: 'avoid', breakInside: 'avoid' }}>
                    <td style={td} title={r.description}>
                      <b>{r.boqCode ? `${r.boqCode}. ` : ''}{clip(r.description, 40)}</b>
                      <div style={{ fontSize: 7.5, color: '#6b7280' }}>
                        {r.qty} {r.unit || ''} × {fmt(r.unitPrice)}{r.weights.length > 0 && ` · ${r.weights.map(w => w.pct).join('/')}%`}
                      </div>
                    </td>
                    {compact.columns.map(c => {
                      const cell = r.cells[c.id]
                      if (!cell) return <td key={c.id} style={{ ...td, textAlign: 'center', color: '#b8bcc4' }}>—</td>
                      return (
                        <td key={c.id} style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>
                          {cell.this > 0 ? <b>{qtyTxt(cell.this)}</b> : <span style={{ color: '#b8bcc4' }}>0</span>}
                          <span style={{ fontSize: 7.5, color: '#6b7280' }}>/{qtyTxt(cell.cumulative)}/{qtyTxt(cell.total)}</span>
                        </td>
                      )
                    })}
                    <td style={num}>{fmt(r.this)}</td>
                    <td style={num}>{fmt(r.cumulative)}<div style={{ fontSize: 7.5, color: '#6b7280' }}>{r.cumulativePct}%</div></td>
                  </tr>
                ))}
              </tbody>
              {pg.last && <tfoot style={{ fontWeight: 700 }}>
                <tr><td style={td} colSpan={compact.columns.length + 1}>รวมงวดนี้</td><td style={num}>{fmt(totals.this)}</td><td style={num}>{fmt((Number(totals.prev) || 0) + (Number(totals.this) || 0))}</td></tr>
                <tr><td style={{ ...td, fontWeight: 400, fontSize: 7.5, color: '#6b7280' }} colSpan={compact.columns.length + 3}>
                  ช่องเฟส = งวดนี้/สะสม/ทั้งหมด · — = รายการนี้ไม่มีเฟสนั้น{!showAll && ' · แสดงเฉพาะรายการที่ส่งงวดนี้'}
                </td></tr>
              </tfoot>}
            </table>
          </>}
          {pg.kind === 'table' && !compact && <>
            {withBanner('สรุปการส่งงาน (บาท ก่อน VAT)', idx + 1)}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
              <thead><tr style={{ background: '#f4f3ff' }}>
                {['เฟส / รายการ', 'หน่วย', 'ปริมาณ', 'ราคา/หน่วย', 'weight', 'มูลค่า', 'ส่งก่อนหน้า', 'งวดนี้', 'คงเหลือ'].map(h => <th key={h} style={{ ...td, textAlign: 'left' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {pg.rows.map(r => r.group ? (
                  <tr key={r.key} style={{ background: '#f4f1ea', fontWeight: 800 }}>
                    <td style={td} colSpan={5}>{r.n}. {r.name}</td>
                    <td style={num}>{fmt(r.value)}</td>
                    <td style={num}>{fmt(r.prev)}</td>
                    <td style={num}>{fmt(r.this)}</td>
                    <td style={num}>{fmt(r.remaining)}</td>
                  </tr>
                ) : (
                  <tr key={r.key}>
                    <td style={{ ...td, paddingLeft: '4mm' }} title={r.description}>{clip(r.description, DESC_MAX)}</td>
                    <td style={td}>{r.unit || '–'}</td>
                    <td style={num}>{r.qty ?? '–'}</td>
                    <td style={num}>{fmt(r.unitPrice)}</td>
                    <td style={num}>{r.weightPct == null ? '–' : `${r.weightPct}%`}</td>
                    <td style={num}>{fmt(r.value)}</td>
                    <td style={num}>{fmt(r.prev)}</td>
                    <td style={num}>{fmt(r.this)}</td>
                    <td style={num}>{fmt(r.remaining)}</td>
                  </tr>
                ))}
              </tbody>
              {pg.last && <tfoot style={{ fontWeight: 700 }}>
                <tr><td style={td} colSpan={5}>รวม</td><td style={num}>{fmt(contract)}</td><td style={num}>{fmt(totals.prev)}</td><td style={num}>{fmt(totals.this)}</td><td style={num}>{fmt(totals.remaining)}</td></tr>
                <tr><td style={td} colSpan={5}>% ของสัญญา</td><td style={num}>100%</td><td style={num}>{prevPct}%</td><td style={num}>{thisPct}%</td><td style={num}>{remPct}%</td></tr>
              </tfoot>}
            </table>
            {pg.last && <>
              <div data-testid="dr-bar" style={{ display: 'flex', height: '5mm', marginTop: '4mm', borderRadius: 3, overflow: 'hidden', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
                <div style={{ width: `${prevPct}%`, background: MARK_PREV }} />
                <div style={{ width: `${thisPct}%`, background: MARK_THIS }} />
                <div style={{ width: `${remPct}%`, background: MARK_REMAINING }} />
              </div>
              <div style={{ display: 'flex', gap: '5mm', fontSize: 9, marginTop: '1.5mm' }}>
                <span style={{ color: MARK_PREV }}>■ ส่งก่อนหน้า {fmt(totals.prev)} ({prevPct}%)</span>
                <span style={{ color: MARK_THIS }}>■ งวดนี้ {fmt(totals.this)} ({thisPct}%)</span>
                <span style={{ color: MARK_REMAINING }}>■ คงเหลือ {fmt(totals.remaining)} ({remPct}%)</span>
              </div>
            </>}
          </>}

          {pg.kind === 'plan' && <>
            {withBanner(`ตำแหน่งงานที่ส่ง · ${pg.plan.title || ''}`, idx + 1)}
            <div style={{ border: '1px solid #e4e6ef', borderRadius: 3 }}>
              <PlanMarkup plan={pg.plan} src={urls[pg.plan.file_path]} marks={marksByPlan[pg.plan.id] || []} colourFor={colourFor} cardOrder={cardOrder} />
            </div>
            <div style={{ display: 'flex', gap: '5mm', fontSize: 9, marginTop: '2mm' }}>
              <span style={{ color: MARK_PREV }}>■ ส่งแล้ว</span><span style={{ color: MARK_THIS }}>■ งวดนี้</span>
              <span style={{ color: MARK_REMAINING }}>■ คงเหลือ</span><span>ตัวเลขบนหมุด = เลขการ์ด</span>
            </div>
          </>}

          {pg.kind === 'cards' && <>
            {withBanner(pg.items.length ? 'รูปงานที่ส่ง' : 'การรับมอบงาน', idx + 1)}
            {pg.items.map(({ c, n }) => {
              const task = c.task_id ? taskById.get(c.task_id) : null
              const shown = shownPhotos(c)
              return (
                <div key={c.id || n} style={{ marginBottom: '4mm' }}>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>
                    {n}. {c.card_title}{!task && ' (การ์ดถูกลบ)'}
                  </div>
                  {task && <div style={{ fontSize: 9, color: '#6a6f85' }}>เฟส {phaseName.get(task.phase_id) || '–'}</div>}
                  {shown.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2mm', marginTop: '1.5mm' }}>
                      {shown.map(p => (
                        <div key={p.id} style={{ height: '45mm', background: '#f4f3ff' }}>
                          <img src={urls[p.photo_path]} alt="" crossOrigin="anonymous" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        </div>
                      ))}
                    </div>
                  )}
                  {c.caption && <div style={{ fontSize: 9.5, marginTop: '1mm' }}>คำอธิบาย: {clip(c.caption, 400)}</div>}
                </div>
              )
            })}
            <div style={{ flex: 1 }} />
            {pg.sig && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 800 }}>การรับมอบงาน</div>
                <div style={{ fontSize: 10, marginBottom: '4mm' }}>ผู้ว่าจ้างได้ตรวจรับงานตามรายการข้างต้นแล้ว</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8mm', textAlign: 'center', fontSize: 10 }}>
                  <div>
                    <div style={{ height: '14mm' }} />
                    <div style={{ borderTop: '1px solid #999', paddingTop: '1.5mm' }}>ลงชื่อ ผู้ส่งงาน<br />{tenant?.company_name}<br />วันที่ ________</div>
                  </div>
                  <div>
                    <div style={{ height: '14mm', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                      {signatureUrl && <img src={signatureUrl} alt="ลายเซ็น" crossOrigin="anonymous" style={{ maxHeight: '13mm' }} />}
                    </div>
                    <div style={{ borderTop: '1px solid #999', paddingTop: '1.5mm' }}>
                      ลงชื่อ ผู้รับงาน (ลูกค้า)<br />
                      {receipt ? `(${receipt.signer_name})` : '(______________________)'}<br />
                      วันที่ {receipt ? thDate(receipt.signed_at) : '________'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>}
        </div>
      ))}
    </div>
  )
}

// Props: invoiceId (the hook is keyed by invoice) + reportId (defaults to the current report).
// The hook loads the requested report's cards (defaults to the current report).
// Print: root has className="printable-document" so index.css @media print shows only it (as Invoices.jsx).
export default function DeliveryReportDocumentModal({ invoiceId, reportId, onClose, onRequestSign, onEdit }) {
  const { tenant } = useTenant()
  const { data, loading, error } = useDeliveryReport(invoiceId, reportId)
  const report = data?.report ?? null
  const [loadErr, setLoadErr] = useState(false)
  const [urls, setUrls] = useState({})
  const [receipt, setReceipt] = useState(null)
  const [signatureUrl, setSignatureUrl] = useState(null)
  const elementId = `dr-doc-${report?.id || 'x'}`
  const [modeChoice, setModeChoice] = useState(null) // null = default by item count
  const [showAll, setShowAll] = useState(false)
  const mode = modeChoice ?? defaultReportMode(data?.rows)

  const photoPaths = useMemo(() => {
    if (!data) return []
    const out = []
    for (const c of data.cards || []) {
      const list = c.task_id ? data.photosByTask?.[c.task_id] || [] : []
      for (const id of c.photo_ids || []) { const p = list.find(x => x.id === id); if (p?.photo_path) out.push(p.photo_path) }
    }
    return out
  }, [data])
  const planPaths = useMemo(() => (data?.plans || []).map(p => p.file_path).filter(Boolean), [data])

  useEffect(() => {
    let alive = true
    Promise.all([signUrls('line-site-photos', photoPaths), signUrls('site-drawings', planPaths)])
      .then(([a, b]) => { if (alive) setUrls({ ...a, ...b }) })
      .catch(() => { if (alive) setLoadErr(true) })
    return () => { alive = false }
  }, [photoPaths, planPaths])

  const receiptId = report?.signed_receipt_id
  useEffect(() => {
    let alive = true
    if (!receiptId) { setReceipt(null); setSignatureUrl(null); return }
    ;(async () => {
      const { data: r } = await supabase.from('document_receipts').select('*').eq('id', receiptId).maybeSingle()
      if (!alive || !r) return
      setReceipt(r)
      if (r.signature_path) {
        const { data: s, error: e } = await supabase.storage.from('document-receipts').createSignedUrl(r.signature_path, 3600)
        if (e) throw e
        if (alive) setSignatureUrl(s?.signedUrl || null)
      }
    })().catch(() => { if (alive) setLoadErr(true) })
    return () => { alive = false }
  }, [receiptId])

  const handlePrint = () => window.print()
  const items = [
    { label: '📄 บันทึกเป็น PDF', onClick: () => downloadPDF(elementId, `รายงานส่งงาน-${report?.report_number || ''}`) },
    { label: '🖨 พิมพ์', onClick: handlePrint },
    ...(onRequestSign && report && !receiptId ? [{ label: '✍️ ให้ลูกค้าเซ็น', onClick: () => onRequestSign(report) }] : []),
  ]

  return (
    <Modal title={`รายงานส่งงาน ${report?.report_number || ''}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ maxHeight: '70vh', overflow: 'auto' }}>
        {loading && !data && <div>กำลังโหลด…</div>}
        {error && <div style={{ color: '#dc2626' }}>{String(error.message || error)}</div>}
        {loadErr && <div style={{ color: '#b45309', fontSize: 12, marginBottom: 8 }}>โหลดรูป/ลายเซ็นไม่สำเร็จ</div>}
        {data && !report && <div>ยังไม่มีรายงานส่งงาน</div>}
        {data && report && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 13 }}>
            <span>รูปแบบตาราง:</span>
            {[['compact', 'แบบย่อ'], ['detailed', 'แบบละเอียด']].map(([m, label]) => (
              <button key={m} type="button" className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={mode === m} onClick={() => setModeChoice(m)}>{label}</button>
            ))}
            {mode === 'compact' && (
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> แสดงทุกรายการ
              </label>
            )}
          </div>
        )}
        {data && report && (
          <DeliveryReportDocument data={data} report={report} tenant={tenant} urls={urls}
            receipt={receipt} signatureUrl={signatureUrl} elementId={elementId} mode={mode} showAll={showAll} />
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        {onEdit && <button type="button" className="btn btn-ghost" onClick={onEdit}>✏️ แก้ไขรายงาน</button>}
        <RowActionsMenu trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary" items={items} />
      </div>
    </Modal>
  )
}
