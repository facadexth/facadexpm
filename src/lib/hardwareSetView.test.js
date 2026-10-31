import { describe, it, expect } from 'vitest'
import {
  SECTIONS, setLines, setSummaryText, priceLines, setTotal, onHandByItem, stockMatches, stockLineText, seriesChips, newSeriesLinks,
  rpcErrorText, addResultText,
} from './hardwareSetView.js'

const partsById = {
  P9: { id: 'P9', code: 'P-0009', name: 'ลูกล้อบานเลื่อน', kind: 'hardware', unit: 'ชิ้น', inventory_item_id: 'i1' },
  P7: { id: 'P7', code: 'P-0007', name: 'มือจับฝัง(ล็อค)', kind: 'hardware', unit: 'ชิ้น' },
  S1: { id: 'S1', code: 'P-0030', name: 'ซิลิโคน 300 มล.', kind: 'accessory', unit: 'หลอด' },
}
const setItems = [
  { id: 'a', set_id: 'SET', part_id: 'P9', quantity: '4' }, { id: 'b', set_id: 'SET', part_id: 'P7', quantity: 1 },
  { id: 'c', set_id: 'SET', part_id: 'S1', quantity: 2 }, { id: 'd', set_id: 'OTHER', part_id: 'P7', quantity: 1 },
]

describe('set contents', () => {
  it('splits into hardware and consumables, by name, quantities as numbers', () => {
    const l = setLines({ setId: 'SET', setItems, partsById })
    expect(l.hardware.map(x => [x.part.id, x.quantity])).toEqual([['P7', 1], ['P9', 4]])
    expect(l.consumable.map(x => x.part.id)).toEqual(['S1'])
    expect(setSummaryText(l)).toBe('2 อุปกรณ์ · 1 สิ้นเปลือง')
    expect(setSummaryText(setLines({ setId: 'EMPTY', setItems, partsById }))).toBe('ยังไม่ได้ใส่ของ')
  })
  it('prices each line (purchase price for stock-linked parts) and totals the set', () => {
    const ctx = {
      asOf: '2026-10-31',
      purchasePrices: [{ id: 'sti:1', inventory_item_id: 'i1', unit_cost: 85, effective_from: '2026-10-01', source: 'tax_invoice', doc_no: 'IV-1' }],
      partPrices: [{ id: 'pp', part_id: 'S1', list_price: 95, discount_pct: 0, effective_from: '2026-01-01' }],
    }
    const l = setLines({ setId: 'SET', setItems, partsById })
    const priced = priceLines([...l.hardware, ...l.consumable], ctx)
    expect(priced.map(x => x.price && x.price.net_price)).toEqual([null, 85, 95])
    expect(setTotal(priced)).toEqual({ total: 4 * 85 + 2 * 95, missing: 1 })
  })
})

describe('stock search', () => {
  const items = [
    { id: 'i1', code: 'HW0001', name: 'มือจับกระทุ้ง 019 สีดำ ขวา', base_unit: 'ชิ้น', expense_categories: { name: 'อุปกรณ์' } },
    { id: 'i2', code: 'SC0001', name: 'ซิลิโคน 300 มล.', base_unit: 'หลอด', expense_categories: { name: 'ซิลิโคน/ยาง' } },
    { id: 'i3', code: 'AL0001', name: 'มือจับ อลูมิเนียม', base_unit: 'เส้น', expense_categories: { name: 'อลูมิเนียม/เหล็ก' } },
    { id: 'i4', code: 'HW0002', name: 'มือจับปิดแล้ว', base_unit: 'ชิ้น', active: false, expense_categories: { name: 'อุปกรณ์' } },
  ]
  it("only the section's categories, active, by name or code", () => {
    expect(stockMatches({ items, categoryNames: SECTIONS[0].categories, query: 'มือจับ' }).map(i => i.id)).toEqual(['i1'])
    expect(stockMatches({ items, categoryNames: SECTIONS[1].categories, query: 'sc00' }).map(i => i.id)).toEqual(['i2'])
    expect(stockMatches({ items, categoryNames: SECTIONS[0].categories, query: '' }).map(i => i.id)).toEqual(['i1'])
    expect(stockMatches({ items: null, categoryNames: ['อุปกรณ์'], query: 'x' })).toEqual([])
  })
  it('on hand summed over sites; the line text of the mockup', () => {
    expect(onHandByItem([{ inventory_item_id: 'i1', quantity_on_hand: '10' }, { inventory_item_id: 'i1', quantity_on_hand: 14 }])).toEqual({ i1: 24 })
    expect(stockLineText({ onHand: 24, unit: 'ชิ้น', price: { unit_cost: 145 } })).toBe('คงเหลือ 24 ชิ้น · ซื้อล่าสุด 145')
    expect(stockLineText({ onHand: 0, unit: 'ชิ้น', price: { unit_cost: 98 } })).toBe('หมดสต๊อก · ซื้อล่าสุด 98')
    expect(stockLineText({ onHand: undefined, unit: 'ชิ้น', price: null })).toBe('หมดสต๊อก · ยังไม่มีราคาซื้อ')
    // the price load failed: never claim there is no purchase price
    expect(stockLineText({ onHand: 24, unit: 'ชิ้น', price: null, priceFailed: true })).toBe('คงเหลือ 24 ชิ้น · โหลดราคาซื้อไม่สำเร็จ')
  })
})

