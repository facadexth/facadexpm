// A4 document for a delivery report (รายงานส่งงาน, DR). Plan B task 6.
// Page 1 summary table + 3-colour bar, then one page per site plan, then card blocks
// (2 per page, up to 4 photos each), signature block at the end.
// Pages use fixed mm heights like WorkPhotosDocumentModal (Invoices.jsx): 270mm, not 277mm,
// so html2pdf.js page-break padding never adds an empty page.
import { useEffect, useMemo, useState } from 'react'
import { supabase, fmt } from '../../../lib/supabase.js'
import { useTenant } from '../../../hooks/useTenant.js'
import { useDeliveryReport } from '../../../hooks/useDeliveryReport.js'
import { markColour, MARK_PREV, MARK_THIS, MARK_REMAINING } from '../../../lib/deliveryReport.js'
import { downloadPDF } from '../../../lib/pdf.js'
import { Modal } from '../../../components/Modal.jsx'
import RowActionsMenu from '../../../components/RowActionsMenu.jsx'
import PlanMarkup from './PlanMarkup.jsx'

const PAGE_HEIGHT_MM = 270
const ROWS_PER_PAGE = 22
const CARDS_PER_PAGE = 2
const thDate = d => (d ? new Date(d).toLocaleDateString('th-TH') : '')
const pct = (n, total) => (total ? Math.round(n / total * 1000) / 10 : 0)
const DONE = new Set(['done', 'completed'])

async function signUrls(bucket, paths) {
  if (!paths.length) return {}
  const { data } = await supabase.storage.from(bucket).createSignedUrls(paths, 3600)
  const out = {}
  ;(data || []).forEach((d, i) => { if (d?.signedUrl) out[paths[i]] = d.signedUrl })
  return out
}

