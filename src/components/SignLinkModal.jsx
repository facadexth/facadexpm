// ============================================================
// SignLinkModal — generates a secure /sign/<linkId> remote-signing link for
// any document_type the sign-link Edge Function supports (cheque,
// quotation, invoice) and shows it ready to copy/send. Deliberately
// generic over documentType/documentId, same as DocumentReceiptModal --
// one modal shared by every page that offers remote signing, instead of
// each page reimplementing the same insert-then-copy-link flow.
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'

export default function SignLinkModal({ documentType, documentId, onClose }) {
  const [state, setState] = useState({ generating: true })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const { data, error } = await supabase.from('document_receipt_links').insert({
          document_type: documentType,
          document_id: documentId,
          created_by: session?.user?.email || 'system',
        }).select().single()
        if (error) throw error
        if (!cancelled) setState({ url: `${window.location.origin}/sign/${data.id}` })
      } catch (err) {
        if (!cancelled) { alert('Error: ' + err.message); onClose() }
      }
    })()
    return () => { cancelled = true }
  }, [documentType, documentId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title="ลิงก์เซ็นรับระยะไกล" onClose={onClose} maxWidth={480}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {state.generating ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>⏳ กำลังสร้างลิงก์...</div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
              ส่งลิงก์นี้ให้ผู้รับผ่าน LINE, SMS, หรืออีเมล — เปิดแล้วเซ็นได้เลยบนอุปกรณ์ของเขาเอง ไม่ต้องมีบัญชี
              ลิงก์นี้หมดอายุใน 7 วัน
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" readOnly value={state.url} onFocus={e => e.target.select()} style={{ fontSize: 12 }} />
              <button
                type="button" className="btn btn-primary"
                onClick={() => { navigator.clipboard.writeText(state.url); setState(s => ({ ...s, copied: true })) }}
              >
                {state.copied ? '✅ คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
