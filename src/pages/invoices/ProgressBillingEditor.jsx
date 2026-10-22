// "ตามความคืบหน้า" invoice mode: each quotation line with a BOQ row bills
// qty (from the Kanban cards) x unit price x Σ weight of the chosen phases.
// Spec docs/superpowers/specs/2026-10-22-delivery-report-design.md.
import { useState } from 'react'
import { fmt } from '../../lib/supabase.js'
import { round2 } from '../../lib/depositCalc.js'
import { openQty } from '../../lib/invoiceCalc.js'
import { phaseWeight, deliveredBefore, doneQty, progressLineAmount, checkLine, legacyDeliveredQty } from '../../lib/progressBilling.js'

const REASON_TEXT = {
  fraction_count_unit: 'ต้องเป็นจำนวนเต็ม',
  card_no_qty: 'การ์ดยังไม่มีจำนวน',
  price_mismatch: 'ราคาต่อหน่วยไม่ตรงกับ BOQ',
  qty_not_card: 'จำนวนน้อยกว่าที่การ์ดแสดง',
  no_weight: 'ยังไม่ได้ตั้ง weight',
  weight_over_100: 'weight รวมเกิน 100%',
}

const sortPhaseIds = (ids, phases) => {
  const order = new Map((phases || []).map((p, i) => [p.id, i]))
  return [...new Set(ids)].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
}

