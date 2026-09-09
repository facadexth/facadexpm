// ============================================================
// PublicSignPage — the page a link like /sign/<linkId> opens to.
// Deliberately outside the normal authenticated app shell (see main.jsx)
// -- no login, no session, nothing here ever touches the DB directly
// with the anon key. Every read/write goes through the sign-link Edge
// Function, which validates the link server-side with the service role.
//
// ✅ 2026-09-09: the client can now see the actual document (line items,
//    letterhead, totals) both before signing (collapsible preview) and
//    after (same view + their signature + a PDF download) -- previously
//    this page only ever showed a one-line summary and a bare "signed!"
//    message. Optional email field on submit gets a Resend confirmation
//    with a link back here (see sign-link Edge Function).
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { supabase } from './lib/supabase.js'
import SignaturePad from './components/SignaturePad.jsx'
import { downloadPDF } from './lib/pdf.js'

const REASON_MESSAGES = {
  not_found: 'ไม่พบลิงก์นี้ — อาจพิมพ์ผิดหรือลิงก์ถูกลบไปแล้ว',
  expired: 'ลิงก์นี้หมดอายุแล้ว — กรุณาติดต่อขอลิงก์ใหม่',
  unsupported_document_type: 'ไม่รองรับเอกสารประเภทนี้',
  document_not_found: 'ไม่พบเอกสารที่ลิงก์นี้อ้างอิงถึง',
}

const fmt = (n) => Number(n ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'

function Shell({ children, wide }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ maxWidth: wide ? 720 : 480, width: '100%', padding: '28px 24px', marginTop: 20 }}>
        {children}
      </div>
    </div>
  )
}

