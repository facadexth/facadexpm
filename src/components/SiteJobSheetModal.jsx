// ใบงานประจำวัน preview + PDF for staff, opened from the Assign day view (🖨 ใบงานวันนี้).
//   siteId    -- sites.id
//   date      -- 'YYYY-MM-DD' (Bangkok day shown in the day view)
//   shortName -- sites.short_name when the caller has it (used in the file name)
//   onClose() -- closed
// Loads with the logged-in client, so RLS decides what the viewer sees (a PM may get no drawings).
// The PDF button stays disabled (กำลังเตรียม…) until every <img> in the sheet has finished and the
// map QR is in place, the same rule as RepairWorkOrderModal.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { downloadPDF } from '../lib/pdf.js'
import { loadJobSheet } from '../lib/siteJobsheetLoad.js'
import { waitForSheetImages } from '../lib/repairWorkorderLoad.js'
import { Modal } from './Modal.jsx'
import SiteJobSheet from './SiteJobSheet.jsx'

// '2026-11-26' -> '26-11-2569'
export function beDateForFile(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return ''
  return `${m[3]}-${m[2]}-${Number(m[1]) + 543}`
}

export function jobSheetFileName(name, iso) {
  const safe = String(name || '').trim().replace(/[\\/]+/g, '-') || 'ไซท์'
  const d = beDateForFile(iso)
  return `ใบงาน-${safe}${d ? `-${d}` : ''}.pdf`
}

export default function SiteJobSheetModal({ siteId, date, shortName, onClose }) {
  const { tenant, loading: tenantLoading } = useTenant()
  const [sheet, setSheet] = useState(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const sheetId = `site-js-${siteId}`
  // useTenant hands out a new tenant object on every session revalidation; reload only when the
  // letterhead itself changes.
  const tenantRef = useRef(tenant)
  tenantRef.current = tenant
  const headerKey = JSON.stringify([tenant?.company_name, tenant?.address, tenant?.phone, tenant?.logo_url])

  useEffect(() => {
    if (tenantLoading) return undefined
    let alive = true
    setSheet(null); setError(''); setReady(false)
    loadJobSheet(supabase, siteId, tenantRef.current, date)
      .then((s) => { if (alive) setSheet(s) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [siteId, date, headerKey, tenantLoading])

  useEffect(() => {
    if (!sheet) return undefined
    let alive = true
    setReady(false)
    waitForSheetImages(document.getElementById(sheetId), { needQr: !!sheet.mapUrl })
      .then(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [sheet, sheetId])

  const download = async () => {
    if (!sheet || !ready || busy) return
    setBusy(true)
    try {
      const name = (shortName || '').trim() || sheet.siteName
      await downloadPDF(sheetId, jobSheetFileName(name, date))
    } catch (e) {
      setError(`สร้าง PDF ไม่สำเร็จ: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const title = sheet ? `ใบงานประจำวัน · ${sheet.siteName} · ${sheet.dateText}` : 'ใบงานประจำวัน'

  return (
    <Modal title={title} onClose={onClose} maxWidth={800}>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {error && <div className="alert alert-error">{error}</div>}
        {!sheet && !error && <div style={{ color: 'var(--text3)' }}>กำลังโหลด...</div>}
        {sheet && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}>
            <SiteJobSheet sheet={sheet} id={sheetId} />
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button type="button" className="btn btn-primary" disabled={!sheet || !ready || busy} onClick={download}>
          {sheet && ready && !busy ? '📄 ดาวน์โหลด PDF' : 'กำลังเตรียม…'}
        </button>
      </div>
    </Modal>
  )
}