// Builds the invoice rows for progress mode.
// value = { phaseIds, rows: { [qiId]: { phaseIds, qty } } }; a row without its own phaseIds uses
// the header phaseIds. qty defaults to (card done qty - delivered before) of the chosen phases,
// smallest across them, never below 0; a typed qty can lower it but never raise it.
// line price = l.unitPrice (quotation unit_price x discount multiplier); the amount is capped at
// the item's remaining value (openQty x price) so a mixed easy/progress quotation never goes negative.
export function buildProgressInvoiceRows(lines, data, value, priceMultiplier) {
  const items = []
  const status = {}
  let blocked = false
  if (!data) return { items, blocked, status }
  const phases = data.phases || []
  const phaseName = id => phases.find(p => p.id === id)?.name || '?'

  for (const l of lines || []) {
    const boq = data.boqByQuotationItem?.[l.quotationItemId]
    if (!boq) continue
    const remainingValue = round2(openQty(l.units) * l.unitPrice)
    if (remainingValue <= 0) continue
    const splits = data.splitsByBoq?.[boq.id] || []
    const row = value?.rows?.[l.quotationItemId]
    const phaseIds = sortPhaseIds(row?.phaseIds ?? value?.phaseIds ?? [], phases)
    const unit = boq.unit ?? l.unit
    const st = { boq, unit, phaseIds, weight: 0, available: 0, qty: 0, blockedCard: null, check: null, lineTotal: 0 }
    status[l.quotationItemId] = st
    if (!phaseIds.length) continue

    const rawWeight = phaseWeight(splits, phaseIds)
    const weight = Math.min(100, rawWeight)
    st.weight = weight
    // earlier easy/advanced billing counts as delivered, phases used up in sort order
    const totalQty = (l.units || []).reduce((s, u) => s + (Number(u.unitQty) || 0), 0)
    // quotation_item_units also carries value billed by earlier progress invoices; that part is
    // already in phaseDraws, so only the rest counts as easy/advanced ("legacy") billing.
    const progressValue = (data.phaseDraws || [])
      .filter(d => d.boq_item_id === boq.id && d.invoice_status !== 'void')
      .reduce((s, d) => s + (Number(d.amount) || 0), 0)
    const totalValue = totalQty * l.unitPrice
    const billedFraction = totalQty > 0 && totalValue > 0
      ? Math.max(0, 1 - openQty(l.units) / totalQty - progressValue / totalValue) : 0
    const phaseOrder = sortPhaseIds(splits.map(s => s.phase_id), phases)
      .map(pid => ({ phase_id: pid, pct: Number(splits.find(s => s.phase_id === pid)?.pct) || 0 }))
    let available = null
    let doneMin = null
    for (const pid of phaseIds) {
      const done = doneQty(data.cards, boq.id, pid)
      if (done == null) {
        const card = (data.cards || []).find(c => c.boq_item_id === boq.id && c.phase_id === pid
          && (c.progress_mode !== 'quantity' || c.planned_qty == null))
        st.blockedCard = st.blockedCard || card?.name || phaseName(pid)
        continue
      }
      const legacy = legacyDeliveredQty({ billedFraction, phaseOrder, phaseId: pid, boqQty: boq.planned_qty })
      const free = Math.max(0, done - deliveredBefore(data.phaseDraws, boq.id, pid) - legacy)
      available = available == null ? free : Math.min(available, free)
      doneMin = doneMin == null ? done : Math.min(doneMin, done)
    }
    if (st.blockedCard) {
      blocked = true
      st.check = { level: 'block', reasons: ['card_no_qty'] }
      continue
    }
    available = round2(available ?? 0)
    st.available = available
    const typed = row?.qty
    const qty = typed != null && !isNaN(typed) ? Math.max(0, Math.min(available, Number(typed))) : available
    st.qty = qty

    st.check = checkLine({
      unit, qty, unitPrice: l.unitPrice, boqQty: boq.planned_qty,
      boqUnitPrice: l.baseUnitPrice ?? null, priceMultiplier,
      billedPct: weight, phaseWeightPct: weight, cardDoneQty: available,
    })
    if (rawWeight > 100) {
      st.check = { level: st.check.level === 'block' ? 'block' : 'warn', reasons: [...st.check.reasons, 'weight_over_100'] }
    }
    if (st.check.level === 'block') blocked = true
    if (weight <= 0 || qty <= 0) continue

    const raw = progressLineAmount({ qty, unitPrice: l.unitPrice, weightPct: weight })
    const lineTotal = Math.min(raw, remainingValue)
    st.lineTotal = lineTotal
    // when the remaining-value cap cuts the amount, scale qty, prices and phases by the same ratio
    const ratio = raw > 0 && lineTotal < raw ? lineTotal / raw : 1
    const drawQty = ratio < 1 ? round2(qty * ratio) : qty
    const basePrice = round2(l.unitPrice * weight / 100)
    let unitPrice = basePrice
    if (round2(unitPrice * drawQty) !== lineTotal && drawQty > 0) unitPrice = round2(lineTotal / drawQty)
    // material/labor follow the unit price (qty already carries the cap ratio)
    const priceRatio = basePrice > 0 ? unitPrice / basePrice : 1
    // weights above 100 are capped: shrink each phase's pct proportionally
    const wScale = rawWeight > 0 ? weight / rawWeight : 0
    const pctOf = pid => Number(splits.find(s => s.phase_id === pid)?.pct) || 0
    const scale = (m) => (m != null ? round2(m * weight / 100 * priceRatio) : null)
    const phaseIdsPaid = phaseIds.filter(pid => pctOf(pid) > 0)
    // amounts last; the satang remainder goes on the last phase so Σ === lineTotal
    let acc = 0
    const phaseRows = phaseIdsPaid.map((pid, i) => {
      const amount = i === phaseIdsPaid.length - 1 ? round2(lineTotal - acc)
        : round2(progressLineAmount({ qty, unitPrice: l.unitPrice, weightPct: pctOf(pid) * wScale }) * ratio)
      acc = round2(acc + amount)
      return { boq_item_id: boq.id, phase_id: pid, qty: drawQty, weight_pct: pctOf(pid), amount }
    })
    items.push({
      quotationItemId: l.quotationItemId,
      description: `${l.description} (${phaseIds.map(phaseName).join(' + ')} ${weight}%)`,
      unit,
      unitPrice,
      unitPriceMaterial: scale(l.unitPriceMaterial),
      unitPriceLabor: scale(l.unitPriceLabor),
      drawQty,
      lineTotal,
      phases: phaseRows,
    })
  }
  return { items, blocked, status }
}

const chipStyle = on => ({
  padding: '2px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
  background: on ? 'var(--accent)' : 'transparent', color: on ? '#fff' : 'inherit',
})

