// ============================================================
// GanttView — สองมุมมอง: หลายไซท์ (1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว, ใช้
// ในหน้ารายการไซท์แบบภาพรวม) กับไซท์เดียว (1 แถวต่อขั้นตอน พร้อมแกนเดือน,
// ใช้ในหน้า SiteDetail — sites.length === 1 สลับโหมดอัตโนมัติ)
// + ลูกศร dependency (soft)
// ============================================================
import { useMemo } from 'react'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { useSitePhases } from '../../hooks/useSupabase.js'
import { computeTimelineRange, barStyle, computeDependencyArrows, computeDependencyArrowsByRow, computeMonthTicks, STATUS_COLOR } from './ganttTimeline.js'
import { getEffectiveTheme } from '../../lib/theme.js'

const ROW_H = 34
const LABEL_W = 170

export default function GanttView({ sites, navigateTo, onManagePhases, selectedSiteId, onSelectSite, canEdit }) {
  const { data: allPhases } = useSitePhases()

  // SVG presentation attributes (stroke=...) don't resolve CSS var() --
  // only real CSS property values do -- so derive a literal hex color here
  // instead, following Dashboard.jsx's chartColors pattern.
  const isDarkChart = getEffectiveTheme() === 'dark'
  const arrowColor = isDarkChart ? '#5c5f80' : '#928c7a'

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

  // ── ไซท์เดียว: 1 แถวต่อขั้นตอน (หน้า SiteDetail) ──
  if (sites.length === 1) {
    const site = sites[0]
    const phases = phasesBySite[site.id] || []
    const monthTicks = computeMonthTicks(range)
    const arrows = computeDependencyArrowsByRow(phases, range)
    const bodyHeight = Math.max(phases.length, 1) * ROW_H
    const doneCount = phases.filter((p) => p.status === 'done').length
    const inProgressCount = phases.filter((p) => p.status === 'in_progress').length
    const overallPct = phases.length ? Math.round((doneCount / phases.length) * 100) : 0

    return (
      <>
        <div className="kpi-grid kpi-grid-4">
          <div className="kpi-card green">
            <div className="kpi-label">ความคืบหน้ารวม</div>
            <div className="kpi-value">{overallPct}%</div>
            <div className="progress" style={{ marginTop: 8 }}><div className="progress-bar" style={{ width: `${overallPct}%` }} /></div>
          </div>
          <div className="kpi-card"><div className="kpi-label">เฟสทั้งหมด</div><div className="kpi-value">{phases.length}</div></div>
          <div className="kpi-card yellow"><div className="kpi-label">กำลังทำอยู่</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{inProgressCount}</div></div>
          <div className="kpi-card green"><div className="kpi-label">เสร็จแล้ว</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{doneCount}</div></div>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div className="card-title" style={{ marginBottom: 14 }}>ไทม์ไลน์เฟสงาน</div>
          {monthTicks.length > 0 && (
            <div style={{ position: 'relative', height: 20, marginLeft: LABEL_W }}>
              {monthTicks.map((t, i) => (
                <div key={i} style={{ position: 'absolute', left: `${t.x}%`, fontSize: 10.5, color: 'var(--text3)', transform: 'translateX(-50%)' }}>
                  {format(t.date, 'MMM yy', { locale: th })}
                </div>
              ))}
            </div>
          )}
          {!phases.length ? (
            <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>ไซท์นี้ยังไม่มีขั้นตอนงาน</div>
          ) : (
            <>
              <div style={{ position: 'relative', height: bodyHeight }}>
                {phases.map((phase, i) => {
                  const style = barStyle(phase, range)
                  return (
                    <div key={phase.id} style={{ position: 'absolute', top: i * ROW_H, left: 0, right: 0, height: ROW_H, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: LABEL_W, flexShrink: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={phase.name}>
                        {phase.name}
                      </div>
                      <div style={{ position: 'relative', flex: 1, height: 20, background: 'var(--bg3)', borderRadius: 5 }}>
                        {style && (
                          <div
                            title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${phase.status}`}
                            style={{
                              position: 'absolute', top: 2, bottom: 2, left: style.left, width: style.width,
                              background: STATUS_COLOR[phase.status] || STATUS_COLOR.not_started, borderRadius: 5,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 10, fontWeight: 700, color: phase.status === 'not_started' ? 'var(--text3)' : '#fff',
                              overflow: 'hidden', whiteSpace: 'nowrap',
                            }}
                          >
                            {phase.status === 'done' ? '✓' : phase.status === 'in_progress' ? 'กำลังทำ' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                {arrows.length > 0 && (
                  <svg
                    style={{ position: 'absolute', top: 0, left: LABEL_W, right: 0, bottom: 0, width: `calc(100% - ${LABEL_W}px)`, height: '100%', pointerEvents: 'none' }}
                    preserveAspectRatio="none" viewBox={`0 0 100 ${phases.length}`}
                  >
                    {arrows.map((a, i) => (
                      <line
                        key={i}
                        x1={a.fromX} y1={a.fromRow + 0.5} x2={a.toX} y2={a.toRow + 0.5}
                        stroke={arrowColor} strokeWidth="0.4" strokeDasharray="1 0.8" vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                )}
              </div>
              <div className="legend" style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--text2)' }}>
                <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--green)' }} />เสร็จแล้ว</span>
                <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--yellow)' }} />กำลังทำ</span>
                <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--text3)' }} />ยังไม่เริ่ม</span>
              </div>
            </>
          )}
        </div>
      </>
    )
  }

  // ── หลายไซท์: 1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว (หน้ารายการไซท์) ──
  return (
    <div className="card">
      {sites.map((site) => {
        const phases = phasesBySite[site.id] || []
        const arrows = computeDependencyArrows(phases, range)
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
              {arrows.length > 0 && (
                <svg
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                  preserveAspectRatio="none" viewBox="0 0 100 28"
                >
                  {arrows.map((a, i) => (
                    <line
                      key={i}
                      x1={a.fromX} y1={14} x2={a.toX} y2={14}
                      stroke={arrowColor} strokeWidth="0.6" strokeDasharray="1.5 1"
                    />
                  ))}
                </svg>
              )}
            </div>
            {canEdit && (
              <button
                className="btn btn-sm btn-ghost"
                style={{ flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); onManagePhases(site) }}
              >
                📋 จัดการขั้นตอน
              </button>
            )}
          </div>
        )
      })}
      {!sites.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไม่พบข้อมูลไซท์งาน</div>
      )}
    </div>
  )
}