// รูปเอกสารแบบย่อ (ไม่ใช่ layout พิมพ์แบบเป๊ะๆ หน้ากระดาษ A4 เหมือนในระบบหลัก
// -- หน้านี้เป็นเว็บเพจธรรมดา เลื่อนดูยาวๆ ได้ ไม่ต้องมีการแบ่งหน้า) พอให้
// ลูกค้าเห็นรายการ/ราคา/เงื่อนไขจริงก่อนกดเซ็น ใช้ elementId เดียวกันสำหรับ
// ทั้งพรีวิวก่อนเซ็นและมุมมองหลังเซ็น (มี signatureUrl เพิ่มมาก็พอ)
function DocumentPaper({ elementId, document: doc, tenant, tenantName, signature }) {
  const isCheque = doc.type === 'cheque'
  return (
    <div id={elementId} style={{ background: '#fff', color: '#17181f', padding: '28px 24px', borderRadius: 8, fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {tenant?.logo_url && <img src={tenant.logo_url} alt="" crossOrigin="anonymous" style={{ width: 36, height: 36, objectFit: 'contain' }} />}
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{tenantName || tenant?.company_name}</div>
            <div style={{ fontSize: 10.5, color: '#6a6f85', lineHeight: 1.5 }}>
              {tenant?.address}
              {tenant?.tax_id && <> · เลขผู้เสียภาษี {tenant.tax_id}</>}
              {tenant?.phone && <> · โทร {tenant.phone}</>}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 17, fontWeight: 800, textAlign: 'right' }}>{doc.label}</div>
      </div>

      {!isCheque && (
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14, fontSize: 12 }}>
          <div>
            {doc.clientName && <div><strong>ลูกค้า:</strong> {doc.clientName}</div>}
            {doc.clientAddress && <div style={{ color: '#6a6f85' }}>{doc.clientAddress}</div>}
            {doc.siteName && <div><strong>โครงการ:</strong> {doc.siteName}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div><strong>วันที่:</strong> {fmtDate(doc.date)}</div>
            {doc.validUntil && <div><strong>ใช้ได้ถึง:</strong> {fmtDate(doc.validUntil)}</div>}
            {doc.quotationNumber && <div><strong>อ้างอิง:</strong> {doc.quotationNumber}</div>}
          </div>
        </div>
      )}

      {isCheque ? (
        <div style={{ fontSize: 13, display: 'grid', gap: 6, background: '#f7f7fb', borderRadius: 8, padding: 14 }}>
          <div><strong>ธนาคาร:</strong> {doc.bank}</div>
          <div><strong>วันที่เช็ค:</strong> {fmtDate(doc.check_date)}</div>
        </div>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f2f1ff' }}>
                <th style={{ textAlign: 'left', padding: '7px 8px' }}>รายการ</th>
                <th style={{ textAlign: 'right', padding: '7px 8px' }}>จำนวน</th>
                <th style={{ textAlign: 'right', padding: '7px 8px' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right', padding: '7px 8px' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {(doc.items || []).map((it, i) => (
                <tr key={i}>
                  <td style={{ padding: '7px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
                  <td style={{ padding: '7px 8px', borderBottom: '1px solid #eee', textAlign: 'right' }}>{it.quantity} {it.unit || ''}</td>
                  <td style={{ padding: '7px 8px', borderBottom: '1px solid #eee', textAlign: 'right' }}>{fmt(it.unitPrice)}</td>
                  <td style={{ padding: '7px 8px', borderBottom: '1px solid #eee', textAlign: 'right' }}>{fmt(it.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
            <table style={{ width: 220, fontSize: 12.5 }}>
              <tbody>
                <tr><td style={{ padding: '3px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '3px 4px' }}>{fmt(doc.subtotal)}</td></tr>
                {doc.hasVat && <tr><td style={{ padding: '3px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '3px 4px' }}>{fmt(doc.vat)}</td></tr>}
                <tr><td style={{ padding: '4px', fontWeight: 700, borderTop: '1px solid #ddd' }}>รวมทั้งสิ้น</td><td style={{ textAlign: 'right', padding: '4px', fontWeight: 700, borderTop: '1px solid #ddd' }}>{fmt(doc.total)} บาท</td></tr>
              </tbody>
            </table>
          </div>
          {(doc.notes || doc.paymentTerms) && (
            <div style={{ marginTop: 14, fontSize: 11.5, color: '#444', background: '#f7f7fb', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
              {doc.notes && <div><strong>หมายเหตุ</strong><div style={{ whiteSpace: 'pre-line' }}>{doc.notes}</div></div>}
              {doc.paymentTerms && <div><strong>เงื่อนไขการชำระเงิน</strong><div style={{ whiteSpace: 'pre-line' }}>{doc.paymentTerms}</div></div>}
            </div>
          )}
          {doc.bankAccount && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: '#444' }}>
              <strong>ชำระเงินไปที่:</strong> {doc.bankAccount.bank_name} ชื่อบัญชี {doc.bankAccount.account_name} เลขที่ {doc.bankAccount.account_no}
            </div>
          )}
        </>
      )}

      {signature?.url && (
        <div style={{ marginTop: 22, borderTop: '1px solid #eee', paddingTop: 14 }}>
          <div style={{ fontSize: 11, color: '#6a6f85', marginBottom: 4 }}>ลายเซ็นผู้รับ/ผู้ยอมรับ</div>
          <img src={signature.url} alt="ลายเซ็น" crossOrigin="anonymous" style={{ height: 60 }} />
          <div style={{ fontSize: 11.5, marginTop: 4 }}>{signature.signerName}</div>
          <div style={{ fontSize: 10.5, color: '#6a6f85' }}>เซ็นเมื่อ {new Date(signature.signedAt).toLocaleString('th-TH')}</div>
        </div>
      )}
    </div>
  )
}

export default function PublicSignPage({ linkId }) {
  const [state, setState] = useState({ loading: true })
  const [signerName, setSignerName] = useState('')
  const [signerNote, setSignerNote] = useState('')
  const [signerEmail, setSignerEmail] = useState('')
  const [signatureDataUrl, setSignatureDataUrl] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const paperRef = useRef(null)

  const load = () => {
    supabase.functions.invoke('sign-link', { body: { action: 'info', linkId } })
      .then(({ data, error }) => {
        if (error) { setState({ loading: false, error: error.message }); return }
        setState({ loading: false, ...data })
      })
      .catch(err => setState({ loading: false, error: err.message }))
  }
  useEffect(load, [linkId])

  const handleSubmit = async () => {
    if (!signerName.trim() || !signatureDataUrl) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { data, error } = await supabase.functions.invoke('sign-link', {
        body: { action: 'submit', linkId, signerName: signerName.trim(), signerNote: signerNote.trim(), signerEmail: signerEmail.trim(), signatureDataUrl },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setSubmitted(true)
      load() // refetch -- picks up alreadySigned + the signature signed-URL for the after-sign view
    } catch (err) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      await downloadPDF('sign-doc-paper', `${state.document?.label || 'เอกสาร'}.pdf`)
    } finally {
      setDownloading(false)
    }
  }

  if (state.loading) {
    return <Shell><p style={{ textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</p></Shell>
  }

  if (state.error || state.valid === false) {
    return (
      <Shell>
        <h2 style={{ marginBottom: 8 }}>⚠️ ไม่สามารถเปิดลิงก์นี้ได้</h2>
        <p style={{ color: 'var(--text2)' }}>{REASON_MESSAGES[state.reason] || state.error || 'เกิดข้อผิดพลาด'}</p>
      </Shell>
    )
  }

  if (submitted || state.alreadySigned) {
    return (
      <Shell wide>
        <h2 style={{ marginBottom: 4 }}>✅ เซ็นรับเรียบร้อยแล้ว</h2>
        <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 16 }}>
          {state.tenantName && <>ขอบคุณที่เซ็นรับเอกสารกับ {state.tenantName}<br /></>}
          นี่คือเอกสารที่คุณเซ็นรับไปแล้ว — ดาวน์โหลดเก็บไว้ได้เลย
        </p>
        <div ref={paperRef}>
          <DocumentPaper elementId="sign-doc-paper" document={state.document} tenant={state.tenant} tenantName={state.tenantName} signature={state.signature} />
        </div>
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button type="button" className="btn btn-primary" disabled={downloading} onClick={handleDownload}>
            {downloading ? '⏳...' : '📄 ดาวน์โหลด PDF'}
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell wide>
      <h2 style={{ marginBottom: 4 }}>เซ็นรับเอกสาร</h2>
      {state.tenantName && <p style={{ color: 'var(--text3)', fontSize: 13, marginBottom: 12 }}>{state.tenantName}</p>}

      <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={() => setPreviewOpen(v => !v)}>
        {previewOpen ? '▲ ซ่อนเอกสาร' : '👁️ ดูเอกสารที่กำลังจะเซ็น'}
      </button>
      {previewOpen && (
        <div style={{ marginBottom: 16, overflowX: 'auto' }}>
          <DocumentPaper elementId="sign-doc-paper" document={state.document} tenant={state.tenant} tenantName={state.tenantName} signature={null} />
        </div>
      )}

      <div className="card card-body" style={{ marginBottom: 16, fontSize: 13, display: 'grid', gap: 4 }}>
        <div><strong>{state.document?.label}</strong></div>
        {state.document?.bank && <div style={{ color: 'var(--text2)' }}>ธนาคาร: {state.document.bank}</div>}
        {state.document?.check_date && <div style={{ color: 'var(--text2)' }}>วันที่เช็ค: {fmtDate(state.document.check_date)}</div>}
        {state.document?.clientName && <div style={{ color: 'var(--text2)' }}>ลูกค้า: {state.document.clientName}</div>}
        {state.document?.total != null && <div style={{ color: 'var(--text2)' }}>ยอดรวม: {fmt(state.document.total)} บาท</div>}
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">ชื่อผู้เซ็นรับ ★</label>
          <input className="input" required autoFocus value={signerName} onChange={e => setSignerName(e.target.value)} placeholder="ชื่อ-นามสกุล" />
        </div>
        <div>
          <label className="label">อีเมล (ถ้าต้องการสำเนาส่งเข้าอีเมล)</label>
          <input className="input" type="email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={signerNote} onChange={e => setSignerNote(e.target.value)} placeholder="เช่น ตำแหน่ง (ถ้ามี)" />
        </div>
        <div>
          <label className="label">ลายเซ็น ★</label>
          <SignaturePad onChange={setSignatureDataUrl} />
        </div>
        {submitError && <div style={{ color: 'var(--red)', fontSize: 13 }}>{submitError}</div>}
        <button
          type="button" className="btn btn-primary" disabled={submitting || !signerName.trim() || !signatureDataUrl}
          onClick={handleSubmit}
        >
          {submitting ? '⏳...' : '✅ ยืนยันเซ็นรับ'}
        </button>
      </div>
    </Shell>
  )
}
