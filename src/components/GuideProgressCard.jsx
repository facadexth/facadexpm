// Dashboard card: shows how far a new owner is in the starting guide and what to do next.
// Hidden for non-owners, once every required step is done, or after the owner dismisses it
// (dismissal is a per-browser convenience kept in localStorage, never a record of progress).
import { useMemo, useState } from 'react'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { useGuideFacts } from '../hooks/useGuideFacts.js'
import { computeGuide } from '../lib/guideProgress.js'

function readDismissed(tenantId) {
  try { return localStorage.getItem(`guide_dismissed_${tenantId}`) === '1' } catch { return false }
}

export function GuideProgressCard({ navigateTo }) {
  const { isAtLeast } = useUserRole()
  const { tenant, hasModuleAccess } = useTenant()
  const isOwner = isAtLeast('OWNER')
  const [dismissed, setDismissed] = useState(() => (tenant?.id ? readDismissed(tenant.id) : false))
  const { data: facts } = useGuideFacts(isOwner && !dismissed)
  const guide = useMemo(
    () => computeGuide(facts ? { ...facts, tenant } : { tenant }, hasModuleAccess || (() => true)),
    [facts, tenant, hasModuleAccess],
  )

  if (!isOwner || dismissed || !facts || guide.complete) return null

  const dismiss = () => {
    try { if (tenant?.id) localStorage.setItem(`guide_dismissed_${tenant.id}`, '1') } catch { /* private window: just hide for now */ }
    setDismissed(true)
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>🚀 เริ่มต้นใช้งาน {guide.done}/{guide.total} ขั้นตอน</div>
          <div style={{ color: 'var(--text3)', fontSize: 13.5, marginTop: 2 }}>
            {guide.next ? `ขั้นต่อไป: ${guide.next.title}` : 'ทำครบทุกขั้นที่จำเป็นแล้ว'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => navigateTo('starting_guide')}>เปิดคู่มือ</button>
        <button className="btn btn-ghost" onClick={dismiss} aria-label="ซ่อนการ์ดเริ่มต้นใช้งาน">ซ่อน</button>
      </div>
    </div>
  )
}
