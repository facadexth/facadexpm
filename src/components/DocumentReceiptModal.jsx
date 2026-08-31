// ============================================================
// DocumentReceiptModal — generic "capture a signature as proof this
// document was received" flow. Hand the device to whoever's receiving the
// document (supplier, driver, etc.), they sign, done. Deliberately generic
// over document_type/document_id (no cheque-specific logic in here) so it
// can be reused for other document types later without changes -- the
// caller decides what, if anything, should happen to the underlying
// document's own status after a successful signature (see Cheques.jsx).
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'
import SignaturePad from './SignaturePad.jsx'

export default function DocumentReceiptModal({ documentType, documentId, tenantId, title, onClose, onSaved }) {
  const [signerName, setSignerName] = useState('')
  const [signerNote, setSignerNote] = useState('')
  const [signatureDataUrl, setSignatureDataUrl] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!signerName.trim() || !signatureDataUrl) return
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const blob = await (await fetch(signatureDataUrl)).blob()
      const filePath = `${tenantId}/${documentType}/${documentId}/${Date.now()}.png`
      const { error: upErr } = await supabase.storage.from('document-receipts').upload(filePath, blob, { contentType: 'image/png' })
      if (upErr) throw upErr

      const { error: dbErr } = await supabase.from('document_receipts').insert({
        document_type: documentType,
        document_id: documentId,
        signer_name: signerName.trim(),
        signer_note: signerNote.trim() || null,
        signature_path: filePath,
        signed_by: session?.user?.email || 'system',
      })
      if (dbErr) {
        await supabase.storage.from('document-receipts').remove([filePath])
        throw dbErr
      }
      await onSaved()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">ชื่อผู้เซ็นรับ ★</label>
          <input className="input" required autoFocus value={signerName} onChange={e => setSignerName(e.target.value)} placeholder="ชื่อ-นามสกุลผู้รับ" />
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={signerNote} onChange={e => setSignerNote(e.target.value)} placeholder="เช่น ตำแหน่ง หรือเลขบัตรประชาชน (ถ้ามี)" />
        </div>
        <div>
          <label className="label">ลายเซ็น ★</label>
          <SignaturePad onChange={setSignatureDataUrl} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button
          type="button" className="btn btn-primary" disabled={saving || !signerName.trim() || !signatureDataUrl}
          onClick={handleSave}
        >
          {saving ? '⏳...' : '✅ บันทึกลายเซ็น'}
        </button>
      </div>
    </Modal>
  )
}
