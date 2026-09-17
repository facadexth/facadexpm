// ============================================================
// GanttView — สองมุมมอง: หลายไซท์ (1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว, ใช้
// ในหน้ารายการไซท์แบบภาพรวม) กับไซท์เดียว (1 แถวต่อขั้นตอน พร้อมแกนเดือน,
// ใช้ในหน้า SiteDetail — sites.length === 1 สลับโหมดอัตโนมัติ)
// + ลูกศร dependency (soft) + แก้ไขขั้นตอนได้ในหน้านี้เลย (ไซท์เดียว) +
// เทมเพลตขั้นตอนงานแบบเพิ่มเมื่อต้องการ (ไม่ auto-seed ทุกไซท์แล้ว) +
// สถานะขั้นตอนที่มี phase_tasks (Kanban) คำนวณสดจากงานย่อย ไม่ใช่ตั้งเอง
// ============================================================
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { useSitePhases, usePhaseTasks, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { computeTimelineRange, positionPercent, barStyle, computeDependencyArrows, computeDependencyArrowsByRow, computeMonthTicks, STATUS_COLOR, PHASE_TEMPLATE, expandRangeForTransactions } from './ganttTimeline.js'
import { computePhaseTaskStats } from './phaseTasksCalc.js'
import { getEffectiveTheme } from '../../lib/theme.js'

const ROW_H = 34
const EDIT_H = 320
const LABEL_W = 170
const TODAY_ISO = new Date().toISOString().slice(0, 10)
// สำหรับมุมมองหลายไซท์ (portfolio) ไม่ต้องขยาย timeline ตามรายรับ/รายจ่าย
// ของไซท์ใดไซท์หนึ่ง -- ใช้ UUID ปลอมนี้เป็น siteId filter เพื่อให้ hook ดึงมา
// 0 แถวเสมอ (ยังคงเรียก hook เดิมแบบไม่มีเงื่อนไข ตาม Rules of Hooks)
const NIL_SITE_ID = '00000000-0000-0000-0000-000000000000'

const STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จแล้ว' },
]

const emptyDraft = (site, phases) => ({
  name: '', start_date: '', end_date: '', status: 'not_started',
  billing_weight_pct: 0, depends_on_phase_id: '', sort_order: phases.length + 1,
})

