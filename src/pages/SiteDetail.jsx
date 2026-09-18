// ============================================================
// SiteDetail -- per-site page (ภาพรวม / Gantt / Kanban tabs). Reached
// via navigateTo('site_detail', { siteId, siteName }) from Sites.jsx's
// site name click. Not a visible nav tab -- see App.jsx's ALL_TAB_ENTRIES.
// ============================================================
import { useState } from 'react'
import { useSiteOverview } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import SiteOverviewContent from '../components/SiteOverviewContent.jsx'
import GanttView from './sites/GanttView.jsx'
import SCurveChart from './sites/SCurveChart.jsx'
import PhaseKanbanBoard from './sites/PhaseKanbanBoard.jsx'

export default function SiteDetail({ navState, navigateTo }) {
  const siteId = navState?.siteId
  const siteName = navState?.siteName
  const [tab, setTab] = useState('overview') // 'overview' | 'gantt' | 'kanban'
  const [phasesRefreshKey, setPhasesRefreshKey] = useState(0)
  const [kanbanInitialLeafId, setKanbanInitialLeafId] = useState(null) // ตั้งค่าเมื่อคลิก leaf บนแท็บ Gantt เพื่อ deep-link ไปยัง chip ที่ตรงกันในแท็บ Kanban

  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'sites')

  const { data: site, error: siteError } = useSiteOverview(siteId)

  if (!siteId) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่พบไซท์งานที่เลือก — <button className="btn btn-sm btn-ghost" onClick={() => navigateTo('sites')}>กลับไปหน้าไซท์งาน</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigateTo('sites')}>← ไซท์งานทั้งหมด</button>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>
        {site?.site_number ? `${site.site_number} · ` : ''}{site?.name || siteName || 'ไซท์งาน'}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${tab === 'overview' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('overview')}
        >ภาพรวม</button>
        <button
          className={`btn btn-sm ${tab === 'gantt' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('gantt')}
        >📅 Gantt</button>
        <button
          className={`btn btn-sm ${tab === 'kanban' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('kanban')}
        >🗂 Kanban</button>
      </div>

      {tab === 'overview' && <SiteOverviewContent siteId={siteId} />}

      {tab === 'gantt' && (
        siteError ? (
          <div className="card" style={{ padding: 24, color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {siteError}</div>
        ) : !site ? (
          <div className="card" style={{ padding: 24, color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
        ) : (
          <>
            <GanttView
              key={phasesRefreshKey}
              sites={[site]}
              navigateTo={navigateTo}
              selectedSiteId={site.id}
              onSelectSite={() => {}}
              canEdit={canEdit}
              onPhasesChanged={() => setPhasesRefreshKey((k) => k + 1)}
              onOpenKanban={(_site, leafNode) => { setKanbanInitialLeafId(leafNode.id); setTab('kanban') }}
            />
            <div style={{ marginTop: 16 }}>
              <SCurveChart key={phasesRefreshKey} site={site} />
            </div>
          </>
        )
      )}

      {tab === 'kanban' && (
        siteError ? (
          <div className="card" style={{ padding: 24, color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {siteError}</div>
        ) : !site ? (
          <div className="card" style={{ padding: 24, color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
        ) : (
          <PhaseKanbanBoard
            site={site}
            canEdit={canEdit}
            initialLeafId={kanbanInitialLeafId}
          />
        )
      )}
    </div>
  )
}
