// src/pages/estimation/OffcutStockPanel.jsx
// "เศษในสต็อก (หน้าตัดที่โครงการนี้ใช้)" in two tabs (offcutHelpers.offcutTabs):
//   เศษจากงานอื่น -- other jobs' offcuts of this project's profile+finish groups (in stock, or already taken by this
//     project's issued plan), with what the shown cut plan does with each (cut n pieces from it, or left in stock);
//   เศษที่ใบตัดนี้สร้าง -- the offcuts this project's issued plan stocked, with where each one is now.
// A sticker QR (#tab=estimation&offcut=<code>) lands here with that row highlighted, in its tab. "ทิ้ง" (in-stock rows
// only) is confirmed inline.
import { useEffect, useRef, useState } from 'react'
import { fmtDate } from '../../lib/supabase.js'
import { discardOffcut } from '../../hooks/useEstimation2b.js'
import { offcutTabs, offcutConsumer } from './offcutHelpers.js'
import InlineError from './InlineError.jsx'

const mm = m => String(Math.round(Number(m) * 1000))
const muted = { fontSize: 12, color: 'var(--text3)' }
const groupKeyOf = o => `${o.profile_id}|${o.finish_id || ''}`
const groupLabel = g => (g ? [[g.die_no, g.name].filter(Boolean).join(' '), g.finish_name].filter(Boolean).join(' · ') : '?')
const hlStyle = { background: 'rgba(255,209,102,0.18)', outline: '2px solid var(--yellow)', outlineOffset: -2 }