describe('series links', () => {
  const seriesParts = [
    { id: 'L1', series_id: 's2', part_id: 'SET', type_id: null }, { id: 'L2', series_id: 's1', part_id: 'SET', type_id: 'slide' },
    { id: 'L3', series_id: 's1', part_id: 'OTHER', type_id: null },
  ]
  const seriesById = { s1: { id: 's1', name: 'ICONIQ EURO บานเลื่อน', provider_id: 'A' }, s2: { id: 's2', name: 'ทั่วไป', provider_id: 'X' } }
  const providersById = { A: { id: 'A', name: 'บจก. อลูเม็ท (Alumet)', short_name: 'Alumet' }, X: { id: 'X', name: 'ไฟล์ Aluminium calculation', short_name: 'XLS' } }
  it('chips of this set, with extruder and type', () => {
    expect(seriesChips({ setId: 'SET', seriesParts, seriesById, providersById, typesById: { slide: { name: 'บานเลื่อน' } } })).toEqual([
      { id: 'L2', provider: 'Alumet', label: 'ICONIQ EURO บานเลื่อน', type: 'บานเลื่อน' },
      { id: 'L1', provider: 'XLS', label: 'ทั่วไป', type: '' },
    ])
  })
  it('new links skip the ones the set already has (same series and type)', () => {
    expect(newSeriesLinks({ setId: 'SET', seriesIds: ['s1', 's3', 's3'], typeId: 'slide', seriesParts })).toEqual([{ series_id: 's3', part_id: 'SET', type_id: 'slide' }])
    expect(newSeriesLinks({ setId: 'SET', seriesIds: ['s1'], typeId: '', seriesParts })).toEqual([{ series_id: 's1', part_id: 'SET', type_id: null }])
  })
})

describe('messages', () => {
  it('RPC errors in Thai; database errors via friendlyDbError', () => {
    expect(rpcErrorText({ message: 'not_a_set' })).toBe('ไม่พบชุดอุปกรณ์นี้ (อาจถูกลบไปแล้ว)')
    expect(rpcErrorText({ message: 'item_not_found' })).toBe('ไม่พบรายการนี้ในสต๊อก หรือไม่มีสิทธิ์ดูสต๊อก')
    expect(rpcErrorText({ code: '23505', message: 'dup' })).toBe('มีข้อมูลนี้อยู่แล้ว (ซ้ำ) กรุณาตรวจสอบรายการเดิม')
  })
  it('a second add of the same stock item says it is already there (Review Focus 5)', () => {
    expect(addResultText({ part_id: 'p', added: false }, 'ลูกล้อ')).toBe('ลูกล้อ มีในชุดแล้ว')
    expect(addResultText({ part_id: 'p', added: true }, 'ลูกล้อ')).toBe('เพิ่ม ลูกล้อ แล้ว')
  })
})

// Review Focus (controller, Task 11): the page trusts alu_add_stock_item_to_set to be idempotent per set and to reuse
// one alu_parts row per stock item across sets (live behaviour checked by the 02 dry run, check 6). Pin the SQL shape.
describe('alu_add_stock_item_to_set reuses the part and never adds a line twice', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const sql = readFileSync(fileURLToPath(new URL('../../supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql', import.meta.url)), 'utf8')
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION alu_add_stock_item_to_set'), sql.indexOf('CREATE OR REPLACE FUNCTION alu_add_new_part_to_set'))
  it('finds the existing part of the stock item before creating one (a second set reuses it)', () => {
    const find = body.indexOf('SELECT id INTO v_part FROM alu_parts WHERE inventory_item_id = p_inventory_item_id')
    expect(find).toBeGreaterThan(-1)
    expect(body.indexOf('IF v_part IS NULL THEN')).toBeGreaterThan(find)
    expect(sql).toContain('CREATE UNIQUE INDEX uq_alu_parts_inventory_item ON alu_parts (inventory_item_id)')
  })
  it('a second add to the same set inserts nothing and reports added = false', () => {
    expect(body).toContain('IF NOT EXISTS (SELECT 1 FROM alu_part_set_items WHERE set_id = p_set_id AND part_id = v_part) THEN')
    expect(body).toContain('v_added  BOOLEAN := false;')
    expect(body).toContain("RETURN jsonb_build_object('part_id', v_part, 'added', v_added);")
  })
})