export function DeliveryReportDocument({ data, report, tenant, urls = {}, receipt = null, signatureUrl = null, elementId = 'dr-doc' }) {
  const { invoice, rows = [], totals = {}, cards = [], tasks = [], phases = [], photosByTask = {}, plans = [], marksByPlan = {}, reports = [] } = data
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const phaseName = new Map(phases.map(p => [p.id, p.name]))
  const replaced = report?.replaces_id ? reports.find(r => r.id === report.replaces_id) : null

  // Plan colours: cards of this report = orange; other cards already done = green; rest grey.
  const thisTaskIds = new Set(cards.map(c => c.task_id).filter(Boolean))
  const prevTaskIds = new Set(tasks.filter(t => DONE.has(t.status) && !thisTaskIds.has(t.id)).map(t => t.id))
  const colourFor = id => markColour(id, { prevTaskIds, thisTaskIds })
  const cardOrder = cards.map(c => c.task_id)

  const contract = Number(totals.contract) || 0
  const prevPct = pct(totals.prev || 0, contract)
  const thisPct = pct(totals.this || 0, contract)
  const remPct = pct(totals.remaining || 0, contract)

  const rowPages = []
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) rowPages.push(rows.slice(i, i + ROWS_PER_PAGE))
  if (!rowPages.length) rowPages.push([])
  const cardPages = []
  for (let i = 0; i < cards.length; i += CARDS_PER_PAGE) cardPages.push(cards.slice(i, i + CARDS_PER_PAGE))
  if (!cardPages.length) cardPages.push([])

  const pages = [
    ...rowPages.map((r, i) => ({ kind: 'table', rows: r, last: i === rowPages.length - 1 })),
    ...plans.map(p => ({ kind: 'plan', plan: p })),
    ...cardPages.map((c, i) => ({ kind: 'cards', cards: c, offset: i * CARDS_PER_PAGE, last: i === cardPages.length - 1 })),
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
        {data.siteName && <div>{data.siteName}</div>}
        <div>{thDate(report?.date)}</div>
        <div style={{ color: '#9296a8' }}>หน้า {n} / {pages.length}</div>
      </div>
    </div>
  )

  const td = { padding: '1mm 1.5mm', borderBottom: '1px solid #eee' }
  const num = { ...td, textAlign: 'right', whiteSpace: 'nowrap' }

  return (
    <div id={elementId} style={{ fontFamily: 'Sarabun,sans-serif', background: '#fff', color: '#17181f', width: '190mm' }}>
      {pages.map((pg, idx) => (
        <div key={idx} style={{
          height: `${PAGE_HEIGHT_MM}mm`, boxSizing: 'border-box', padding: '6mm 8mm', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          pageBreakAfter: idx < pages.length - 1 ? 'always' : 'auto', breakAfter: idx < pages.length - 1 ? 'page' : 'auto',
        }}>
          {pg.kind === 'table' && <>
            {header('สรุปการส่งงาน (บาท ก่อน VAT)', idx + 1)}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
              <thead><tr style={{ background: '#f4f3ff' }}>
                {['รายการ', 'เฟส', 'หน่วย', 'ปริมาณ', 'ราคา/หน่วย', 'weight', 'มูลค่า', 'ส่งก่อนหน้า', 'งวดนี้', 'คงเหลือ'].map(h => <th key={h} style={{ ...td, textAlign: 'left' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {pg.rows.map(r => (
                  <tr key={r.key}>
                    <td style={td}>{r.description}</td>
                    <td style={td}>{r.phaseName || '–'}</td>
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
                <tr><td style={td} colSpan={6}>รวม</td><td style={num}>{fmt(contract)}</td><td style={num}>{fmt(totals.prev)}</td><td style={num}>{fmt(totals.this)}</td><td style={num}>{fmt(totals.remaining)}</td></tr>
                <tr><td style={td} colSpan={6}>% ของสัญญา</td><td style={num}>100%</td><td style={num}>{prevPct}%</td><td style={num}>{thisPct}%</td><td style={num}>{remPct}%</td></tr>
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
            {header(`ตำแหน่งงานที่ส่ง · ${pg.plan.title || ''}`, idx + 1)}
            <div style={{ border: '1px solid #e4e6ef', borderRadius: 3 }}>
              <PlanMarkup plan={pg.plan} src={urls[pg.plan.file_path]} marks={marksByPlan[pg.plan.id] || []} colourFor={colourFor} cardOrder={cardOrder} />
            </div>
            <div style={{ display: 'flex', gap: '5mm', fontSize: 9, marginTop: '2mm' }}>
              <span style={{ color: MARK_PREV }}>■ ส่งแล้ว</span><span style={{ color: MARK_THIS }}>■ งวดนี้</span>
              <span style={{ color: MARK_REMAINING }}>■ คงเหลือ</span><span>ตัวเลขบนหมุด = เลขการ์ด</span>
            </div>
          </>}

          {pg.kind === 'cards' && <>
            {header('รูปงานที่ส่ง', idx + 1)}
            {pg.cards.map((c, i) => {
              const task = c.task_id ? taskById.get(c.task_id) : null
              const photoById = new Map((task ? photosByTask[task.id] || [] : []).map(p => [p.id, p]))
              const shown = task ? (c.photo_ids || []).map(id => photoById.get(id)).filter(p => p && urls[p.photo_path]).slice(0, 4) : []
              return (
                <div key={c.id || i} style={{ marginBottom: '4mm' }}>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>
                    {pg.offset + i + 1}. {c.card_title}{!task && ' (การ์ดถูกลบ)'}
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
                  {c.caption && <div style={{ fontSize: 9.5, marginTop: '1mm' }}>คำอธิบาย: {c.caption}</div>}
                </div>
              )
            })}
            <div style={{ flex: 1 }} />
            {pg.last && (
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
// Cards come from the hook, which loads them for the current report only.
export default function DeliveryReportDocumentModal({ invoiceId, reportId, onClose, onRequestSign, siteName }) {
  const { tenant } = useTenant()
  const { data, loading, error } = useDeliveryReport(invoiceId)
  const report = data ? (data.reports || []).find(r => r.id === reportId) || data.current : null
  const [urls, setUrls] = useState({})
  const [receipt, setReceipt] = useState(null)
  const [signatureUrl, setSignatureUrl] = useState(null)
  const elementId = `dr-doc-${report?.id || 'x'}`

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
      .catch(() => {})
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
        const { data: s } = await supabase.storage.from('document-receipts').createSignedUrl(r.signature_path, 3600)
        if (alive) setSignatureUrl(s?.signedUrl || null)
      }
    })().catch(() => {})
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
        {data && !report && <div>ยังไม่มีรายงานส่งงาน</div>}
        {data && report && (
          <DeliveryReportDocument data={{ ...data, siteName }} report={report} tenant={tenant} urls={urls}
            receipt={receipt} signatureUrl={signatureUrl} elementId={elementId} />
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <RowActionsMenu trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary" items={items} />
      </div>
    </Modal>
  )
}
