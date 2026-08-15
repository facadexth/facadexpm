// ============================================================
// Assign — Assign ช่างต่อไซท์งาน
// ✅ มุมมอง Day / Week / Month (สัปดาห์เริ่มวันจันทร์)
// ✅ Wizard: เลือกหลายวัน → ประเภท → ไซท์ → ช่างหลายคน + กะเช้า/บ่าย
// ✅ กะเช้า-บ่าย (1 กะ = 0.5 วัน) · คลิกช่องแก้รายกะ
// ✅ ค่าแรง + ค่าเดินทางต่อไซท์
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useWorkers, useSites, useAssignmentsRange, useLaborCost, useSiteTravelCost, useAppSetting, useWorkerOTRange, useOTCostBySite, useCompanyHolidaysRange } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { fmt } from '../lib/supabase.js'
import { ConfirmDialog } from '../components/Modal.jsx'
import ViewToggle from './assign/ViewToggle.jsx'
import GridView from './assign/GridView.jsx'
import DayView from './assign/DayView.jsx'
import MySchedule from './assign/MySchedule.jsx'
import AssignWizard from './assign/AssignWizard.jsx'
import AssignOTWizard from './assign/AssignOTWizard.jsx'
import CellEditPopup from './assign/CellEditPopup.jsx'
import { computeRange } from './assign/useAssignRange.js'
import { TYPE_LEGEND, TYPE_COLOR } from './assign/constants.js'
import { buildLineText } from './assign/lineExport.js'

