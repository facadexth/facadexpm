// ============================================================
// Kanban › "+ การ์ดจาก BOQ (n)": one dialog per phase listing every BOQ item with
// pct > 0 in that phase (boqPhaseCards.js boqCardCandidates). Every open row is
// pre-ticked at the quantity still left in the phase; rows already at their full
// quantity are greyed out. One button inserts all picked cards as BOQ cards
// (progress_mode 'quantity', not_started) in the same shape as the card form,
// and audits each insert like the form audits a kind/qty change.
// "แยกตามชั้น": qty per floor per item (sum = qty left in the phase) -> one card per
// item x floor, zone = floor label; a floor that already has a card of the item is skipped.
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { auditLog } from '../../lib/audit.js'
import { fmtNum } from './progressCalc.js'
import { bulkCardRows, floorCardRows, floorRowSum, splitEvenly, DEFAULT_FLOORS } from './boqPhaseCards.js'
import { isCountUnit } from '../../lib/progressBilling.js'

/**
 * Insert BOQ cards in one batch and audit each insert (kind + line + qty + phase), the
 * same way the card form audits a kind/qty change. Returns the created rows
 * ({ id, boq_item_id, planned_qty }). Shared with the card form's multi-item add.
 */
export async function insertBoqCards(inserts, phaseId) {
  const { data, error } = await supabase.from('phase_tasks').insert(inserts).select('id, boq_item_id, planned_qty')
  if (error) throw error
  for (const t of data || []) {
    await auditLog('phase_tasks', t.id, 'insert', null, { progress_mode: 'quantity', boq_item_id: t.boq_item_id, planned_qty: Number(t.planned_qty), phase_id: phaseId })
  }
  return data || []
}

