// How the customer signs a delivery report (Plan B task 7): paper, this device, or a remote link.
// Starting any path turns a draft report into 'issued'. Local paths (device / paper photo) set the
// report to 'signed' here after the receipt is saved; the remote path is signed by sign-link.
// Customer LINE push: there is no client-callable endpoint that pushes an arbitrary link to a
// customer's LINE (pushToCustomer is server-only, used by repair-push), so remote = copy link only.
import { newId } from '../../../lib/uuid.js'
import { useState } from 'react'
import { supabase } from '../../../lib/supabase.js'
import { Modal } from '../../../components/Modal.jsx'
import DocumentReceiptModal from '../../../components/DocumentReceiptModal.jsx'
import SignLinkModal from '../../../components/SignLinkModal.jsx'
import { markDeliveryReportIssued, markDeliveryReportSigned } from '../../../hooks/useDeliveryReport.js'
import DeliveryReportDocumentModal from './DeliveryReportDocument.jsx'

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export default function SignChooser({ report, tenantId, onClose, onSigned, onPrint = () => window.print() }) {
  const [mode, setMode] = useState(null) // null | 'paper' | 'device' | 'remote'
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [signerName, setSignerName] = useState('')
  const [file, setFile] = useState(null)
  // Receipt already saved but the report status update failed: retry only the status update.
  const [savedReceiptId, setSavedReceiptId] = useState(null)
  const title = `รายงานส่งงาน ${report?.report_number || ''}`

  const start = async m => {
    setErr('')
    try {
      if (report.status === 'draft') await markDeliveryReportIssued(report.id)
      setMode(m)
    } catch (e) { setErr(e.message || String(e)) }
  }

  // Never throws: on failure keep the receipt id and show the retry view.
  const finishSigned = async receiptId => {
    setSavedReceiptId(receiptId)
    setErr('')
    try {
      await markDeliveryReportSigned(report.id, receiptId)
    } catch (e) {
      setErr(e.message || String(e))
      setMode('retry')
      return
    }
    onSigned?.()
    onClose()
  }

  const retryStatus = async () => {
    setBusy(true)
    try { await finishSigned(savedReceiptId) } finally { setBusy(false) }
  }

  const savePaper = async () => {
    if (!file || !signerName.trim()) return
    if (savedReceiptId) return retryStatus()
    setBusy(true); setErr('')
    let path = null
    try {
      const ext = IMAGE_EXT[file.type]
      if (!ext) throw new Error('รองรับเฉพาะรูป jpg / png / webp')
      const { data: { session } } = await supabase.auth.getSession()
      path = `${tenantId}/delivery_report/${report.id}/${Date.now()}-paper.${ext}`
      const { error: upErr } = await supabase.storage.from('document-receipts').upload(path, file, { contentType: file.type })
      if (upErr) throw upErr
      const id = newId()
      const { error: dbErr } = await supabase.from('document_receipts').insert({
        id, document_type: 'delivery_report', document_id: report.id,
        signer_name: signerName.trim(), signer_note: 'เซ็นบนกระดาษ (แนบรูป)',
        signature_path: path, signed_by: session?.user?.email || 'system',
      })
      if (dbErr) { await supabase.storage.from('document-receipts').remove([path]); throw dbErr }
      await finishSigned(id)
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  if (mode === 'device') {
    return <DocumentReceiptModal documentType="delivery_report" documentId={report.id} tenantId={tenantId} title={title}
      onClose={onClose} onSaved={async r => finishSigned(r.id)} />
  }
  if (mode === 'remote') {
    return <SignLinkModal documentType="delivery_report" documentId={report.id} onClose={onClose} />
  }

  return (
    <Modal title={`ให้ลูกค้าเซ็น — ${title}`} onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {mode === 'retry' && <>
          <div style={{ fontSize: 13 }}>บันทึกลายเซ็นแล้ว แต่เปลี่ยนสถานะรายงานเป็น "เซ็นแล้ว" ไม่สำเร็จ</div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={retryStatus}>
            {busy ? 'กำลังบันทึก…' : 'ลองบันทึกสถานะอีกครั้ง'}
          </button>
        </>}
        {mode !== 'paper' && mode !== 'retry' && <>
          <button type="button" className="btn btn-ghost" onClick={() => start('paper')}>🖨 พิมพ์แล้วเซ็นบนกระดาษ</button>
          <button type="button" className="btn btn-ghost" onClick={() => start('device')}>✍️ เซ็นบนเครื่องนี้</button>
          <button type="button" className="btn btn-ghost" onClick={() => start('remote')}>🔗 ส่งลิงก์ให้ลูกค้า</button>
        </>}
        {mode === 'paper' && <>
          <button type="button" className="btn btn-primary" onClick={onPrint}>🖨 พิมพ์</button>
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>แนบรูปใบที่เซ็นแล้ว (ไม่บังคับ — แนบทีหลังได้)</div>
          <input className="input" placeholder="ชื่อผู้เซ็นรับ" value={signerName} onChange={e => setSignerName(e.target.value)} />
          <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="แนบรูปใบที่เซ็นแล้ว"
            onChange={e => setFile(e.target.files?.[0] || null)} />
          <button type="button" className="btn btn-primary" disabled={busy || !file || !signerName.trim()} onClick={savePaper}>
            {busy ? 'กำลังบันทึก…' : 'บันทึกว่าเซ็นแล้ว'}
          </button>
        </>}
        {err && <div style={{ color: '#dc2626', fontSize: 13 }}>{err}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}

// The document with signing wired in (Task 8 opens this from the invoice).
export function DeliveryReportWithSigning({ invoiceId, reportId, tenantId, onClose, onEdit }) {
  const [signing, setSigning] = useState(null)
  const [version, setVersion] = useState(0)
  return (
    <>
      <DeliveryReportDocumentModal key={version} invoiceId={invoiceId} reportId={reportId} onClose={onClose} onEdit={onEdit}
        onRequestSign={r => setSigning(r)} />
      {signing && <SignChooser report={signing} tenantId={tenantId ?? signing.tenant_id} onClose={() => setSigning(null)}
        onSigned={() => setVersion(v => v + 1)} />}
    </>
  )
}
