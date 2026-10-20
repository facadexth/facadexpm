// ============================================================
// BoqTab -- the site's BOQ (bill of quantities): contract quantities that
// status/quantity cards draw from. Columns: code, item, per contract,
// in cards (Σ planned_qty of linked cards; 0 = amber), done (Σ done_qty),
// สัดส่วนงาน (each line's share of the site's BOQ value, in %, from
// rpc('boq_value_shares'), called only once the schema probe is ready; the
// column is hidden before that and when the RPC fails). Never shows a price -- boq_items carries none and
// the RPC returns percentages only. Edits go straight to boq_items
// (site-staff RLS); DB messages (e.g. the "BOQ below what the cards hold"
// guard, or deleting a line that cards still use) are shown verbatim.
// Delete confirms inside the page.
// ============================================================
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useBoqItems, usePhaseTasks } from '../../hooks/useSupabase.js'
import { useUserRole } from '../../hooks/useUserRole.js'
import { canManagePlan } from '../../lib/roles.js'
import { fmtNum } from './progressCalc.js'
import { useProgressSchemaReady } from '../../lib/progressSchema.js'
import BoqPhaseSplitSection from './BoqPhaseSplitSection.jsx'

// onSave resolves to false when the save was rejected: the cell then goes back to the
// stored value (a refetch alone returns the same value, so it would not reset the text).
function EditCell({ value, onSave, type = 'text', width, align }) {
  const stored = String(value ?? '')
  const [v, setV] = useState(stored)
  useEffect(() => { setV(stored) }, [stored])
  const commit = async () => {
    if (v === stored) return
    if ((await onSave(v)) === false) setV(stored)
  }
  return (
    <input
      className="input"
      type={type}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      style={{ width, padding: '3px 6px', fontSize: 13, textAlign: align }}
    />
  )
}

