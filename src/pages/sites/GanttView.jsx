// ============================================================
// GanttView — 1 แถวต่อไซท์ แสดงแท่งขั้นตอนงานตามช่วงเวลา
// ============================================================
import { useMemo } from 'react'
import { useSitePhases } from '../../hooks/useSupabase.js'
import { computeTimelineRange, barStyle, STATUS_COLOR } from './ganttTimeline.js'

export default function GanttView({ sites, navigateTo, onManagePhases, selectedSiteId, onSelectSite }) {
  const { data: allPhases } = useSitePhases()

  const phasesBySite = useMemo(() => {
    const m = {}
    ;(allPhases || []).forEach((p) => {
      if (!m[p.site_id]) m[p.site_id] = []
      m[p.site_id].push(p)
    })
    return m
  }, [allPhases])

  const range = useMemo(() => computeTimelineRange(sites, phasesBySite), [sites, phasesBySite])

  if (!range) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่มีไซท์ที่มีวันที่ให้แสดงบน Gantt
      </div>
    )
  }

  return (
    <div className="card">
      {sites.map((site) => {
        const phases = phasesBySite[site.id] || []
        const isSelected = selectedSiteId === site.id
        return (
          <div
            key={site.id}
            onClick={() => onSelectSite(site.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              background: isSelected ? 'var(--bg2)' : 'transparent',
            }}
          >
            <div style={{ width: 180, flexShrink: 0 }}>
              <div
                style={{ fontWeight: 600, fontSize: 13, textDecoration: 'underline dotted' }}
                onClick={(e) => { e.stopPropagation(); navigateTo('assign', { siteId: site.id, siteName: site.name }) }}
                title="ไปหน้า Assign ของไซท์นี้"
              >
                {site.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--accent)' }}>{site.site_number}</div>
            </div>
            <div style={{ position: 'relative', flex: 1, height: 28, background: 'var(--bg2)', borderRadius: 4 }}>
              {phases.map((phase) => {
                const style = barStyle(phase, range)
                if (!style) return null
                return (
                  <div
                    key={phase.id}
                    title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${phase.status}`}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      left: style.left,
                      width: style.width,
                      background: STATUS_COLOR[phase.status] || STATUS_COLOR.not_started,
                      borderRadius: 3,
                    }}
                  />
                )
              })}
            </div>
            <button
              className="btn btn-sm btn-ghost"
              style={{ flexShrink: 0 }}
              onClick={(e) => { e.stopPropagation(); onManagePhases(site) }}
            >
              📋 จัดการขั้นตอน
            </button>
          </div>
        )
      })}
      {!sites.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไม่พบข้อมูลไซท์งาน</div>
      )}
    </div>
  )
}
