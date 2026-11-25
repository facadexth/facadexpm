// ใบงานซ่อม preview + PDF for staff, opened from RepairTicketModal (🖨 ใบงานซ่อม).
//   ticketId  -- repair_tickets.id
//   onClose() -- closed
// The sheet (RepairWorkOrderSheet, fixed 718px) scrolls sideways inside its own box on a phone.
// The PDF button stays disabled (กำลังเตรียม…) until every <img> in the sheet has finished and the
// map QR (drawn asynchronously) is in place, so the capture never misses a photo or the QR.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { downloadPDF } from '../lib/pdf.js'
import { loadWorkOrder, waitForSheetImages } from '../lib/repairWorkorderLoad.js'
import { Modal } from './Modal.jsx'
import RepairWorkOrderSheet from './RepairWorkOrderSheet.jsx'

export default function RepairWorkOrderModal({ ticketId, onClose }) {
  const { tenant, loading: tenantLoading } = useTenant()
  const [wo, setWo] = useState(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const sheetId = `repair-wo-${ticketId}`
  // useTenant hands out a new tenant object on every session revalidation (tab refocus); reload only
  // when the letterhead itself changes, not on every new object.
  const tenantRef = useRef(tenant)
  tenantRef.current = tenant
  const headerKey = JSON.stringify([tenant?.company_name, tenant?.address, tenant?.phone, tenant?.logo_url])

  useEffect(() => {
    if (tenantLoading) return undefined
    let alive = true
    setWo(null); setError(''); setReady(false)
    loadWorkOrder(supabase, ticketId, tenantRef.current)
      .then((w) => { if (alive) setWo(w) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [ticketId, headerKey, tenantLoading])

  useEffect(() => {
    if (!wo) return undefined
    let alive = true
    setReady(false)
    waitForSheetImages(document.getElementById(sheetId), { needQr: !!wo.mapUrl })
      .then(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [wo, sheetId])

  const download = async () => {
    if (!wo || !ready || busy) return
    setBusy(true)
    try {
      await downloadPDF(sheetId, `ใบงานซ่อม-${wo.number}.pdf`)
    } catch (e) {
      setError(`สร้าง PDF ไม่สำเร็จ: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`ใบงานซ่อม ${wo?.number || ''}`.trim()} onClose={onClose} maxWidth={800}>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {error && <div className="alert alert-error">{error}</div>}
        {!wo && !error && <div style={{ color: 'var(--text3)' }}>กำลังโหลด...</div>}
        {wo && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}>
            <RepairWorkOrderSheet wo={wo} id={sheetId} />
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button type="button" className="btn btn-primary" disabled={!wo || !ready || busy} onClick={download}>
          {wo && ready && !busy ? '📄 ดาวน์โหลด PDF' : 'กำลังเตรียม…'}
        </button>
      </div>
    </Modal>
  )
}
