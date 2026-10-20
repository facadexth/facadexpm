// ============================================================
// Kanban › "+ การ์ดจาก BOQ (n)": one dialog per phase listing every BOQ item with
// pct > 0 in that phase (boqPhaseCards.js boqCardCandidates). Every open row is
// pre-ticked at the quantity still left in the phase; rows already at their full
// quantity are greyed out. One button inserts all picked cards as BOQ cards
// (progress_mode 'quantity', not_started) in the same shape as the card form,
// and audits each insert like the form audits a kind/qty change.
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { auditLog } from '../../lib/audit.js'
import { fmtNum } from './progressCalc.js'
import { bulkCardRows } from './boqPhaseCards.js'

export default function BoqBulkCardsDialog({ siteId, phase, rows, nextSortOrder, onClose, onCreated }) {
  const [picked, setPicked] = useState(() => new Set(rows.filter((r) => !r.full).map((r) => r.item.id)))
  const [qty, setQty] = useState(() => Object.fromEntries(rows.map((r) => [r.item.id, r.remaining])))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const picks = rows.filter((r) => !r.full && picked.has(r.item.id)).map((r) => ({ item: r.item, qty: qty[r.item.id] }))
  const inserts = bulkCardRows({ siteId, phaseId: phase.id, nextSortOrder, picks })
  const overLimit = picks.some((p) => Number(p.qty) > rows.find((r) => r.item.id === p.item.id).remaining)
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const create = async () => {
    if (!inserts.length || overLimit) return
    setSaving(true); setError(null)
    try {
      const { data, error: err } = await supabase.from('phase_tasks').insert(inserts).select('id, boq_item_id, planned_qty')
      if (err) throw err
      for (const t of data || []) {
        await auditLog('phase_tasks', t.id, 'insert', null, { progress_mode: 'quantity', boq_item_id: t.boq_item_id, planned_qty: Number(t.planned_qty), phase_id: phase.id })
      }
      await onCreated?.()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally { setSaving(false) }
  }

  return (
    <Modal title={`สร้างการ์ด BOQ ในเฟส ${phase.name}`} onClose={() => { if (!saving) onClose() }} maxWidth={640}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>เลือกไว้ให้ทุกรายการแล้ว จำนวน = ที่เหลือในเฟสนี้ · เอาติ๊กออกถ้ายังไม่ทำ · ชื่อการ์ด = ชื่อรายการ BOQ</div>
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
        {overLimit && <div style={{ fontSize: 12, color: 'var(--red)' }}>จำนวนเกินที่เหลือในเฟสนี้</div>}
        {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving || !inserts.length || overLimit} onClick={create}>
          {saving ? '⏳ กำลังสร้าง...' : `สร้าง ${inserts.length} การ์ด`}
        </button>
      </div>
    </Modal>
  )
}