export default function BoqTab({ siteId }) {
  const { data: boq, loading, error: loadError, refetch } = useBoqItems(siteId)
  const { data: allCards, refetch: refetchCards } = usePhaseTasks()
  const { role } = useUserRole()
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState(null)
  const [shares, setShares] = useState(null) // { boqItemId: share_pct } | null = not available

  // shares depend on every line's qty (and price, server side): reload when lines change
  const sharesKey = boq.map((b) => `${b.id}:${b.planned_qty}`).join(',')
  // the RPC exists only after the migration: ask only once the schema probe says so
  const progressReady = useProgressSchemaReady()
  useEffect(() => {
    if (!progressReady) { setShares(null); return undefined }
    let cancelled = false
    ;(async () => {
      let next = null
      try {
        const { data, error: err } = await supabase.rpc('boq_value_shares', { p_site_id: siteId })
        if (!err && Array.isArray(data)) next = Object.fromEntries(data.map((r) => [r.boq_item_id, Number(r.share_pct)]))
      } catch { /* fail soft: no column */ }
      if (!cancelled) setShares(next)
    })()
    return () => { cancelled = true }
  }, [siteId, sharesKey, progressReady])

  const sums = useMemo(() => {
    const m = {}
    for (const c of allCards || []) {
      if (c.site_id !== siteId || !c.boq_item_id) continue
      const s = (m[c.boq_item_id] ||= { inCards: 0, done: 0 })
      s.inCards += Number(c.planned_qty) || 0
      s.done += Number(c.done_qty) || 0
    }
    return m
  }, [allCards, siteId])

  const run = async (fn) => {
    setBusy(true); setError(null); setNote(null)
    try { return await fn() } finally { setBusy(false) }
  }

  // resolves to whether the row was saved (EditCell resets itself on false)
  const saveField = (row, patch) => run(async () => {
    const { error: err } = await supabase.from('boq_items').update(patch).eq('id', row.id)
    if (err) setError(err.message)
    await refetch()
    return !err
  })

  const saveQty = (row, text) => {
    const q = Number(text)
    if (!Number.isFinite(q) || q <= 0) { setError('จำนวนต้องมากกว่า 0'); return false }
    return saveField(row, { planned_qty: q })
  }

  const remove = (row) => run(async () => {
    const { error: err } = await supabase.from('boq_items').delete().eq('id', row.id)
    setConfirmId(null)
    if (err) setError(err.message)
    await refetch()
  })

  const addRow = () => run(async () => {
    const nums = boq.map((b) => (/^\d{1,9}$/.test(b.code) ? Number(b.code) : 0))
    const { error: err } = await supabase.from('boq_items').insert({
      site_id: siteId,
      code: String(Math.max(0, ...nums) + 1),
      description: 'รายการใหม่',
      unit: null,
      planned_qty: 1,
      sort_order: Math.max(0, ...boq.map((b) => b.sort_order || 0)) + 1,
    })
    if (err) setError(err.message)
    await refetch()
  })

  const refresh = () => run(async () => {
    const { data, error: err } = await supabase.rpc('boq_refresh_from_quotations', { p_site_id: siteId })
    if (err) { setError(err.message); return }
    setNote(`เพิ่ม ${data ?? 0} บรรทัดจากใบเสนอราคา`)
    await refetch()
  })

  const th = { textAlign: 'left', padding: '6px 8px', fontSize: 12, color: 'var(--text3)', fontWeight: 600 }
  const td = { padding: '4px 8px', fontSize: 13, verticalAlign: 'middle' }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, flex: 1 }}>BOQ</div>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={refresh}>ดึงจากใบเสนอราคาอีกครั้ง</button>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={addRow}>+ เพิ่มบรรทัด</button>
      </div>
      {note && <div style={{ fontSize: 12, color: 'var(--green)', marginBottom: 8 }}>{note}</div>}
      {(error || loadError) && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>
          {error || (loadError?.message ?? String(loadError))}
        </div>
      )}
      {loading ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
      ) : boq.length === 0 ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีรายการ BOQ — กด "ดึงจากใบเสนอราคาอีกครั้ง" หรือ "+ เพิ่มบรรทัด"</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>รหัส</th><th style={th}>รายการ</th><th style={th}>ตามสัญญา</th>
                <th style={th}>อยู่ในการ์ด</th><th style={th}>ติดแล้ว</th>
                {shares && <th style={th}>สัดส่วนงาน</th>}
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {boq.map((b) => {
                const s = sums[b.id] || { inCards: 0, done: 0 }
                const amber = s.inCards === 0
                return (
                  <tr key={b.id} data-testid={`boq-row-${b.id}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={td}><EditCell value={b.code} width={56} onSave={(v) => saveField(b, { code: v.trim() })} /></td>
                    <td style={td}><EditCell value={b.description} onSave={(v) => saveField(b, { description: v.trim() })} /></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <EditCell value={b.planned_qty} type="number" width={80} align="right" onSave={(v) => saveQty(b, v)} />
                      {' '}<EditCell value={b.unit} width={64} onSave={(v) => saveField(b, { unit: v.trim() || null })} />
                    </td>
                    <td
                      style={{ ...td, ...(amber ? { background: 'var(--amber-bg, #fff3cd)', color: 'var(--amber, #8a6100)', fontWeight: 600 } : null) }}
                      data-col="in_cards" data-amber={String(amber)}
                    >{fmtNum(s.inCards)}</td>
                    <td style={td} data-col="done">{fmtNum(s.done)}</td>
                    {shares && (
                      <td style={td} data-col="share">{shares[b.id] != null ? `${fmtNum(shares[b.id])}%` : '—'}</td>
                    )}
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {confirmId === b.id ? (
                        <>
                          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(b)}>ยืนยันลบ</button>{' '}
                          <button className="btn btn-sm btn-ghost" onClick={() => setConfirmId(null)}>ไม่ลบ</button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirmId(b.id)}>ลบ</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* "% ต่อเฟส" matrix: saving it puts the site in BOQ mode (phase weights derived by the DB);
          card points change too, so the cards are refetched after a save */}
      {!loading && boq.length > 0 && (
        <BoqPhaseSplitSection siteId={siteId} boq={boq} sharesPct={shares} canManage={canManagePlan(role)}
          onError={setError} onSaved={() => refetchCards?.()} />
      )}
    </div>
  )
}