export default function ProgressBillingEditor({ lines, data, priceMultiplier, value, onChange }) {
  const [hint, setHint] = useState(null)
  const phases = data?.phases || []
  const res = buildProgressInvoiceRows(lines, data, value, priceMultiplier)
  const boqLines = (lines || []).filter(l => res.status[l.quotationItemId])

  const toggle = (ids, pid) => sortPhaseIds(ids.includes(pid) ? ids.filter(x => x !== pid) : [...ids, pid], phases)
  const setHeader = pid => {
    const next = toggle(value.phaseIds || [], pid)
    const rows = {}
    for (const l of boqLines) rows[l.quotationItemId] = { phaseIds: next }
    onChange({ phaseIds: next, rows })
  }
  const setRow = (qi, patch) => {
    const cur = value.rows?.[qi] || { phaseIds: value.phaseIds || [] }
    onChange({ ...value, rows: { ...(value.rows || {}), [qi]: { ...cur, ...patch } } })
  }

  if (!boqLines.length) {
    return <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่มีรายการที่มี BOQ ให้เรียกเก็บตามความคืบหน้า</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>ส่งมอบงวดนี้:</span>
        {phases.map(p => (
          <button key={p.id} type="button" aria-label={`ทุกรายการ: ${p.name}`}
            style={chipStyle((value.phaseIds || []).includes(p.id))} onClick={() => setHeader(p.id)}>{p.name}</button>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {boqLines.map((l, no) => {
          const st = res.status[l.quotationItemId]
          const lvl = st.check?.level
          return (
            <div key={l.quotationItemId} data-line={l.quotationItemId} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 90px 100px 20px', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{no + 1}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{l.description}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {fmt(l.unitPrice)} บาท/{st.unit || '-'} · weight {st.weight}% · ส่งได้ {fmt(st.available)} {st.unit || ''}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {phases.map(p => (
                      <button key={p.id} type="button" aria-label={`${l.description}: ${p.name}`}
                        style={chipStyle(st.phaseIds.includes(p.id))}
                        onClick={() => setRow(l.quotationItemId, { phaseIds: toggle(st.phaseIds, p.id) })}>{p.name}</button>
                    ))}
                  </div>
                </div>
                <input type="number" min="0" max={st.available} step="any" className="input input-sm num-spin"
                  style={{ textAlign: 'right' }} disabled={!st.phaseIds.length || !!st.blockedCard}
                  value={String(st.qty)}
                  onChange={e => {
                    const v = parseFloat(e.target.value)
                    setRow(l.quotationItemId, { qty: isNaN(v) ? 0 : v })
                  }} />
                <span className="font-mono" style={{ fontWeight: 700, textAlign: 'right' }}>{fmt(st.lineTotal)}</span>
                {st.check ? (
                  <span style={{ textAlign: 'center' }}
                    title={st.check.reasons.length ? st.check.reasons.map(r => REASON_TEXT[r] || r).join(' · ') : 'ตรงกับ BOQ และการ์ด'}>
                    {lvl === 'block' ? '⛔' : lvl === 'warn' ? '⚠️' : '✅'}
                  </span>
                ) : <span />}
              </div>
              {st.blockedCard && (
                <div style={{ marginLeft: 36, marginTop: 4, fontSize: 12, color: 'var(--danger, #c0392b)' }}>
                  การ์ด {st.blockedCard} ยังไม่มีจำนวน{' '}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHint(l.quotationItemId)}>กรอกในการ์ด →</button>
                  {hint === l.quotationItemId && <div>{`ไปกรอกจำนวนในการ์ด ${st.blockedCard} ที่หน้าไซท์ → Kanban`}</div>}
                </div>
              )}
              {!st.blockedCard && st.check?.reasons.includes('fraction_count_unit') && (
                <div style={{ marginLeft: 36, marginTop: 4, fontSize: 12, color: 'var(--danger, #c0392b)' }}>
                  {`ต้องเป็นจำนวนเต็ม (หน่วย ${st.unit})`}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