export default function BoqBulkCardsDialog({ siteId, phase, rows, nextSortOrder, onClose, onCreated }) {
  const [picked, setPicked] = useState(() => new Set(rows.filter((r) => !r.full).map((r) => r.item.id)))
  const [qty, setQty] = useState(() => Object.fromEntries(rows.map((r) => [r.item.id, r.remaining])))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [byFloor, setByFloor] = useState(false)
  const [floors, setFloors] = useState(DEFAULT_FLOORS)
  const [newFloor, setNewFloor] = useState('')
  const [perFloor, setPerFloor] = useState({}) // itemId -> { floor: qty }

  const picks = rows.filter((r) => !r.full && picked.has(r.item.id)).map((r) => ({ item: r.item, qty: qty[r.item.id] }))
  const floorRows = rows.filter((r) => !r.full && picked.has(r.item.id))
    .map((r) => ({ item: r.item, target: r.remaining, perFloor: perFloor[r.item.id] || {}, skipZones: r.zones || [] }))
  const floorResult = floorCardRows({ siteId, phaseId: phase.id, nextSortOrder, floors, rows: floorRows })
  const inserts = byFloor ? floorResult.inserts : bulkCardRows({ siteId, phaseId: phase.id, nextSortOrder, picks })
  const overLimit = !byFloor && picks.some((p) => Number(p.qty) > rows.find((r) => r.item.id === p.item.id).remaining)
  const sumBad = byFloor && floorResult.errors.length > 0
  const openFloors = (r) => floors.filter((f) => !(r.zones || []).includes(f))
  const setCell = (id, f, v) => setPerFloor((m) => ({ ...m, [id]: { ...(m[id] || {}), [f]: v } }))
  const fillEven = () => setPerFloor((m) => {
    const next = { ...m }
    for (const r of rows.filter((x) => !x.full && picked.has(x.item.id))) {
      const fs = openFloors(r)
      const parts = splitEvenly(r.remaining, fs.length, isCountUnit(r.item.unit))
      next[r.item.id] = Object.fromEntries(fs.map((f, i) => [f, parts[i]]))
    }
    return next
  })
  const addFloor = () => {
    const f = newFloor.trim()
    if (f && !floors.includes(f)) setFloors((x) => [...x, f])
    setNewFloor('')
  }
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const create = async () => {
    if (!inserts.length || overLimit || sumBad) return
    setSaving(true); setError(null)
    try {
      await insertBoqCards(inserts, phase.id)
      await onCreated?.()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally { setSaving(false) }
  }

  return (
    <Modal title={`สร้างการ์ด BOQ ในเฟส ${phase.name}`} onClose={() => { if (!saving) onClose() }} maxWidth={byFloor ? 900 : 640}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>เลือกไว้ให้ทุกรายการแล้ว จำนวน = ที่เหลือในเฟสนี้ · เอาติ๊กออกถ้ายังไม่ทำ · ชื่อการ์ด = ชื่อรายการ BOQ</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
          <input type="checkbox" checked={byFloor} disabled={saving} onChange={(e) => setByFloor(e.target.checked)} aria-label="แยกตามชั้น" />
          แยกตามชั้น <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>· ได้การ์ด 1 ใบต่อ รายการ × ชั้น</span>
        </label>
        {byFloor ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
              ชั้น:
              {floors.map((f) => (
                <span key={f} data-testid={`floor-chip-${f}`} style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>
                  {f}
                  <button type="button" aria-label={`ลบชั้น ${f}`} disabled={saving || floors.length <= 1}
                    onClick={() => setFloors((x) => x.filter((y) => y !== f))}
                    style={{ marginLeft: 4, border: 0, background: 'none', cursor: 'pointer', color: 'var(--text3)' }}>×</button>
                </span>
              ))}
              <input className="input input-sm" style={{ width: 90 }} placeholder="เพิ่มชั้น" aria-label="เพิ่มชั้น" value={newFloor}
                onChange={(e) => setNewFloor(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFloor() } }} />
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving || !newFloor.trim()} onClick={addFloor}>+ เพิ่ม</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={fillEven}>แบ่งเท่าๆ กัน</button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
                <thead>
                  <tr>
                    <th />
                    <th style={{ textAlign: 'left' }}>รายการ</th>
                    {floors.map((f) => <th key={f} style={{ padding: '0 3px' }}>{f}</th>)}
                    <th style={{ textAlign: 'right' }}>รวม</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const on = !r.full && picked.has(r.item.id)
                    const sum = floorRowSum(perFloor[r.item.id], floors)
                    const bad = on && Math.abs(sum - r.remaining) > 0.0001
                    return (
                      <tr key={r.item.id} data-testid={`floor-row-${r.item.id}`} style={{ color: r.full ? 'var(--text3)' : 'var(--text)' }}>
                        <td><input type="checkbox" checked={on} disabled={r.full || saving} onChange={() => toggle(r.item.id)} aria-label={r.item.description} /></td>
                        <td style={{ minWidth: 120 }}>{r.item.code} {r.item.description}{r.full ? ' · มีการ์ดครบแล้ว' : ''}</td>
                        {floors.map((f) => {
                          const has = (r.zones || []).includes(f)
                          return (
                            <td key={f} style={{ padding: '2px 3px' }}>
                              <input type="number" min="0" step="any" className="input input-sm" style={{ width: 56, textAlign: 'right' }}
                                aria-label={`จำนวน ${r.item.description} ${f}`} title={has ? 'มีการ์ดชั้นนี้แล้ว' : undefined}
                                placeholder={has ? 'มีแล้ว' : undefined}
                                value={has ? '' : (perFloor[r.item.id]?.[f] ?? '')} disabled={!on || has || saving}
                                onChange={(e) => setCell(r.item.id, f, e.target.value)} />
                            </td>
                          )
                        })}
                        <td data-testid={`floor-sum-${r.item.id}`} style={{ textAlign: 'right', whiteSpace: 'nowrap', color: bad ? 'var(--red)' : undefined, fontWeight: bad ? 700 : 400 }}>
                          {r.full ? '' : `${fmtNum(sum)} / ${fmtNum(r.remaining)}`}{r.item.unit ? ` ${r.item.unit}` : ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {sumBad && <div style={{ fontSize: 12, color: 'var(--red)' }}>ผลรวมทุกชั้นต้องเท่ากับจำนวนที่เหลือในเฟสนี้ ({floorResult.errors.length} รายการยังไม่ตรง)</div>}
          </>
        ) : (
        <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((r) => {
              const on = !r.full && picked.has(r.item.id)
              return (
                <label key={r.item.id} data-testid={`bulk-row-${r.item.id}`} data-full={String(r.full)}
                  style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 90px 60px', gap: 8, alignItems: 'center', fontSize: 13, color: r.full ? 'var(--text3)' : 'var(--text)' }}>
                  <input type="checkbox" checked={on} disabled={r.full || saving} onChange={() => toggle(r.item.id)} aria-label={r.item.description} />
                  <span>{r.item.code} {r.item.description}{r.full ? ' · มีการ์ดครบแล้ว' : ''}</span>
                  <input type="number" min="0" step="any" className="input input-sm" style={{ textAlign: 'right' }} aria-label={`จำนวน ${r.item.description}`}
                    value={r.full ? '' : (qty[r.item.id] ?? '')} disabled={r.full || !on || saving} placeholder={r.full ? '—' : undefined}
                    onChange={(e) => setQty((q) => ({ ...q, [r.item.id]: e.target.value }))} />
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>{r.full ? '' : `/ ${fmtNum(r.remaining)}`}{r.item.unit ? ` ${r.item.unit}` : ''}</span>
                </label>
              )
            })}
          </div>
        )}
        {overLimit && <div style={{ fontSize: 12, color: 'var(--red)' }}>จำนวนเกินที่เหลือในเฟสนี้</div>}
        {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving || !inserts.length || overLimit || sumBad} onClick={create}>
          {saving ? '⏳ กำลังสร้าง...' : `สร้าง ${inserts.length} การ์ด`}
        </button>
      </div>
    </Modal>
  )
}