export default function GanttView({ sites, navigateTo, onManagePhases, selectedSiteId, onSelectSite, canEdit, onPhasesChanged }) {
  const { data: allPhases, refetch } = useSitePhases()
  const { data: allTasks } = usePhaseTasks()
  const singleSiteId = sites.length === 1 ? sites[0].id : NIL_SITE_ID
  const { data: incomesForRange } = useIncomes({ siteId: singleSiteId })
  const { data: expensesForRange } = useExpenses({ siteId: singleSiteId })

  // แก้ไข/เพิ่ม/ลบขั้นตอนแบบ inline (ใช้เฉพาะมุมมองไซท์เดียว) -- hooks ต้อง
  // อยู่บนสุดเสมอ ไม่ผูกกับ branch ไหน
  const [editingId, setEditingId] = useState(null) // phase.id ที่กำลังแก้ หรือ '__new__'
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [applyingTemplate, setApplyingTemplate] = useState(false)

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

  const tasksByPhaseId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => {
      if (!m[t.phase_id]) m[t.phase_id] = []
      m[t.phase_id].push(t)
    })
    return m
  }, [allTasks])

  const baseRange = useMemo(() => computeTimelineRange(sites, phasesBySite), [sites, phasesBySite])

  // ขยาย range ให้ครอบคลุมวันที่รายรับ/รายจ่ายจริงด้วย (ไม่ใช่แค่วันที่ตั้งไว้
  // ในขั้นตอน) -- ใช้ฟังก์ชันเดียวกับ SCurveChart.jsx กับรายรับ/รายจ่ายชุด
  // เดียวกัน ให้สองกราฟได้ timeline เดียวกันเป๊ะๆ เสมอ ไม่มีทางเพี้ยนต่างกัน
  // (ในมุมมองหลายไซท์ singleSiteId เป็น UUID ปลอม ทำให้ incomesForRange/
  // expensesForRange ว่างเสมอ ฟังก์ชันนี้จึงคืนค่า baseRange เดิมโดยไม่ขยาย)
  const transactionDatesForRange = useMemo(() => [
    ...(incomesForRange || []).map((i) => i.date),
    ...(expensesForRange || []).map((e) => e.date),
  ], [incomesForRange, expensesForRange])
  const range = useMemo(() => expandRangeForTransactions(baseRange, transactionDatesForRange), [baseRange, transactionDatesForRange])

  const afterWrite = async () => {
    await refetch()
    onPhasesChanged?.()
  }

  const startEdit = (phase) => { setEditingId(phase.id); setDraft({ ...phase, depends_on_phase_id: phase.depends_on_phase_id || '' }) }
  const startAdd = (site, phases) => { setEditingId('__new__'); setDraft(emptyDraft(site, phases)) }
  const cancelEdit = () => { setEditingId(null); setDraft(null) }

  const saveDraft = async (site) => {
    if (!draft.name.trim()) { alert('กรุณาตั้งชื่อขั้นตอน'); return }
    setSaving(true)
    try {
      const payload = {
        name: draft.name.trim(),
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        status: draft.status,
        billing_weight_pct: parseFloat(draft.billing_weight_pct) || 0,
        depends_on_phase_id: draft.depends_on_phase_id || null,
        sort_order: draft.sort_order,
      }
      if (editingId === '__new__') {
        const { error } = await supabase.from('site_phases').insert({ site_id: site.id, ...payload })
        if (error) throw error
      } else {
        const { error } = await supabase.from('site_phases').update(payload).eq('id', editingId)
        if (error) throw error
      }
      await afterWrite()
      cancelEdit()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (id) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('site_phases').delete().eq('id', id)
      if (error) throw error
      await afterWrite()
      if (editingId === id) cancelEdit()
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
      setConfirmDeleteId(null)
    }
  }

  const applyTemplate = async (site) => {
    setApplyingTemplate(true)
    try {
      const rows = PHASE_TEMPLATE.map((t) => ({ site_id: site.id, ...t }))
      const { error } = await supabase.from('site_phases').insert(rows)
      if (error) throw error
      await afterWrite()
    } catch (e) {
      alert('เพิ่มเทมเพลตไม่สำเร็จ: ' + e.message)
    } finally {
      setApplyingTemplate(false)
    }
  }

  // ── ไซท์เดียว: 1 แถวต่อขั้นตอน (หน้า SiteDetail) ──
  if (sites.length === 1) {
    const site = sites[0]
    const phases = phasesBySite[site.id] || []
    const isAdding = editingId === '__new__'
    const rows = isAdding ? [...phases, { id: '__new__', isNew: true }] : phases

    // สถานะที่ "แสดงจริง" ต่อขั้นตอน: ถ้ามี phase_tasks (Kanban) แล้ว คำนวณสด
    // จาก done/total แทนค่า status ที่ตั้งเอง -- ขั้นตอนที่ไม่มี task เลย
    // ยังใช้ status ที่ตั้งเองเหมือนเดิมทุกประการ (ไม่มี regression)
    const phaseStatsById = {}
    phases.forEach((p) => {
      const stats = computePhaseTaskStats(tasksByPhaseId[p.id] || [])
      phaseStatsById[p.id] = { stats, displayStatus: stats.total > 0 ? stats.derivedStatus : p.status }
    })

    if (!phases.length && !isAdding) {
      return (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ color: 'var(--text3)', marginBottom: 14 }}>ไซท์นี้ยังไม่มีขั้นตอนงาน</div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={applyingTemplate} onClick={() => applyTemplate(site)}>
                {applyingTemplate ? '⏳ กำลังเพิ่ม...' : '+ เริ่มใช้ Gantt (เทมเพลตขั้นตอนงาน)'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(site, phases)}>+ เพิ่มขั้นตอนเอง</button>
            </div>
          )}
        </div>
      )
    }

    const monthTicks = range ? computeMonthTicks(range) : []
    const arrows = editingId ? [] : computeDependencyArrowsByRow(phases, range)
    const doneCount = phases.filter((p) => phaseStatsById[p.id].displayStatus === 'done').length
    const inProgressCount = phases.filter((p) => phaseStatsById[p.id].displayStatus === 'in_progress').length
    const overallPct = phases.length ? Math.round((doneCount / phases.length) * 100) : 0
    // Same reasoning as SCurveChart's todayInRange guard: only draw "today"
    // when it actually falls inside this site's own timeline, otherwise a
    // clamped line at 0%/100% would falsely read as "today = start/end".
    const todayInRange = range && range.start <= new Date(TODAY_ISO) && new Date(TODAY_ISO) <= range.end
    const todayX = todayInRange ? positionPercent(TODAY_ISO, range) : null

    // ยอดสะสมตามแนวตั้ง: แถวที่กำลังแก้ไข/เพิ่ม จะสูงกว่าแถวปกติ เพื่อดัน
    // แถวถัดไปลงแทนที่จะซ้อนทับ (เดิมใช้ i*ROW_H คงที่ ตอนนี้ต้องคำนวณสะสม)
    let cursor = 0
    const rowTops = rows.map((r) => {
      const top = cursor
      cursor += (editingId && (r.id === editingId || (isAdding && r.id === '__new__'))) ? ROW_H + EDIT_H : ROW_H
      return top
    })
    const bodyHeight = Math.max(cursor, ROW_H)

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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div className="card-title">ไทม์ไลน์เฟสงาน</div>
            {canEdit && !editingId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(site, phases)}>+ เพิ่มขั้นตอน</button>
            )}
          </div>
          {monthTicks.length > 0 && (
            <div style={{ position: 'relative', height: 20, marginLeft: LABEL_W }}>
              {monthTicks.map((t, i) => (
                <div key={i} style={{ position: 'absolute', left: `${t.x}%`, fontSize: 10.5, color: 'var(--text3)', transform: 'translateX(-50%)' }}>
                  {format(t.date, 'MMM yy', { locale: th })}
                </div>
              ))}
            </div>
          )}
          <div style={{ position: 'relative', height: bodyHeight }}>
            {rows.map((phase, i) => {
              const top = rowTops[i]
              const isEditingThis = editingId && phase.id === editingId
              const style = phase.isNew ? null : barStyle(phase, range)
              const ps = phaseStatsById[phase.id]

              if (isEditingThis) {
                return (
                  <div key={phase.id} style={{ position: 'absolute', top, left: 0, right: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', height: ROW_H, gap: 8 }}>
                      <input
                        className="input input-sm" style={{ flex: 1, fontWeight: 600 }}
                        value={draft.name} placeholder="ชื่อขั้นตอน" autoFocus
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      />
                    </div>
                    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 4, display: 'grid', gap: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          เริ่ม
                          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.start_date || ''} onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value }))} />
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          สิ้นสุด
                          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.end_date || ''} onChange={(e) => setDraft((d) => ({ ...d, end_date: e.target.value }))} />
                        </label>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          สถานะ
                          {ps && ps.stats.total > 0 ? (
                            <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text2)', padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
                              คำนวณอัตโนมัติจากงานย่อย ({ps.stats.done}/{ps.stats.total} เสร็จ)
                            </div>
                          ) : (
                            <select className="select" style={{ width: '100%', marginTop: 2 }}
                              value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
                              {STATUS_OPTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                          )}
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          % เบิกเงิน
                          <input type="number" min="0" max="100" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.billing_weight_pct} onChange={(e) => setDraft((d) => ({ ...d, billing_weight_pct: e.target.value }))} />
                        </label>
                      </div>
                      <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                        ขึ้นอยู่กับขั้นตอน
                        <select className="select" style={{ width: '100%', marginTop: 2 }}
                          value={draft.depends_on_phase_id || ''} onChange={(e) => setDraft((d) => ({ ...d, depends_on_phase_id: e.target.value }))}>
                          <option value="">— ไม่ขึ้นกับขั้นตอนอื่น —</option>
                          {phases.filter((p) => p.id !== editingId).map((p) => (
                            <option key={p.id} value={p.id}>{p.name || '(ยังไม่ตั้งชื่อ)'}</option>
                          ))}
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
                        {!phase.isNew && (
                          <button type="button" className="btn btn-sm btn-danger" style={{ marginRight: 'auto' }}
                            disabled={saving} onClick={() => setConfirmDeleteId(editingId)}>🗑 ลบ</button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={cancelEdit}>ยกเลิก</button>
                        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => saveDraft(site)}>
                          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              }

              const displayStatus = ps ? ps.displayStatus : phase.status
              const label = displayStatus === 'done' ? '✓'
                : displayStatus === 'in_progress' ? (ps && ps.stats.total > 0 ? `${ps.stats.pct}%` : 'กำลังทำ')
                : ''
              const titleSuffix = ps && ps.stats.total > 0 ? ` (${ps.stats.done}/${ps.stats.total} งานย่อยเสร็จ)` : ''

              return (
                <div key={phase.id} style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: LABEL_W, flexShrink: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={phase.name}>
                    {phase.name}
                  </div>
                  <div style={{ position: 'relative', flex: 1, height: 20, background: 'var(--bg3)', borderRadius: 5 }}>
                    {style && (
                      <div
                        title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${displayStatus}${titleSuffix}`}
                        style={{
                          position: 'absolute', top: 2, bottom: 2, left: style.left, width: style.width,
                          background: STATUS_COLOR[displayStatus] || STATUS_COLOR.not_started, borderRadius: 5,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 700, color: displayStatus === 'not_started' ? 'var(--text3)' : '#fff',
                          overflow: 'hidden', whiteSpace: 'nowrap',
                        }}
                      >
                        {label}
                      </div>
                    )}
                  </div>
                  {canEdit && !editingId && (
                    <button type="button" className="btn btn-sm btn-ghost" style={{ flexShrink: 0, padding: '2px 8px' }} onClick={() => startEdit(phase)}>✎</button>
                  )}
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
            {todayX != null && !editingId && (
              <div style={{ position: 'absolute', top: 0, left: LABEL_W, right: 0, bottom: 0, pointerEvents: 'none' }}>
                <div style={{ position: 'absolute', top: -16, left: `${todayX}%`, transform: 'translateX(-50%)', fontSize: 9.5, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                  วันนี้
                </div>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${todayX}%`, borderLeft: '1px dashed var(--text3)' }} />
              </div>
            )}
          </div>
          <div className="legend" style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--text2)' }}>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--green)' }} />เสร็จแล้ว</span>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--yellow)' }} />กำลังทำ</span>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--text3)' }} />ยังไม่เริ่ม</span>
          </div>
        </div>

        {confirmDeleteId && (
          <ConfirmDialog
            title="ลบขั้นตอนงาน"
            message="ต้องการลบขั้นตอนนี้ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้"
            danger
            onCancel={() => setConfirmDeleteId(null)}
            onConfirm={() => doDelete(confirmDeleteId)}
          />
        )}
      </>
    )
  }

  // ── หลายไซท์: 1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว (หน้ารายการไซท์) ──
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