export default function Assign({ navState }) {
  const { isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN')

  const [view, setView]     = useState('week')
  const [anchor, setAnchor] = useState(new Date())
  const [wizardOpen, setWizardOpen] = useState(false)
  const [otWizardOpen, setOtWizardOpen] = useState(false)
  const [cellTarget, setCellTarget] = useState(null)   // { worker, date, shift, existing }
  const [saving, setSaving] = useState(false)
  const [pendingRows, setPendingRows] = useState(null) // rows waiting for conflict confirm
  const [conflictMsg, setConflictMsg] = useState('')
  const [copied, setCopied] = useState(false)

  const { from, to, days } = useMemo(() => computeRange(view, anchor), [view, anchor])

  const { data: workers }   = useWorkers()
  const { data: sites }     = useSites()
  const { data: assignments, refetch } = useAssignmentsRange(from, to)
  const { data: laborData } = useLaborCost()
  const { data: travelData } = useSiteTravelCost()
  const { data: otEntries, refetch: refetchOT } = useWorkerOTRange(from, to)
  const { data: otCostData } = useOTCostBySite()
  const { data: holidaysInRange } = useCompanyHolidaysRange(from, to)
  const holidayDates = useMemo(() => {
    const m = new Map()
    ;(holidaysInRange || []).forEach(h => m.set(h.date, h.name))
    return m
  }, [holidaysInRange])
  const { data: travelRateVal } = useAppSetting('travel_rate_per_km', '20')
  const travelRate = parseFloat(travelRateVal) || 0

  const ongoingSites = useMemo(() => (sites || []).filter(s => s.status === 'Ongoing'), [sites])

  // cellLookup[worker_id][iso] = { morning?, evening? } each { id, type, site_id, site_number, ot, notes }
  const cellLookup = useMemo(() => {
    const m = {}
    ;(assignments || []).forEach(a => {
      const w = m[a.worker_id] || (m[a.worker_id] = {})
      const c = w[a.date] || (w[a.date] = {})
      c[a.shift] = { id: a.id, type: a.type || 'site', site_id: a.site_id, site_number: a.sites?.site_number, site_name: a.sites?.name, ot: a.ot_hours || 0, notes: a.notes || '' }
    })
    return m
  }, [assignments])

  // otLookup[worker_id][iso] = { id, site_id, site_number, site_name, start_time, end_time, ot_hours, is_overnight, notes }
  const otLookup = useMemo(() => {
    const m = {}
    ;(otEntries || []).forEach(o => {
      const w = m[o.worker_id] || (m[o.worker_id] = {})
      w[o.date] = { id: o.id, site_id: o.site_id, site_number: o.sites?.site_number, site_name: o.sites?.name, start_time: o.start_time, end_time: o.end_time, ot_hours: o.ot_hours || 0, is_overnight: o.is_overnight || false, notes: o.notes || '' }
    })
    return m
  }, [otEntries])

  // labor + travel + OT cost per site (all-time)
  const costBySite = useMemo(() => {
    const m = {}
    ;(laborData || []).forEach(l => {
      const g = m[l.site_id] || (m[l.site_id] = { site_number: l.site_number, site_name: l.site_name, labor: 0, travel: 0, ot: 0, workers: [] })
      g.labor += l.labor_cost || 0
      g.workers.push({ name: l.worker_name, days: l.days_worked, cost: l.labor_cost })
    })
    ;(travelData || []).forEach(t => {
      const g = m[t.site_id] || (m[t.site_id] = { site_number: '', site_name: '', labor: 0, travel: 0, ot: 0, workers: [] })
      g.travel += t.travel_cost || 0
    })
    ;(otCostData || []).forEach(o => {
      const g = m[o.site_id] || (m[o.site_id] = { site_number: o.site_number, site_name: o.site_name, labor: 0, travel: 0, ot: 0, workers: [] })
      g.ot += o.ot_cost || 0
    })
    return Object.values(m).sort((a, b) => (b.labor + b.travel + b.ot) - (a.labor + a.travel + a.ot))
  }, [laborData, travelData, otCostData])

  // ── save helpers ──
  const doUpsert = async (rows) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_assignments')
        .upsert(rows, { onConflict: 'worker_id,date,shift' })
      if (error) throw error
      setWizardOpen(false); setPendingRows(null); setConflictMsg(''); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleWizardSubmit = async (rows) => {
    setSaving(true)
    try {
      const workerIds = [...new Set(rows.map(r => r.worker_id))]
      const dates     = [...new Set(rows.map(r => r.date))]
      const { data: existing, error } = await supabase.from('worker_assignments')
        .select('worker_id, date, shift, type, workers(nickname, name), sites(site_number)')
        .in('worker_id', workerIds).in('date', dates)
      if (error) throw error
      const k = (r) => `${r.worker_id}|${r.date}|${r.shift}`
      const exMap = new Map((existing || []).map(e => [k(e), e]))
      const conflicts = rows.filter(r => exMap.has(k(r))).map(r => exMap.get(k(r)))
      if (conflicts.length) {
        const lines = conflicts.slice(0, 8).map(c =>
          `• ${c.workers?.nickname || c.workers?.name} — ${c.date} (${c.shift === 'morning' ? 'เช้า' : 'บ่าย'}) มีงาน ${c.sites?.site_number || c.type} อยู่แล้ว`)
        setPendingRows(rows)
        setConflictMsg(`พบ ${conflicts.length} กะที่มีงานอยู่แล้ว:\n${lines.join('\n')}${conflicts.length > 8 ? '\n…' : ''}\n\nยืนยันจะเขียนทับตามนี้ไหม?`)
        setSaving(false)
        return
      }
      await doUpsert(rows)
    } catch (e) { alert('Error: ' + e.message); setSaving(false) }
  }

  const handleCellSave = async (row) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_assignments')
        .upsert(row, { onConflict: 'worker_id,date,shift' })
      if (error) throw error
      setCellTarget(null); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleCellDelete = async () => {
    if (!cellTarget?.existing?.id) return
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_assignments').delete().eq('id', cellTarget.existing.id)
      if (error) throw error
      setCellTarget(null); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleOTSave = async (row) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_ot')
        .upsert(row, { onConflict: 'worker_id,date' })
      if (error) throw error
      refetchOT()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleOTDelete = async () => {
    if (!cellTarget?.existingOT?.id) return
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_ot').delete().eq('id', cellTarget.existingOT.id)
      if (error) throw error
      setCellTarget(t => t ? { ...t, existingOT: null } : t)
      refetchOT()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleOTWizardSubmit = async (rows) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_ot')
        .upsert(rows, { onConflict: 'worker_id,date' })
      if (error) throw error
      setOtWizardOpen(false); refetchOT()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const openCell = (worker, date, shift) => {
    const existing = cellLookup[worker.id]?.[date]?.[shift] || null
    const existingOT = otLookup[worker.id]?.[date] || null
    setCellTarget({ worker, date, shift, existing, existingOT })
  }

  const handleCopyLine = async () => {
    const text = buildLineText(days, assignments, sites, otEntries)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) { alert('คัดลอกไม่สำเร็จ: ' + e.message) }
  }

  const cellH = view === 'month' ? 30 : 38

  return (
    <div>
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>+ Assign งาน</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setOtWizardOpen(true)}>⚡ Assign OT</button>}
        {(view === 'day' || view === 'week') && (
          <button className="btn btn-ghost" onClick={handleCopyLine}>{copied ? '✅ คัดลอกแล้ว!' : '📋 คัดลอกสำหรับ LINE'}</button>
        )}
        <div style={{ flex: 1 }} />
        <ViewToggle view={view} onView={setView} anchor={anchor} onAnchor={setAnchor} holidayDates={holidayDates} />
      </div>

      {/* ── Legend ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {TYPE_LEGEND.map(t => (
          <span key={t.type} style={{ fontSize: 11, background: TYPE_COLOR[t.type].bg, color: TYPE_COLOR[t.type].color, padding: '2px 8px', borderRadius: 10 }}>{t.label}</span>
        ))}
      </div>

      {/* ── View ── */}
      {!canEdit ? (
        <MySchedule from={from} to={to} days={days} />
      ) : view === 'day' ? (
        <DayView dayIso={from} assignments={assignments} otEntries={otEntries} sites={sites} travelRate={travelRate} onEditHalf={openCell} />
      ) : (
        <GridView days={days} workers={workers} cellLookup={cellLookup} otLookup={otLookup} holidayDates={holidayDates} onEditHalf={openCell} cellH={cellH} variant={view} />
      )}

      {/* ── Labor + Travel cost per site (ADMIN+ only — reveals per-worker cost) ── */}
      {canEdit && (
      <>
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        ค่าแรง + ค่าเดินทาง ต่อไซท์งาน (ทุกช่วงเวลา)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 24 }}>
        {costBySite.map((s, i) => (
          <div key={i} className="card card-body" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--accent)' }}>{s.site_number}</div>
                <div style={{ fontWeight: 700, fontSize: 14, overflowWrap: 'anywhere' }}>{s.site_name}</div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวม</div>
                <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 18 }}>{fmt(s.labor + s.travel + s.ot)}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>แรง {fmt(s.labor)}{s.travel > 0 && <> · เดินทาง {fmt(s.travel)}</>}{s.ot > 0 && <> · OT {fmt(s.ot)}</>}</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {s.workers.map((w, j) => (
                <div key={j} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderTop: j > 0 ? '1px solid var(--border)' : 'none', paddingTop: j > 0 ? 4 : 0 }}>
                  <span style={{ color: 'var(--text2)' }}>{w.name}</span>
                  <span style={{ color: 'var(--text3)' }}>{w.days} วัน = <strong style={{ color: 'var(--text)' }}>{fmt(w.cost)}</strong></span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!costBySite.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีข้อมูล assignment</div>}
      </div>
      </>
      )}

      {/* ── Wizard ── */}
      {wizardOpen && (
        <AssignWizard
          workers={workers || []}
          sites={ongoingSites}
          initialSiteId={navState?.siteId || ''}
          onSubmit={handleWizardSubmit}
          onClose={() => setWizardOpen(false)}
          saving={saving}
        />
      )}

      {/* ── OT Wizard ── */}
      {otWizardOpen && (
        <AssignOTWizard
          workers={workers || []}
          sites={ongoingSites}
          initialSiteId={navState?.siteId || ''}
          initialDate={new Date().toISOString().slice(0, 10)}
          onSubmit={handleOTWizardSubmit}
          onClose={() => setOtWizardOpen(false)}
          saving={saving}
        />
      )}

      {/* ── Conflict confirm ── */}
      {conflictMsg && (
        <ConfirmDialog
          title="มีงานอยู่แล้วในบางกะ"
          message={<span style={{ whiteSpace: 'pre-wrap' }}>{conflictMsg}</span>}
          onConfirm={() => doUpsert(pendingRows)}
          onCancel={() => { setConflictMsg(''); setPendingRows(null) }}
        />
      )}

      {/* ── Cell edit ── */}
      {cellTarget && (
        <CellEditPopup
          target={cellTarget}
          sites={ongoingSites}
          onSave={handleCellSave}
          onDelete={handleCellDelete}
          onSaveOT={handleOTSave}
          onDeleteOT={handleOTDelete}
          onClose={() => setCellTarget(null)}
          saving={saving}
        />
      )}
    </div>
  )
}
