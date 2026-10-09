import { describe, it, expect } from 'vitest'
import { buildLines, planPush, revisionLabel, nextSubNo, snapshotFor, compareWithLastSent } from './quotationExport'

const row = (id, price, quantity = 1, resolved = true) => ({ id, resolved, price: resolved ? price : null, quantity })
const mk = (rows, split = { enabled: false, materialPct: 80 }, items) => buildLines({
  rows,
  items: items || rows.map((r, i) => ({ id: r.id, opening_no: `W${i + 1}`, item_name: 'หน้าต่าง' })),
  descriptionCtxById: Object.fromEntries(rows.map(r => [r.id, { item_name: 'หน้าต่าง', type_name: 'บานเลื่อน' }])),
  descriptionFormat: ['item_name', 'type'], split,
}).lines

describe('buildLines', () => {
  it('builds item + description rows', () => {
    const [l] = mk([row('o1', 14200, 3)])
    expect(l.openingId).toBe('o1')
    expect(l.item).toMatchObject({ description: 'W1 หน้าต่าง', unit: 'ชุด', quantity: 3, unit_price: 14200, line_total: 42600, item_type: 'item', unit_price_material: null, unit_price_labor: null })
    expect(l.desc).toMatchObject({ description: 'หน้าต่าง บานเลื่อน', unit: null, quantity: 0, unit_price: 0, line_total: 0, item_type: 'item_description', unit_price_material: null, unit_price_labor: null })
  })
  it('falls back to รายการ n', () => {
    const { lines } = buildLines({ rows: [row('o1', 100)], items: [{ id: 'o1' }], descriptionCtxById: {}, descriptionFormat: [], split: {} })
    expect(lines[0].item.description).toBe('รายการ 1')
  })
  it('split 80/20 of 14200', () => {
    const [l] = mk([row('o1', 14200)], { enabled: true, materialPct: 80 })
    expect(l.item.unit_price_material).toBe(11360); expect(l.item.unit_price_labor).toBe(2840); expect(l.item.unit_price).toBe(14200)
  })
  it('rounding goes to labour: 14201 @80', () => {
    const [l] = mk([row('o1', 14201)], { enabled: true, materialPct: 80 })
    expect(l.item.unit_price_material).toBe(11361); expect(l.item.unit_price_labor).toBe(2840)
  })
  it('split 100 -> labour 0', () => {
    const [l] = mk([row('o1', 5000)], { enabled: true, materialPct: 100 })
    expect(l.item.unit_price_material).toBe(5000); expect(l.item.unit_price_labor).toBe(0)
  })
  it('skips unresolved rows', () => {
    const { lines, skipped } = buildLines({ rows: [row('o1', 1), row('o2', 0, 1, false)], items: [{ id: 'o1' }, { id: 'o2', opening_no: 'W2' }], descriptionCtxById: {}, descriptionFormat: [], split: {} })
    expect(lines.map(l => l.openingId)).toEqual(['o1']); expect(skipped).toEqual([{ openingId: 'o2', opening_no: 'W2' }])
  })
})

describe('labels', () => {
  it('revisionLabel', () => { expect(revisionLabel(1, 1)).toBe('R1-1'); expect(revisionLabel(2, 3)).toBe('R2-3') })
  const snaps = [
    { quotation_id: 'q', kind: 'sent', revision: 1, sub_no: 1 }, { quotation_id: 'q', kind: 'sent', revision: 1, sub_no: 2 },
    { quotation_id: 'q', kind: 'agreed', revision: 1, sub_no: 9 }, { quotation_id: 'z', kind: 'sent', revision: 1, sub_no: 7 },
  ]
  it('increments within a revision', () => expect(nextSubNo(snaps, 'q', 1)).toBe(3))
  it('restarts on a new revision', () => expect(nextSubNo(snaps, 'q', 2)).toBe(1))
  it('1 when none', () => expect(nextSubNo([], 'q', 1)).toBe(1))
})

const L = (id) => ({ openingId: id, item: { description: id, unit: 'ชุด', quantity: 1, unit_price: 10, line_total: 10, item_type: 'item', unit_price_material: null, unit_price_labor: null }, desc: { description: 'd' + id, unit: null, quantity: 0, unit_price: 0, line_total: 0, item_type: 'item_description', unit_price_material: null, unit_price_labor: null } })
const ex = (o, i, d) => ({ openingId: o, itemRowId: i, descRowId: d })
const base = { quotation: { id: 'q', status: 'draft', revision: 1 }, existingLines: [], newLines: [], existingRowIds: new Set(), invoiceRefs: new Set(), userRows: [], snapshots: [] }

