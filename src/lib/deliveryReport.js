// Delivery report (DR) maths. Pure functions only.
// Spec docs/superpowers/specs/2026-10-22-delivery-report-design.md, plan B task 2.
// The table is a contract view: every BOQ line x every phase in its splits (this = 0 when the
// invoice bills nothing there), plus one row per invoice item whose quotation item has no BOQ.
import { round2 } from './depositCalc.js'
import { doneQty, checkLine } from './progressBilling.js'

export const MARK_PREV = '#16a34a'
export const MARK_THIS = '#f97316'
export const MARK_REMAINING = '#9ca3af'

const num = v => Number(v) || 0

function sortedSplits(splits, phases) {
  const order = new Map((phases || []).map((p, i) => [p.id, i]))
  return [...(splits || [])].sort((a, b) => (order.get(a.phase_id) ?? 1e9) - (order.get(b.phase_id) ?? 1e9))
}

// Contract value per phase: qty x price x pct / 100, rounded; remainder on the last phase so the
// phase values add up to the rounded line value.
function phaseValues(qty, price, splits) {
  const vals = splits.map(s => round2(qty * price * num(s.pct) / 100))
  if (vals.length) {
    const totalPct = round2(splits.reduce((s, r) => s + num(r.pct), 0))
    const lineValue = round2(qty * price * totalPct / 100)
    const diff = round2(lineValue - vals.reduce((a, b) => a + b, 0))
    vals[vals.length - 1] = round2(vals[vals.length - 1] + diff)
  }
  return vals
}

// Split an amount across phases by weight (remainder on the last one).
function splitByWeight(amount, splits) {
  const total = splits.reduce((s, r) => s + num(r.pct), 0)
  if (!splits.length || total <= 0) return []
  const parts = splits.map(s => round2(amount * num(s.pct) / total))
  const diff = round2(amount - parts.reduce((a, b) => a + b, 0))
  parts[parts.length - 1] = round2(parts[parts.length - 1] + diff)
  return parts
}

function phaseHasDone(cards, boqId, phaseId) {
  const d = doneQty(cards, boqId, phaseId)
  if (d != null) return d > 0
  // cards without quantity: count as done when any matching card is marked done
  return (cards || []).some(c => c.boq_item_id === boqId && c.phase_id === phaseId
    && c.status === 'done')
}

// amounts per (boqId|phaseId) and per no-BOQ quotation item, for a set of invoice items
// Legacy split: fill each target phase's unbilled room (value - already billed) in proportion to
// that room; any excess beyond total room is spread by weight. Remainder on the last phase.
function splitByRoom(amount, splits, rooms) {
  const totalRoom = rooms.reduce((a, b) => a + b, 0)
  if (totalRoom <= 0) return splitByWeight(amount, splits)
  let parts
  if (amount <= totalRoom) {
    parts = rooms.map(r => round2(amount * r / totalRoom))
  } else {
    const extra = splitByWeight(round2(amount - totalRoom), splits)
    parts = rooms.map((r, i) => round2(r + (extra[i] || 0)))
  }
  const diff = round2(amount - parts.reduce((a, b) => a + b, 0))
  parts[parts.length - 1] = round2(parts[parts.length - 1] + diff)
  return parts
}

// billed: running Map key -> amount billed so far (shared across earlier then current items)
function allocate(items, phaseRows, boqByQi, splitsByBoq, phases, cards, valueMap, billed) {
  const byPhase = new Map() // key -> { amount, qty }
  const noBoq = new Map()   // quotation item id (or item id) -> { item, amount }
  const rowsByItem = new Map()
  for (const r of phaseRows || []) {
    if (!rowsByItem.has(r.invoice_item_id)) rowsByItem.set(r.invoice_item_id, [])
    rowsByItem.get(r.invoice_item_id).push(r)
  }
  const add = (key, amount, qty) => {
    const cur = byPhase.get(key) || { amount: 0, qty: 0, hasQty: false }
    cur.amount = round2(cur.amount + amount)
    billed.set(key, round2((billed.get(key) || 0) + amount))
    if (qty != null) { cur.qty = round2(cur.qty + num(qty)); cur.hasQty = true }
    byPhase.set(key, cur)
  }
  for (const it of items || []) {
    const own = rowsByItem.get(it.id)
    if (own && own.length) {
      for (const r of own) add(`${r.boq_item_id}|${r.phase_id}`, num(r.amount), r.qty)
      continue
    }
    const boq = boqByQi?.[it.quotation_item_id]
    const amount = num(it.line_total)
    if (!boq) {
      const k = it.quotation_item_id ?? it.id
      const cur = noBoq.get(k) || { item: it, amount: 0 }
      cur.amount = round2(cur.amount + amount)
      noBoq.set(k, cur)
      continue
    }
    const splits = sortedSplits(splitsByBoq?.[boq.id], phases)
    let target = splits.filter(s => phaseHasDone(cards, boq.id, s.phase_id))
    if (!target.length) target = splits
    const rooms = target.map(s => {
      const k = `${boq.id}|${s.phase_id}`
      return Math.max(0, round2((valueMap.get(k) || 0) - (billed.get(k) || 0)))
    })
    const parts = splitByRoom(amount, target, rooms)
    target.forEach((s, i) => add(`${boq.id}|${s.phase_id}`, parts[i], null))
  }
  return { byPhase, noBoq }
}

