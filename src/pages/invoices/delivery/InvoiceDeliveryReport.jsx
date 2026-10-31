// Invoices list entry point for the delivery report (รายงานส่งงาน, DR):
// per-row status (one query for all shown invoices), signed badge, and the
// launcher that opens the editor (no report yet) or the document + signing.
import { useEffect, useState } from 'react'
import { fetchDeliveryReportStatuses, markSignedSeenMany } from '../../../hooks/useDeliveryReport.js'
import DeliveryReportEditor from './DeliveryReportEditor.jsx'
import { DeliveryReportWithSigning } from './SignChooser.jsx'

export function thaiDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
}

// { [invoiceId]: currentReport } for the given invoices; marks shown signed reports as seen once (editors only).
export function useDeliveryReportStatuses(invoiceIds, { canEdit = false } = {}) {
  const key = [...new Set((invoiceIds || []).filter(Boolean))].sort().join(',')
  const [map, setMap] = useState({})
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let alive = true
    if (!key) { setMap({}); return }
    fetchDeliveryReportStatuses(key.split(','))
      .then(m => {
        if (!alive) return
        setMap(m)
        const unseen = Object.values(m).filter(r => r.status === 'signed' && !r.signed_seen_at).map(r => r.id)
        if (canEdit && unseen.length) markSignedSeenMany(unseen).catch(e => console.error('markSignedSeen failed', e))
      })
      .catch(e => console.error('delivery report status load failed', e))
    return () => { alive = false }
  }, [key, version, canEdit])
  return { map, refetch: () => setVersion(v => v + 1) }
}

export function DeliveryReportBadge({ report }) {
  if (report?.status !== 'signed') return null
  return (
    <span className="badge" data-testid="dr-signed-badge" style={{ marginLeft: 6, fontSize: 10, background: '#dcfce7', color: '#166534', borderColor: '#16a34a' }}>
      ลูกค้าเซ็นรับงานแล้ว {thaiDate(report.signed_at)}
    </span>
  )
}

// Opens the editor when the invoice has no current report, else the document (with ✏️ แก้ไข → editor;
// editing a signed report reissues it, handled inside the editor).
export function DeliveryReportLauncher({ invoice, current, tenantId, onClose, onChanged }) {
  const [mode, setMode] = useState(current ? 'doc' : 'edit')
  const [reportId, setReportId] = useState(current?.id ?? null)
  if (mode === 'edit') {
    return (
      <DeliveryReportEditor invoiceId={invoice.id}
        onClose={() => (reportId ? setMode('doc') : onClose())}
        onSaved={r => { onChanged?.(); setReportId(r?.id ?? reportId); setMode('doc') }} />
    )
  }
  return (
    <DeliveryReportWithSigning invoiceId={invoice.id} reportId={reportId} tenantId={tenantId}
      onClose={() => { onChanged?.(); onClose() }} onEdit={() => setMode('edit')} />
  )
}