describe('planPush state table', () => {
  it('create', () => {
    const p = planPush({ ...base, quotation: null, newLines: [L('a'), L('b')] })
    expect(p).toMatchObject({ action: 'create', bumpRevision: false, newRevision: 1, setStatus: null, subNo: 1 })
    expect(p.inserts.map(i => [i.openingId, i.kind, i.sort_order])).toEqual([['a', 'item', 0], ['a', 'desc', 1], ['b', 'item', 2], ['b', 'desc', 3]])
  })
  it('draft overwrite', () => {
    const p = planPush({ ...base, newLines: [L('a')], existingLines: [ex('a', 'i1', 'd1')], existingRowIds: new Set(['i1', 'd1']) })
    expect(p).toMatchObject({ action: 'overwrite', bumpRevision: false, newRevision: 1, setStatus: null, needsAcceptedConfirm: false, subNo: 1 })
    expect(p.updates.map(u => u.id)).toEqual(['i1', 'd1']); expect(p.inserts).toEqual([]); expect(p.deletes).toEqual([])
  })
  it('draft sub no increments', () => {
    const p = planPush({ ...base, newLines: [], snapshots: [{ quotation_id: 'q', kind: 'sent', revision: 1, sub_no: 1 }] })
    expect(p.subNo).toBe(2)
  })
  it('sent -> pullback', () => {
    const p = planPush({ ...base, quotation: { id: 'q', status: 'sent', revision: 1 }, snapshots: [{ quotation_id: 'q', kind: 'sent', revision: 1, sub_no: 4 }] })
    expect(p).toMatchObject({ action: 'pullback_overwrite', bumpRevision: true, newRevision: 2, setStatus: 'draft', needsAcceptedConfirm: false, subNo: 1 })
  })
  it('accepted needs confirm', () => {
    expect(planPush({ ...base, quotation: { id: 'q', status: 'accepted', revision: 2 } })).toMatchObject({ needsAcceptedConfirm: true, newRevision: 3 })
  })
  it('after pullback the next push is overwrite with subNo+1', () => {
    const p = planPush({ ...base, quotation: { id: 'q', status: 'draft', revision: 2 }, snapshots: [{ quotation_id: 'q', kind: 'sent', revision: 2, sub_no: 1 }] })
    expect(p).toMatchObject({ action: 'overwrite', newRevision: 2, subNo: 2 })
  })
  it('rejected/expired pull back with warning', () => {
    for (const s of ['rejected', 'expired']) {
      expect(planPush({ ...base, quotation: { id: 'q', status: s, revision: 1 } })).toMatchObject({ action: 'pullback_overwrite', statusWarning: true, bumpRevision: true })
    }
    expect(planPush({ ...base, quotation: { id: 'q', status: 'sent', revision: 1 } }).statusWarning).toBe(false)
  })
})

describe('planPush rows', () => {
  it('re-inserts deleted generated row, updates survivor', () => {
    const p = planPush({ ...base, newLines: [L('a')], existingLines: [ex('a', 'i1', 'd1')], existingRowIds: new Set(['d1']) })
    expect(p.inserts.map(i => [i.openingId, i.kind])).toEqual([['a', 'item']])
    expect(p.updates.map(u => u.id)).toEqual(['d1'])
  })
  it('new openings insert; removed openings delete', () => {
    const p = planPush({ ...base, newLines: [L('b')], existingLines: [ex('a', 'i1', 'd1')], existingRowIds: new Set(['i1', 'd1']) })
    expect(p.inserts.map(i => i.openingId)).toEqual(['b', 'b']); expect(p.deletes.map(d => d.id).sort()).toEqual(['d1', 'i1'])
  })
  it('invoice-referenced removed item is kept with a reason', () => {
    const p = planPush({ ...base, newLines: [], existingLines: [ex('a', 'i1', 'd1')], existingRowIds: new Set(['i1', 'd1']), invoiceRefs: new Set(['i1']) })
    expect(p.deletes).toEqual([]); expect(p.keeps).toHaveLength(1)
    expect(p.keeps[0]).toMatchObject({ openingId: 'a', itemRowId: 'i1', descRowId: 'd1' }); expect(p.keeps[0].reason).toBeTruthy()
  })
  it('user rows are never touched; appended after generated, order preserved', () => {
    const p = planPush({ ...base, newLines: [L('a')], existingLines: [ex('a', 'i1', 'd1')], existingRowIds: new Set(['i1', 'd1', 'u1', 'u2']),
      userRows: [{ id: 'u1', sort_order: 0 }, { id: 'u2', sort_order: 5 }] })
    const ids = [...p.updates, ...p.inserts, ...p.deletes].map(x => x.id)
    expect(ids).not.toContain('u1'); expect(ids).not.toContain('u2')
    expect(p.updates.map(u => u.sort_order)).toEqual([0, 1])
    expect(p.userRowOrder).toEqual([{ id: 'u1', sort_order: 2 }, { id: 'u2', sort_order: 3 }])
  })
  it('userRowOrder omits unchanged rows', () => {
    const p = planPush({ ...base, newLines: [L('a')], userRows: [{ id: 'u1', sort_order: 2 }] })
    expect(p.userRowOrder).toEqual([])
  })
})

