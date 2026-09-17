// ============================================================
// SiteOverviewModal -- popup summary for one site: contract/financials +
// มัดจำ (deposit) + retention, opened by clicking a site name in most of
// the app (Sites.jsx itself now navigates to a full SiteDetail page
// instead -- see src/pages/SiteDetail.jsx). Read-only; no edit actions.
// ADMIN+ only -- see App.jsx, this is never wired into WORKER-visible
// site-name displays.
// ============================================================
import { Modal } from './Modal.jsx'
import { useSiteOverview } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import SiteOverviewContent from './SiteOverviewContent.jsx'

export default function SiteOverviewModal({ siteId, onClose }) {
  const { isAtLeast } = useUserRole()
  const isAdmin = isAtLeast('ADMIN')
  const { data: site } = useSiteOverview(isAdmin ? siteId : null)

  if (!isAdmin) return null

  return (
    <Modal title={site ? `${site.site_number} · ${site.name}` : 'ไซท์งาน'} onClose={onClose} maxWidth={560}>
      <div className="modal-body">
        <SiteOverviewContent siteId={siteId} />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
