// ============================================================
// PublicSignPage — the page a link like /sign/<linkId> opens to.
// Deliberately outside the normal authenticated app shell (see main.jsx)
// -- no login, no session, nothing here ever touches the DB directly
// with the anon key. Every read/write goes through the sign-link Edge
// Function, which validates the link server-side with the service role.
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase.js'
import SignaturePad from './components/SignaturePad.jsx'

const REASON_MESSAGES = {
  not_found: 'ไม่พบลิงก์นี้ — อาจพิมพ์ผิดหรือลิงก์ถูกลบไปแล้ว',
  expired: 'ลิงก์นี้หมดอายุแล้ว — กรุณาติดต่อขอลิงก์ใหม่',
  unsupported_document_type: 'ไม่รองรับเอกสารประเภทนี้',
  document_not_found: 'ไม่พบเอกสารที่ลิงก์นี้อ้างอิงถึง',
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ maxWidth: 480, width: '100%', padding: '28px 24px' }}>
        {children}
      </div>
    </div>
  )
}

export default function PublicSignPage({ linkId }) {
  const [state, setState] = useState({ loading: true })
  const [signerName, setSignerName] = useState('')
  const [signerNote, setSignerNote] = useState('')
  const [signatureDataUrl, setSignatureDataUrl] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    supabase.functions.invoke('sign-link', { body: { action: 'info', linkId } })
      .then(({ data, error }) => {
        if (error) { setState({ loading: false, error: error.message }); return }
        setState({ loading: false, ...data })
      })
      .catch(err => setState({ loading: false, error: err.message }))
  }, [linkId])

  const handleSubmit = async () => {
    if (!signerName.trim() || !signatureDataUrl) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { data, error } = await supabase.functions.invoke('sign-link', {
        body: { action: 'submit', linkId, signerName: signerName.trim(), signerNote: signerNote.trim(), signatureDataUrl },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setSubmitted(true)
    } catch (err) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
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
      <Shell>
        <h2 style={{ marginBottom: 8 }}>✅ เซ็นรับเรียบร้อยแล้ว</h2>
        <p style={{ color: 'var(--text2)' }}>
          {state.tenantName && <>ขอบคุณที่เซ็นรับเอกสารกับ {state.tenantName}<br /></>}
          {state.document?.label} ได้รับการบันทึกแล้ว ปิดหน้านี้ได้เลย
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <h2 style={{ marginBottom: 4 }}>เซ็นรับเอกสาร</h2>
      {state.tenantName && <p style={{ color: 'var(--text3)', fontSize: 13, marginBottom: 16 }}>{state.tenantName}</p>}
      <div className="card card-body" style={{ marginBottom: 16, fontSize: 13, display: 'grid', gap: 4 }}>
        <div><strong>{state.document?.label}</strong></div>
        {state.document?.bank && <div style={{ color: 'var(--text2)' }}>ธนาคาร: {state.document.bank}</div>}
        {state.document?.check_date && <div style={{ color: 'var(--text2)' }}>วันที่เช็ค: {new Date(state.document.check_date).toLocaleDateString('th-TH')}</div>}
        {state.document?.clientName && <div style={{ color: 'var(--text2)' }}>ลูกค้า: {state.document.clientName}</div>}
        {state.document?.total != null && <div style={{ color: 'var(--text2)' }}>ยอดรวม: {Number(state.document.total).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท</div>}
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">ชื่อผู้เซ็นรับ ★</label>
          <input className="input" required autoFocus value={signerName} onChange={e => setSignerName(e.target.value)} placeholder="ชื่อ-นามสกุล" />
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
