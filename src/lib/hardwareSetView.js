// src/lib/hardwareSetView.js
// The hardware set page (spec 2026-10-31 section 12): what a set holds, split into hardware (อุปกรณ์) and consumables
// (วัสดุสิ้นเปลือง); each line's price (resolveStockPartPrice: latest purchase for stock-linked parts, else catalogue);
// the set total; the stock search of a section; the series chips and the new links to insert. Pure.
import { resolveStockPartPrice } from './latestPurchasePrice.js'
import { friendlyDbError } from './catalogForm.js'

export const SECTIONS = [
  { key: 'hardware', title: 'อุปกรณ์', kind: 'hardware', addLabel: '+ เพิ่มอุปกรณ์', categories: ['อุปกรณ์'] },
  { key: 'consumable', title: 'วัสดุสิ้นเปลือง', kind: 'accessory', addLabel: '+ เพิ่มวัสดุสิ้นเปลือง', categories: ['วัสดุสิ้นเปลือง', 'ซิลิโคน/ยาง'] },
]

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')
const qtyText = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })

// alu_part_set_items of one set -> its lines; kind 'accessory' = consumable, anything else = hardware.
export function setLines({ setId, setItems, partsById }) {
  const out = { hardware: [], consumable: [] }
  for (const r of setItems || []) {
    if (r.set_id !== setId) continue
    const part = (partsById || {})[r.part_id]
    if (!part) continue
    out[part.kind === 'accessory' ? 'consumable' : 'hardware'].push({ id: r.id, part, quantity: Number(r.quantity) })
  }
  out.hardware.sort((a, b) => byName(a.part, b.part))
  out.consumable.sort((a, b) => byName(a.part, b.part))
  return out
}

export function setSummaryText(lines) {
  const h = lines.hardware.length
  const c = lines.consumable.length
  if (!h && !c) return 'ยังไม่ได้ใส่ของ'
  return [h ? `${h} อุปกรณ์` : null, c ? `${c} สิ้นเปลือง` : null].filter(Boolean).join(' · ')
}

export const priceLines = (lines, { asOf, purchasePrices, partPrices }) =>
  (lines || []).map(l => ({ ...l, price: resolveStockPartPrice({ partId: l.part.id, part: l.part, asOf, purchasePrices, partPrices }) }))

// Σ quantity × price; lines without a price are counted in missing (the total is then a lower bound).
export function setTotal(priced) {
  let total = 0
  let missing = 0
  for (const l of priced || []) {
    if (l.price) total += l.quantity * l.price.net_price
    else missing += 1
  }
  return { total, missing }
}

export function onHandByItem(balances) {
  const m = {}
  for (const b of balances || []) m[b.inventory_item_id] = (m[b.inventory_item_id] || 0) + (Number(b.quantity_on_hand) || 0)
  return m
}

// Active stock items of the section's categories whose name or code contains the query; by name, at most `limit`.
export function stockMatches({ items, categoryNames, query, limit = 20 }) {
  const q = String(query || '').trim().toLowerCase()
  return (items || [])
    .filter(i => i.active !== false && (categoryNames || []).includes(i.expense_categories && i.expense_categories.name))
    .filter(i => !q || String(i.name || '').toLowerCase().includes(q) || String(i.code || '').toLowerCase().includes(q))
    .sort(byName)
    .slice(0, limit)
}

// "คงเหลือ 24 ชิ้น · ซื้อล่าสุด 145" / "หมดสต๊อก · ซื้อล่าสุด 98" / "… · ยังไม่มีราคาซื้อ" / "… · โหลดราคาซื้อไม่สำเร็จ" (priceFailed)
export function stockLineText({ onHand, unit, price, priceFailed = false }) {
  const n = Number(onHand) || 0
  const priceText = price ? `ซื้อล่าสุด ${qtyText(price.unit_cost)}` : priceFailed ? 'โหลดราคาซื้อไม่สำเร็จ' : 'ยังไม่มีราคาซื้อ'
  return [n > 0 ? `คงเหลือ ${qtyText(n)} ${unit || ''}`.trim() : 'หมดสต๊อก', priceText].join(' · ')
}

export function seriesChips({ setId, seriesParts, seriesById, providersById, typesById }) {
  return (seriesParts || []).filter(l => l.part_id === setId).map(l => {
    const s = (seriesById || {})[l.series_id]
    const p = s ? (providersById || {})[s.provider_id] : null
    const t = l.type_id ? (typesById || {})[l.type_id] : null
    return { id: l.id, provider: p ? (p.short_name || p.name) : '', label: s ? s.name : 'ซีรีส์ที่ถูกลบแล้ว', type: t ? t.name : '' }
  }).sort((a, b) => `${a.provider} ${a.label}`.localeCompare(`${b.provider} ${b.label}`, 'th'))
}

// Rows for alu_series_parts that the set does not have yet (same series and same type, NULL = every type).
export function newSeriesLinks({ setId, seriesIds, typeId, seriesParts }) {
  const t = typeId || null
  const have = new Set((seriesParts || []).filter(l => l.part_id === setId).map(l => `${l.series_id}|${l.type_id || ''}`))
  return [...new Set(seriesIds || [])].filter(id => !have.has(`${id}|${t || ''}`)).map(id => ({ series_id: id, part_id: setId, type_id: t }))
}

const RPC_TEXT = {
  bad_kind: 'ชนิดของรายการไม่ถูกต้อง', bad_quantity: 'จำนวนต้องมากกว่า 0', bad_name: 'กรอกชื่อและหน่วยของรายการใหม่',
  bad_price: 'ราคาต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป', not_a_set: 'ไม่พบชุดอุปกรณ์นี้ (อาจถูกลบไปแล้ว)',
  item_not_found: 'ไม่พบรายการนี้ในสต๊อก หรือไม่มีสิทธิ์ดูสต๊อก',
}
export const rpcErrorText = e => (e && RPC_TEXT[e.message]) || friendlyDbError(e)

export const addResultText = (data, name) => (data && data.added === false ? `${name} มีในชุดแล้ว` : `เพิ่ม ${name} แล้ว`)
