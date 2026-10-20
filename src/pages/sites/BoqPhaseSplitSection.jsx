// ============================================================
// BOQ tab › "แบ่ง % ต่อเฟส": one row per BOQ item (never grouped), one editable
// column per phase of the site (VO phases greyed), row total with ✓/✗, and a
// footer with the phase weights the database will derive (boqPhaseSplit.js
// computePhaseWeights = recompute_site_phase_weights). Defaults come from
// rpc('boq_phase_split_defaults') (the company template, name-matched); a cell
// that differs from its default is yellow with the tag "แก้เอง". Save goes
// through rpc('save_boq_phase_splits') only (the RPC enforces 100 per row);
// its Thai error is shown in the tab's error line. Editable by OWNER/PM
// (canManage); others read only. Shows shares as แต้ม, never baht.
// ============================================================
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useSitePhases } from '../../hooks/useSupabase.js'
import { fmtNum } from './progressCalc.js'
import { useProgressSchemaReady } from '../../lib/progressSchema.js'
import { useBoqPhaseSplits } from './useBoqPhaseSplits.js'
import {
  cellsFromRows, buildDefaultCells, cellsToRows, rowTotal, rowOk, cellIsCustom, itemShares, computePhaseWeights, cellNum,
} from './boqPhaseSplit.js'