describe('snapshotFor', () => {
  it('has exactly the Quotations.jsx handleSave keys', () => {
    const s = snapshotFor({ client_id: 'c', clients: { name: 'N' }, date: 'd', valid_until: 'v', has_vat: true, price_includes_vat: false, discount_amount: 0, discount_pct: 0, payment_terms: 'p', notes: 'n', bank_accounts: { id: 1 } },
      [{ description: 'x', unit: 'ชุด', quantity: 1, unit_price: 2, unit_price_material: null, unit_price_labor: null, line_total: 2, id: 'zzz' }])
    const KEYS = ['client_id', 'client_name', 'date', 'valid_until', 'has_vat', 'price_includes_vat', 'discount_amount', 'discount_pct', 'pricing_mode', 'payment_terms', 'notes', 'bank_account', 'items']
    expect(Object.keys(s)).toEqual(KEYS)
    expect(s.pricing_mode).toBe('combined'); expect(s.client_name).toBe('N')
    expect(Object.keys(s.items[0])).toEqual(['description', 'unit', 'quantity', 'unit_price', 'unit_price_material', 'unit_price_labor', 'line_total'])
  })
})

describe('Task 8 contract fixes', () => {
  it('split description rows are 0, not null', () => {
    const [l] = mk([row('o1', 1000)], { enabled: true, materialPct: 80 })
    expect(l.desc.unit_price_material).toBe(0); expect(l.desc.unit_price_labor).toBe(0)
  })
  it('NaN / undefined / blank split pct falls back to 80, out of range is clamped', () => {
    expect(mk([row('o1', 1000)], { enabled: true, materialPct: NaN })[0].item.unit_price_material).toBe(800)
    expect(mk([row('o1', 1000)], { enabled: true })[0].item.unit_price_material).toBe(800)
    expect(mk([row('o1', 1000)], { enabled: true, materialPct: '' })[0].item.unit_price_material).toBe(800)
    expect(mk([row('o1', 1000)], { enabled: true, materialPct: 150 })[0].item.unit_price_labor).toBe(0)
    expect(mk([row('o1', 1000)], { enabled: true, materialPct: -5 })[0].item.unit_price_material).toBe(0)
  })
  it('duplicate openings produce a single pair', () => {
    const r = row('o1', 100)
    const { lines } = buildLines({ rows: [r, r], items: [{ id: 'o1' }], descriptionCtxById: {}, descriptionFormat: [], split: {} })
    expect(lines).toHaveLength(1)
  })
  it('planPush with a null quotation revision is numeric', () => {
    const p = planPush({ ...base, quotation: { id: 'q', status: 'sent', revision: null } })
    expect(p.newRevision).toBe(2)
    expect(planPush({ ...base, quotation: { id: 'q', status: 'draft', revision: null } }).newRevision).toBe(1)
  })
  it('kept pair gets consecutive sort orders', () => {
    const p = planPush({ ...base, newLines: [L('b')], existingLines: [ex('a', 'i1', 'd1')], existingRowIds: new Set(['i1', 'd1']), invoiceRefs: new Set(['i1']) })
    expect(p.keepOrder).toEqual([{ id: 'i1', sort_order: 2 }, { id: 'd1', sort_order: 3 }])
  })
})

describe('description fallback and comparison', () => {
  it('blank description falls back to size, then item name', () => {
    const mkd = (ctx, items) => buildLines({ rows: [row('o1', 100)], items, descriptionCtxById: { o1: ctx }, descriptionFormat: ['type'], split: {} }).lines[0].desc.description
    expect(mkd({ width_m: 1.2, height_m: 0.8 }, [{ id: 'o1', item_name: 'ประตู' }])).toBe('ขนาด 1200 × 800 มม.')
    expect(mkd({}, [{ id: 'o1', opening_no: 'D1', item_name: 'ประตู' }])).toBe('ประตู')
    expect(mkd({}, [{ id: 'o1' }])).toBe('รายการ 1')
  })
  it('compareWithLastSent: per item diff, pct and totals', () => {
    const snapshot = { items: [{ opening_id: 'a', price: 1000, quantity: 2 }, { opening_id: 'gone', price: 500, quantity: 1 }] }
    const r = compareWithLastSent({ snapshot, rows: [row('a', 1100, 2), row('n', 300, 1), row('u', 0, 1, false)], items: [{ id: 'a', opening_no: 'W1' }] })
    expect(r.rows).toEqual([
      { openingId: 'a', opening_no: 'W1', oldPrice: 1000, newPrice: 1100, diff: 100, pct: 10 },
      { openingId: 'n', opening_no: null, oldPrice: null, newPrice: 300, diff: null, pct: null },
    ])
    expect(r.oldTotal).toBe(2500); expect(r.newTotal).toBe(2500); expect(r.diffTotal).toBe(0)
  })
  it('no snapshot: old total 0', () => { expect(compareWithLastSent({ snapshot: null, rows: [row('a', 10)] }).oldTotal).toBe(0) })
})