export function buildReportRows({ invoice, invoiceItems, itemPhases, earlierItems, earlierItemPhases,
  boqByQuotationItem, splitsByBoq, phases, cards }) {
  void invoice
  const phaseName = new Map((phases || []).map(p => [p.id, p.name]))

  const itemByQi = new Map()
  for (const it of [...(invoiceItems || []), ...(earlierItems || [])]) {
    if (it.quotation_item_id != null && !itemByQi.has(it.quotation_item_id)) itemByQi.set(it.quotation_item_id, it)
  }
  const thisItemByQi = new Map((invoiceItems || []).map(it => [it.quotation_item_id, it]))

  const boqEntries = Object.entries(boqByQuotationItem || {})
    .sort(([, a], [, b]) => String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true }))

  const lineInfo = new Map()
  const valueMap = new Map()
  for (const [qiId, boq] of boqEntries) {
    const item = thisItemByQi.get(qiId) || itemByQi.get(qiId)
    const unitPrice = num(item?.unit_price ?? boq.unit_price)
    const qty = num(boq.planned_qty)
    const splits = sortedSplits(splitsByBoq?.[boq.id], phases)
    const vals = phaseValues(qty, unitPrice, splits)
    splits.forEach((s, i) => valueMap.set(`${boq.id}|${s.phase_id}`, vals[i]))
    lineInfo.set(qiId, { item, unitPrice, qty, splits, vals })
  }
  const billed = new Map()
  const prev = allocate(earlierItems, earlierItemPhases, boqByQuotationItem, splitsByBoq, phases, cards, valueMap, billed)
  const cur = allocate(invoiceItems, itemPhases, boqByQuotationItem, splitsByBoq, phases, cards, valueMap, billed)

  const rows = []
  const finish = row => {
    let remaining = round2(row.value - row.prev - row.this)
    if (remaining < 0) { remaining = 0; row.reasons.push('over_billed') }
    row.remaining = remaining
    if (row.reasons.length && row.check === 'ok') row.check = 'warn'
    rows.push(row)
  }

  for (const [qiId, boq] of boqEntries) {
    const { item, unitPrice, qty, splits, vals } = lineInfo.get(qiId)
    splits.forEach((s, i) => {
      const key = `${boq.id}|${s.phase_id}`
      const c = cur.byPhase.get(key)
      const p = prev.byPhase.get(key)
      let check = 'ok'
      let reasons = []
      if (c && c.hasQty) {
        const done = doneQty(cards, boq.id, s.phase_id)
        const available = done == null ? null : round2(done - (p?.qty || 0))
        const billedPct = qty && unitPrice && c.qty ? round2(c.amount / (c.qty * unitPrice) * 100) : num(s.pct)
        const res = checkLine({ unit: boq.unit ?? item?.unit, qty: c.qty, unitPrice, boqQty: boq.planned_qty,
          boqUnitPrice: null, priceMultiplier: null, billedPct, phaseWeightPct: num(s.pct), cardDoneQty: available })
        check = res.level
        reasons = [...res.reasons]
      }
      finish({
        key, boqCode: boq.code ?? null, description: boq.description ?? item?.description ?? '',
        phaseId: s.phase_id, phaseName: phaseName.get(s.phase_id) ?? '', unit: boq.unit ?? item?.unit ?? null,
        qty, unitPrice, weightPct: num(s.pct), value: vals[i],
        prev: p ? p.amount : 0, this: c ? c.amount : 0, remaining: 0, check, reasons,
      })
    })
  }

  const noBoqKeys = new Set([...cur.noBoq.keys(), ...prev.noBoq.keys()])
  for (const k of noBoqKeys) {
    const c = cur.noBoq.get(k)
    const p = prev.noBoq.get(k)
    const it = (c || p).item
    const thisAmt = c ? c.amount : 0
    const prevAmt = p ? p.amount : 0
    finish({
      key: `item|${k}`, boqCode: null, description: it.description ?? '', phaseId: null, phaseName: '',
      unit: it.unit ?? null, qty: num(it.quantity ?? it.qty), unitPrice: num(it.unit_price), weightPct: null,
      value: round2(thisAmt + prevAmt), prev: prevAmt, this: thisAmt, remaining: 0, check: 'ok', reasons: [],
    })
  }

  const sum = f => round2(rows.reduce((s, r) => s + r[f], 0))
  const totals = { contract: sum('value'), prev: sum('prev'), this: sum('this'), remaining: sum('remaining') }
  totals.pctDone = totals.contract ? round2((totals.prev + totals.this) / totals.contract * 100) : 0
  return { rows, totals }
}

export function markColour(taskId, { prevTaskIds, thisTaskIds } = {}) {
  if (thisTaskIds?.has(taskId)) return MARK_THIS
  if (prevTaskIds?.has(taskId)) return MARK_PREV
  return MARK_REMAINING
}

export function nextReportStatusOnEdit(report) {
  return report?.status === 'signed' ? 'reissue' : 'edit-in-place'
}