export default function BoqPhaseSplitSection({ siteId, boq, sharesPct, canManage, onError, onSaved }) {
  const progressReady = useProgressSchemaReady()
  const { data: allPhases, refetch: refetchPhases } = useSitePhases()
  const phases = useMemo(() => (allPhases || []).filter((p) => p.site_id === siteId && !p.is_issue_phase), [allPhases, siteId])
  const boqIds = useMemo(() => boq.map((b) => b.id), [boq])
  const splits = useBoqPhaseSplits(boqIds, progressReady)

  const [defaults, setDefaults] = useState(null) // [{ phase_id, pct }] | null (not loaded / unavailable)
  const [defaultsFailed, setDefaultsFailed] = useState(false)
  const phasesKey = phases.map((p) => p.id).join(',')
  useEffect(() => {
    if (!progressReady || !phasesKey) { setDefaults(null); return undefined }
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.rpc('boq_phase_split_defaults', { p_site: siteId })
        if (cancelled) return
        if (error || !Array.isArray(data)) { setDefaults(null); setDefaultsFailed(true) } else { setDefaults(data); setDefaultsFailed(false) }
      } catch { if (!cancelled) { setDefaults(null); setDefaultsFailed(true) } }
    })()
    return () => { cancelled = true }
  }, [siteId, phasesKey, progressReady])

  // the matrix: saved rows when the site has any, else the template defaults
  const [cells, setCells] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState(null)
  const storedKey = `${boqIds.join(',')}|${phasesKey}|${splits.rows.map((r) => `${r.boq_item_id}:${r.phase_id}:${r.pct}`).join(',')}|${(defaults || []).map((d) => `${d.phase_id}:${d.pct}`).join(',')}`
  useEffect(() => {
    if (splits.loading || !boq.length || !phases.length) return
    if (splits.rows.length) setCells(cellsFromRows(boq, phases, splits.rows))
    else if (defaults) setCells(buildDefaultCells(boq, phases, defaults))
    else return
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey, splits.loading])

  const defaultByPhase = useMemo(() => Object.fromEntries((defaults || []).map((d) => [d.phase_id, cellNum(d.pct)])), [defaults])
  const shares = useMemo(() => itemShares(boq, sharesPct), [boq, sharesPct])
  const weights = useMemo(() => (cells ? computePhaseWeights({ phases, shares, cells }) : null), [cells, phases, shares])

  if (!progressReady || splits.unavailable || !boq.length || !phases.length || !cells) return null

  const allOk = boq.every((b) => rowOk(cells[b.id]))
  const setCell = (itemId, phaseId, v) => {
    setCells((c) => ({ ...c, [itemId]: { ...c[itemId], [phaseId]: v } }))
    setDirty(true); setNote(null)
  }

  const save = async () => {
    if (!canManage || !allOk) return
    setSaving(true); onError?.(null); setNote(null)
    try {
      const { data, error } = await supabase.rpc('save_boq_phase_splits', { p_site: siteId, p_rows: cellsToRows(cells, boq, phases) })
      if (error) { onError?.(error.message); return }
      const w = Array.isArray(data?.phase_weights) ? data.phase_weights : []
      const nameOf = Object.fromEntries(phases.map((p) => [p.id, p.name]))
      setNote(`บันทึกแล้ว · น้ำหนักเฟส: ${w.map((x) => `${nameOf[x.phase_id] ?? '?'} ${fmtNum(x.weight)}%`).join(' · ')}`)
      setDirty(false)
      splits.reload()
      await refetchPhases?.()
      onSaved?.()
    } catch (e) {
      onError?.(e.message)
    } finally { setSaving(false) }
  }

  const th = { textAlign: 'left', padding: '6px 8px', fontSize: 12, color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }
  const thNum = { ...th, textAlign: 'right' }
  const td = { padding: '4px 8px', fontSize: 13, verticalAlign: 'middle', whiteSpace: 'nowrap' }
  const tdNum = { ...td, textAlign: 'right' }

  return (
    <div data-testid="boq-phase-split" style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>แบ่ง % ต่อเฟส</div>
        <span style={{ fontSize: 12, color: 'var(--text3)', flex: 1 }}>
          {splits.boqMode ? 'น้ำหนักเฟสใน Gantt คิดจากตารางนี้' : 'ยังไม่บันทึก: ค่าเริ่มต้นจากแม่แบบบริษัท · บันทึกแล้วน้ำหนักเฟสจะคิดจาก BOQ'}
          {' · '}{canManage ? 'แก้ได้เฉพาะ OWNER และ PM' : 'ดูอย่างเดียว'}
          {defaultsFailed ? ' · โหลดค่าแม่แบบไม่ได้' : ''}
        </span>
        {canManage && (
          <button type="button" className="btn btn-sm btn-primary" disabled={saving || !allOk || !dirty} onClick={save}
            title={!allOk ? 'ทุกแถวต้องรวมได้ 100' : undefined}>
            {saving ? '⏳ กำลังบันทึก...' : 'บันทึก'}
          </button>
        )}
      </div>
      {note && <div style={{ fontSize: 12, color: 'var(--green)', marginBottom: 8 }}>{note}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>รหัส</th><th style={th}>รายการ</th><th style={thNum}>จำนวน</th><th style={thNum}>แต้มรายการ</th>
              {phases.map((p) => (
                <th key={p.id} style={{ ...thNum, color: p.is_vo ? 'var(--text3)' : 'var(--accent)' }} data-phase-col={p.id}>
                  {p.name}{p.is_vo ? ' (VO)' : ''}
                </th>
              ))}
              <th style={thNum}>รวม</th>
            </tr>
          </thead>
          <tbody>
            {boq.map((b) => {
              const row = cells[b.id] || {}
              const total = rowTotal(row)
              const ok = rowOk(row)
              const custom = phases.some((p) => cellIsCustom(row[p.id], defaultByPhase[p.id]))
              return (
                <tr key={b.id} data-testid={`split-row-${b.id}`} data-custom={String(custom)} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{b.code}</td>
                  <td style={{ ...td, whiteSpace: 'normal' }}>
                    {b.description}
                    {custom && <span data-tag="custom" style={{ fontSize: 10.5, color: '#8a5a12', background: '#fff7e6', border: '1px solid #e8c98a', borderRadius: 10, padding: '0 6px', marginLeft: 4 }}>แก้เอง</span>}
                  </td>
                  <td style={tdNum}>{fmtNum(b.planned_qty)}{b.unit ? ` ${b.unit}` : ''}</td>
                  <td style={tdNum} data-col="pts">{sharesPct && sharesPct[b.id] != null ? fmtNum(sharesPct[b.id]) : '—'}</td>
                  {phases.map((p) => {
                    const v = row[p.id]
                    const isCustom = cellIsCustom(v, defaultByPhase[p.id])
                    const zero = cellNum(v) === 0
                    return (
                      <td key={p.id} style={tdNum}>
                        <input type="number" min="0" max="100" step="any" className="input" aria-label={`${b.description} ${p.name} %`}
                          value={v ?? ''} readOnly={!canManage} disabled={!canManage && false}
                          data-custom={String(isCustom)}
                          onChange={(e) => setCell(b.id, p.id, e.target.value)}
                          style={{
                            width: 60, padding: '3px 6px', fontSize: 12.5, textAlign: 'right',
                            color: zero && !isCustom ? 'var(--text3)' : p.is_vo ? 'var(--text3)' : undefined,
                            background: isCustom ? '#fff7e6' : p.is_vo ? 'var(--bg2)' : undefined,
                            borderColor: isCustom ? '#b7791f' : undefined, fontWeight: isCustom ? 700 : 400,
                            opacity: p.is_vo ? 0.75 : 1,
                          }} />
                      </td>
                    )
                  })}
                  <td style={{ ...tdNum, fontWeight: 700, color: ok ? 'var(--green)' : 'var(--red)' }} data-col="row-total">{fmtNum(total)} {ok ? '✓' : '✗'}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }} data-testid="split-footer">
              <td style={td} />
              <td style={{ ...td, fontWeight: 700 }} colSpan={2}>น้ำหนักเฟส (คิดจาก BOQ อัตโนมัติ → Gantt)</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>100</td>
              {phases.map((p) => (
                <td key={p.id} style={{ ...tdNum, fontWeight: weights?.[p.id] > 0 ? 800 : 400, color: weights?.[p.id] > 0 ? 'var(--accent)' : 'var(--text3)' }} data-weight={p.id}>
                  {fmtNum(weights?.[p.id] ?? 0)}
                </td>
              ))}
              <td style={td} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
        ทุกรายการแยกแถว ไม่รวบ · ทุกเฟสแก้ได้ · ช่องที่ต่างจากแม่แบบมีพื้นเหลืองและป้าย "แก้เอง" · แต่ละแถวรวมต้องได้ 100 · % ที่ใส่เฟส VO ไม่นับในน้ำหนักตามสัญญา
      </div>
    </div>
  )
}
