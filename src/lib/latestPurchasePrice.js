// src/lib/latestPurchasePrice.js
// Price of a catalogue part that points at a stock item (alu_parts.inventory_item_id), spec 2026-10-31 section 12:
// the latest posted supplier tax invoice price, else the latest purchase-order price, else the part's own catalogue
// price (alu_part_prices). Ex-VAT, per the stock item's base unit. rows = stock_item_purchase_prices() rows
// { id, inventory_item_id, unit_cost, effective_from, source: 'tax_invoice' | 'po', doc_no }. asOf = 'YYYY-MM-DD'.
// Pure; the estimation engine (aluCatalogPricing) and the hardware set page price a part through the same function.
import { resolvePartPrice } from './aluPrice.js'

function latestOf(rows, itemId, source, asOf) {
  let best = null
  for (const r of rows || []) {
    if (r.inventory_item_id !== itemId || r.source !== source) continue
    if (asOf && r.effective_from > asOf) continue
    if (!best || r.effective_from > best.effective_from) best = r
  }
  return best
}

export function latestPurchasePrice(rows, inventoryItemId, asOf) {
  if (!inventoryItemId) return null
  const r = latestOf(rows, inventoryItemId, 'tax_invoice', asOf) || latestOf(rows, inventoryItemId, 'po', asOf)
  if (!r) return null
  const n = Number(r.unit_cost)
  return Number.isFinite(n) ? { unit_cost: n, effective_from: r.effective_from, source: r.source, doc_no: r.doc_no || null, id: r.id } : null
}

// resolvePartPrice's shape ({ list_price, discount_pct, net_price, row }) plus source and date.
export function resolveStockPartPrice({ partId, part, asOf, purchasePrices, partPrices }) {
  const p = part || null
  const bought = p && p.inventory_item_id ? latestPurchasePrice(purchasePrices, p.inventory_item_id, asOf) : null
  if (bought) {
    return {
      list_price: bought.unit_cost, discount_pct: 0, net_price: bought.unit_cost,
      row: { id: bought.id, effective_from: bought.effective_from }, source: bought.source, date: bought.effective_from, doc_no: bought.doc_no,
    }
  }
  const c = resolvePartPrice({ partId: partId || (p && p.id), asOf, partPrices })
  return c ? { ...c, source: 'catalog', date: c.row.effective_from, doc_no: null } : null
}

const SOURCE_TEXT = { tax_invoice: 'ใบกำกับภาษีซื้อ', po: 'ใบสั่งซื้อ' }
export function priceSourceText(price) {
  if (!price) return 'ยังไม่มีราคา'
  if (price.source === 'catalog') return `แคตตาล็อก · ตั้งแต่ ${price.date}`
  return [[SOURCE_TEXT[price.source] || price.source, price.doc_no].filter(Boolean).join(' '), price.date].filter(Boolean).join(' · ')
}