// offcuts: every alu_offcuts row (all statuses); groupInfo: cutGroupInfo of this project; plan: the plan shown on the
// cut sheet (the issued snapshot once issued); used: false when "ใช้เศษในสต็อกก่อน" is off; issuedPlanId: this
// project's issued plan (null before issue); plans: every alu_cut_plans row (who used an offcut).
export default function OffcutStockPanel({ offcuts, groupInfo, plan, used, settings, projectNames, canEdit, highlightCode, onDiscarded, issuedPlanId = null, plans = [] }) {
  const tabs = offcutTabs({ offcuts, groupInfo, issuedPlanId })
  const inMade = !!highlightCode && tabs.made.some(o => o.code === highlightCode)
  const [tab, setTab] = useState(inMade ? 'made' : 'use')
  const [confirmId, setConfirmId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const rowRefs = useRef({})
  const scrolledFor = useRef(null)
  // The QR's offcut may arrive after the first render: open the tab it is in once it does.
  useEffect(() => { if (inMade) setTab('made') }, [inMade])

  const rows = tab === 'made' ? tabs.made : tabs.use
  const groupOf = o => groupInfo[groupKeyOf(o)] || (plan ? plan.groups.find(g => g.key === groupKeyOf(o)) : null)
  const barOf = o => {
    const g = plan ? plan.groups.find(x => x.key === groupKeyOf(o)) : null
    return g ? g.offcutBars.find(b => b.offcut.id === o.id) || null : null
  }
  const minKeep = Number(settings.min_keep_offcut_m)
  const highlighted = highlightCode ? rows.find(o => o.code === highlightCode) : null
  const known = !!highlightCode && (inMade || tabs.use.some(o => o.code === highlightCode))

  useEffect(() => {
    if (!highlighted || scrolledFor.current === highlighted.code) return
    const el = rowRefs.current[highlighted.code]
    if (el && el.scrollIntoView) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); scrolledFor.current = highlighted.code }
  }, [highlighted])

  const discard = async o => {
    setBusy(true); setError(null)
    try { await discardOffcut(o.id); setConfirmId(null) } catch (e) { setError(`ทิ้ง ${o.code} ไม่สำเร็จ: ${e.message || e}`) } finally {
      try { await onDiscarded() } catch (e) { setError(prev => prev || `โหลดเศษในสต็อกใหม่ไม่สำเร็จ: ${e.message || e}`) } finally { setBusy(false) }
    }
  }

  const result = o => {
    if (!used) return <span style={muted}>ไม่ใช้</span>
    const b = barOf(o)
    if (!b) return <span style={muted}>ไม่มีท่อนที่ลงได้ — ยังอยู่ในสต็อก</span>
    return (
      <>
        <span className="badge badge-ongoing">ใช้ตัด {b.pieces.length} ท่อน</span>{' '}
        <span className="font-mono">{b.pieces.map(p => `${p.opening_no} ${mm(p.length_m)}`).join(', ')}</span>
        {Number(b.left_m) + 1e-9 >= minKeep ? ` · เหลือ ${mm(b.left_m)}` : ''}
      </>
    )
  }

  const status = o => {
    if (o.status === 'in_stock') return <span className="badge">ในสต็อก</span>
    if (o.status === 'discarded') return <span className="badge" style={{ color: 'var(--text3)' }}>ทิ้ง</span>
    const c = offcutConsumer(o, plans, projectNames)
    const who = c ? [c.projectName || 'งานอื่น', c.openings.join(', ')].filter(Boolean).join(' ') : ''
    return <span className="badge badge-ongoing">{`ใช้แล้ว${who ? ` · ${who}` : ''}`}</span>
  }

  const isMade = tab === 'made'
  const cols = (isMade ? 4 : 6) + (canEdit ? 1 : 0)
  const empty = isMade
    ? (issuedPlanId ? 'ใบตัดนี้ไม่ได้สร้างเศษที่เก็บเข้าสต็อก' : 'ยืนยันใบตัดก่อน จึงจะมีเศษที่ใบตัดนี้สร้าง')
    : 'ไม่มีเศษในสต็อกของหน้าตัดที่โครงการนี้ใช้'
  const switchTab = k => { setTab(k); setConfirmId(null) }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700 }}>เศษในสต็อก (หน้าตัดที่โครงการนี้ใช้)</div>
        <span style={muted}>เศษที่ติดสติกเกอร์ไว้จากงานก่อน · {used ? 'จัดลงก่อนตัดเส้นใหม่' : 'ไม่ใช้ (ปิดอยู่)'}</span>
      </div>
      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['use', `เศษจากงานอื่น (${tabs.use.length})`], ['made', `เศษที่ใบตัดนี้สร้าง (${tabs.made.length})`]].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchTab(k)}>{label}</button>
        ))}
      </div>
      {highlightCode && !known && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>เศษ {highlightCode} ไม่อยู่ในหน้าตัดของโครงการนี้</div>}
      {error && <InlineError onClose={() => setError(null)}>{error}</InlineError>}
      {rows.length === 0 ? <div style={muted}>{empty}</div> : (
        <div className="table-wrap"><table>
          <thead><tr>
            <th>รหัสเศษ</th><th>หน้าตัด</th><th>ยาว (มม.)</th>
            {isMade ? <th>สถานะ</th> : <><th>มาจาก</th><th>วันที่</th><th>ผล</th></>}
            {canEdit && <th />}
          </tr></thead>
          <tbody>{rows.map(o => {
            const hl = highlighted && highlighted.id === o.id
            return [
              <tr key={o.id} ref={el => { rowRefs.current[o.code] = el }} style={hl ? hlStyle : undefined}>
                <td className="font-mono">{o.code}</td>
                <td>{groupLabel(groupOf(o))}</td>
                <td className="font-mono">{mm(o.length_m)}</td>
                {isMade ? <td>{status(o)}</td> : <>
                  <td>{(o.source_project_id && projectNames[o.source_project_id]) || '—'}</td>
                  <td>{fmtDate(o.created_at)}</td>
                  <td style={{ fontSize: 13 }}>{result(o)}</td>
                </>}
                {canEdit && <td>{o.status === 'in_stock' && confirmId !== o.id && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setConfirmId(o.id); setError(null) }}>ทิ้ง</button>}</td>}
              </tr>,
              canEdit && confirmId === o.id && (
                <tr key={`${o.id}-confirm`}><td colSpan={cols}>
                  <div className="alert alert-warning" style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: 0 }}>
                    <span>ทิ้งเศษ <b className="font-mono">{o.code}</b> ({mm(o.length_m)} มม.)? จะนำออกจากสต็อก ใช้ตัดงานต่อไม่ได้อีก</span>
                    <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => discard(o)}>{busy ? 'กำลังบันทึก...' : 'ทิ้งเศษ'}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmId(null)}>ไม่ใช่</button>
                  </div>
                </td></tr>
              ),
            ]
          })}</tbody>
        </table></div>
      )}
    </div>
  )
}
