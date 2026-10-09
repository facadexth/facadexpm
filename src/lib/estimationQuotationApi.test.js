import { describe, it, expect, vi } from 'vitest'

vi.mock('./audit.js', () => ({ auditLog: vi.fn(async () => {}) }))
import { buildLines, snapshotFor } from './quotationExport'
import { auditLog } from './audit.js'
import { pushToQuotation, preparePlan, loadLinkedQuotation, buildSnapshotPayload, NO_LINES_MESSAGE } from './estimationQuotationApi'

const ALLOWED = {
  quotations: ['client_id', 'site_name', 'date', 'valid_until', 'has_vat', 'price_includes_vat', 'discount_amount', 'discount_pct', 'pricing_mode', 'payment_terms', 'notes', 'bank_account_id', 'status', 'revision'],
  quotation_items: ['quotation_id', 'catalog_item_id', 'description', 'quantity', 'unit', 'unit_price', 'unit_price_material', 'unit_price_labor', 'line_total', 'sort_order', 'item_type'],
  quotation_revisions: ['quotation_id', 'revision', 'snapshot'],
  estimation_quotation_links: ['project_id', 'quotation_id', 'attach_enabled', 'attach_mode', 'attach_view', 'split_enabled', 'split_material_pct', 'last_pushed_at'],
  estimation_quotation_lines: ['project_id', 'opening_id', 'item_row_id', 'description_row_id'],
  estimation_price_snapshots: ['project_id', 'quotation_id', 'kind', 'revision', 'sub_no', 'price_as_of', 'factors', 'items', 'totals'],
}
// ---- hand-written in-memory Supabase fake -------------------------------------------------------------
function makeFake(failOn = null, shared = null) {
  const tables = shared || {}
  let n = 0
  const T = name => (tables[name] ||= [])
  const counts = {}
  const calls = []
  const client = {
    tables, calls,
    from(table) {
      const st = { table, op: 'select', payload: null, filters: [], order: null, mode: 'many' }
      const run = () => {
        calls.push(`${st.op}:${table}`)
        if (failOn && failOn.table === table && failOn.op === st.op) {
          const k = `${table}:${st.op}`; counts[k] = (counts[k] || 0) + 1
          if (!failOn.nth || counts[k] === failOn.nth) return { data: null, error: new Error('boom ' + table) }
        }
        if (st.op === 'insert' || st.op === 'update') {
          const ok = ALLOWED[table]
          for (const r of (Array.isArray(st.payload) ? st.payload : [st.payload])) {
            const bad = ok ? Object.keys(r).filter(c => !ok.includes(c)) : []
            if (bad.length) return { data: null, error: new Error(`column ${bad.join(',')} of ${table} does not exist`) }
            if (table === 'quotation_items' && r.item_type !== undefined && !['item', 'item_description', 'note'].includes(r.item_type)) return { data: null, error: new Error('item_type check') }
          }
        }
        const match = r => st.filters.every(f => (f.kind === 'eq' ? r[f.col] === f.val : f.val.includes(r[f.col])))
        let data
        if (st.op === 'insert') {
          const arr = (Array.isArray(st.payload) ? st.payload : [st.payload]).map(r => ({ id: `${table}-${++n}`, ...(table === 'quotations' ? { status: 'draft', revision: 1 } : {}), ...r }))
          arr.forEach(r => T(table).push(r)); data = arr.map(r => ({ ...r }))
        } else if (st.op === 'update') {
          data = T(table).filter(match); data.forEach(r => Object.assign(r, st.payload)); data = data.map(r => ({ ...r }))
        } else if (st.op === 'delete') {
          const gone = T(table).filter(match); tables[table] = T(table).filter(r => !match(r)); data = gone
        } else {
          data = T(table).filter(match).map(r => ({ ...r }))
          if (st.order) data.sort((a, b) => (a[st.order] ?? 0) - (b[st.order] ?? 0))
        }
        if (st.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: new Error('single: ' + data.length) }
        if (st.mode === 'maybe') return { data: data[0] || null, error: null }
        return { data, error: null }
      }
      const b = {
        select() { return b }, insert(p) { st.op = 'insert'; st.payload = p; return b }, update(p) { st.op = 'update'; st.payload = p; return b },
        delete() { st.op = 'delete'; return b },
        eq(col, val) { st.filters.push({ kind: 'eq', col, val }); return b }, in(col, val) { st.filters.push({ kind: 'in', col, val }); return b },
        order(col) { st.order = col; return b }, single() { st.mode = 'single'; return b }, maybeSingle() { st.mode = 'maybe'; return b },
        then(res, rej) { try { return Promise.resolve(run()).then(res, rej) } catch (e) { return Promise.reject(e) } },
      }
      return b
    },
  }
  return client
}

const project = { id: 'p1', price_as_of: '2026-10-01' }
const tenant = { default_payment_terms: 'มัดจำ 50%', default_notes: null }
const header = { client_id: 'c1', site_name: 'บ้านตัวอย่าง', date: '2026-10-09', validDays: 30, attach_enabled: true, attach_mode: 'pages', attach_view: 'both', split_enabled: false, split_material_pct: 80 }
const mkLines = (ids, split = { enabled: false, materialPct: 80 }) => buildLines({
  rows: ids.map(id => ({ id, resolved: true, price: 1000, quantity: 2 })),
  items: ids.map(id => ({ id, opening_no: id.toUpperCase(), item_name: 'หน้าต่าง' })),
  descriptionCtxById: {}, descriptionFormat: ['item_name'], split,
}).lines
const payload = { factors: { wastePct: 5 }, items: [], totals: { lineTotal: 1 } }

// link/quotation are always re-read from the database (the dialog does the same), never passed in.
async function send(db, { ids = ['a', 'b'], hdr = header } = {}) {
  const lines = mkLines(ids)
  const { link, quotation } = await loadLinkedQuotation({ supabase: db, project })
  const plan = await preparePlan({ supabase: db, project, quotation, newLines: lines })
  return pushToQuotation({ supabase: db, project, link, quotation, plan, header: hdr, lines, snapshotPayload: payload, tenant })
}
const qOf = (db, id) => db.tables.quotations.find(q => q.id === id)
const seed = db => { db.tables.bank_accounts = [{ id: 'bk1', vat_category: 'vat', is_default: false }, { id: 'bk2', vat_category: 'vat', is_default: true }, { id: 'bk3', vat_category: 'non_vat', is_default: true }] }

describe('pushToQuotation', () => {
  it('first send creates quotation, 2xN items, lines, snapshot R1-1 and link', async () => {
    const db = makeFake(); seed(db)
    const r = await send(db)
    expect(r.label).toBe('R1-1')
    expect(db.tables.quotations).toHaveLength(1)
    expect(db.tables.quotations[0]).toMatchObject({ client_id: 'c1', has_vat: true, price_includes_vat: false, pricing_mode: 'combined', payment_terms: 'มัดจำ 50%', notes: null, bank_account_id: 'bk2', valid_until: '2026-11-08', discount_amount: null, discount_pct: null })
    expect(db.tables.quotation_items).toHaveLength(4)
    expect(db.tables.quotation_items.map(i => i.sort_order)).toEqual([0, 1, 2, 3])
    expect(db.tables.estimation_quotation_lines).toHaveLength(2)
    expect(db.tables.estimation_quotation_lines[0].item_row_id).toBe(db.tables.quotation_items[0].id)
    expect(db.tables.estimation_price_snapshots[0]).toMatchObject({ kind: 'sent', revision: 1, sub_no: 1, quotation_id: r.quotationId })
    expect(db.tables.estimation_quotation_links[0]).toMatchObject({ project_id: 'p1', quotation_id: r.quotationId, attach_mode: 'pages' })
  })

  it('split header creates a split quotation', async () => {
    const db = makeFake(); seed(db)
    await send(db, { hdr: { ...header, split_enabled: true } })
    expect(db.tables.quotations[0].pricing_mode).toBe('split')
  })

  it('second push while draft overwrites by id, label R1-2', async () => {
    const db = makeFake(); seed(db)
    const r1 = await send(db)
    const ids = db.tables.quotation_items.map(i => i.id)
    const r2 = await send(db)
    expect(r2.label).toBe('R1-2')
    expect(db.tables.quotation_items.map(i => i.id)).toEqual(ids)
    expect(db.tables.quotation_revisions || []).toHaveLength(0)
    expect(db.tables.estimation_quotation_links).toHaveLength(1)
    expect(db.tables.estimation_quotation_lines).toHaveLength(2)
  })

  it('push on sent writes one revision row equal to the old content, status draft, revision 2, R2-1 then R2-2; user row survives', async () => {
    const db = makeFake(); seed(db)
    const r1 = await send(db)
    const link = db.tables.estimation_quotation_links[0]
    db.tables.quotation_items.push({ id: 'user1', quotation_id: r1.quotationId, description: 'ค่าขนย้าย', quantity: 1, unit: 'งาน', unit_price: 500, line_total: 500, sort_order: 4, item_type: 'item' })
    const q = qOf(db, r1.quotationId); q.status = 'sent'; q.revision = 1; q.ever_sent = true
    const before = snapshotFor(q, [...db.tables.quotation_items].sort((a, b) => a.sort_order - b.sort_order))
    const r2 = await send(db)
    expect(r2.label).toBe('R2-1')
    expect(db.tables.quotation_revisions).toHaveLength(1)
    expect(db.tables.quotation_revisions[0]).toMatchObject({ quotation_id: r1.quotationId, revision: 1 })
    expect(db.tables.quotation_revisions[0].snapshot).toEqual(before)
    expect(qOf(db, r1.quotationId)).toMatchObject({ status: 'draft', revision: 2 })
    expect(db.tables.quotation_items.some(i => i.id === 'user1')).toBe(true)
    const r3 = await send(db)
    expect(r3.label).toBe('R2-2')
    expect(db.tables.quotation_revisions).toHaveLength(1)
    expect(db.tables.estimation_price_snapshots.map(s => [s.revision, s.sub_no])).toEqual([[1, 1], [2, 1], [2, 2]])
  })

  it('an error in step 3 stops before lines and snapshot', async () => {
    const db = makeFake(); seed(db)
    const r1 = await send(db)
    const link = db.tables.estimation_quotation_links[0]
    const linesBefore = JSON.stringify(db.tables.estimation_quotation_lines)
    db.calls.length = 0
    const failing = makeFake({ table: 'quotation_items', op: 'update' }, db.tables)
    await expect(send(failing)).rejects.toThrow('boom quotation_items')
    expect(failing.tables.estimation_price_snapshots).toHaveLength(1)
    expect(JSON.stringify(failing.tables.estimation_quotation_lines)).toBe(linesBefore)
    expect(failing.calls.some(c => c === 'insert:estimation_price_snapshots')).toBe(false)
  })

  it('refuses when the quotation has items but no line map', async () => {
    const db = makeFake(); seed(db)
    db.tables.quotations = [{ id: 'q9', status: 'draft', revision: 1 }]
    db.tables.quotation_items = [{ id: 'x1', quotation_id: 'q9', sort_order: 0 }]
    await expect(preparePlan({ supabase: db, project, quotation: db.tables.quotations[0], newLines: mkLines(['a']) })).rejects.toThrow(NO_LINES_MESSAGE)
  })

  it('allows an empty quotation without lines', async () => {
    const db = makeFake(); seed(db)
    db.tables.quotations = [{ id: 'q9', status: 'draft', revision: 1 }]
    const plan = await preparePlan({ supabase: db, project, quotation: db.tables.quotations[0], newLines: mkLines(['a']) })
    expect(plan.inserts).toHaveLength(2)
  })
})

describe('buildSnapshotPayload', () => {
  it('captures per-item costs, price and unresolved flag', () => {
    const result = { rows: [{ id: 'a', resolved: true, v: 1, w: 2, x: 3, y: 4, z: 5, pm: 6, perSet: 7, price: 8, quantity: 2, profitPct: 30, aluWeightKg: 9, breakdown: { alu: 10 }, extraCosts: { bracket: 1 } }, { id: 'b', resolved: false, quantity: 1 }], totals: { lineTotal: 16 } }
    const p = buildSnapshotPayload({ result, items: [{ id: 'a', opening_no: 'W1' }], factors: { wastePct: 5 } })
    expect(p.items[0]).toMatchObject({ opening_no: 'W1', price: 8, weight: 9, unresolved: false, cost: { alu: 10, bracket: 1 } })
    expect(p.items[1].unresolved).toBe(true)
    expect(p.totals).toEqual({ lineTotal: 16 }); expect(p.factors).toEqual({ wastePct: 5 })
  })
})

const lineMapComplete = (db, ids) => ids.every(id => {
  const l = db.tables.estimation_quotation_lines.find(x => x.opening_id === id)
  return l && db.tables.quotation_items.some(i => i.id === l.item_row_id) && db.tables.quotation_items.some(i => i.id === l.description_row_id)
})

describe('retry safety', () => {
  it('first send failing on the 2nd line insert, then retry: one quotation, no duplicate rows, complete map', async () => {
    const db = makeFake(); seed(db)
    const failing = makeFake({ table: 'estimation_quotation_lines', op: 'insert', nth: 2 }, db.tables)
    await expect(send(failing)).rejects.toThrow('boom estimation_quotation_lines')
    expect(db.tables.quotations).toHaveLength(1)
    expect(db.tables.estimation_quotation_links).toHaveLength(1)   // linked straight after create
    expect(db.tables.quotation_items).toHaveLength(2)                // the 2nd pair was rolled back
    const r = await send(db)
    expect(r.label).toBe('R1-1')
    expect(db.tables.quotations).toHaveLength(1)
    expect(db.tables.quotation_items).toHaveLength(4)
    expect(lineMapComplete(db, ['a', 'b'])).toBe(true)
    expect(db.tables.estimation_quotation_links).toHaveLength(1)
    expect(db.tables.estimation_quotation_links[0].last_pushed_at).toBeTruthy()
  })

  it('first send failing at step 6 (link update), then retry: still one quotation', async () => {
    const db = makeFake(); seed(db)
    const failing = makeFake({ table: 'estimation_quotation_links', op: 'update' }, db.tables)
    await expect(send(failing)).rejects.toThrow('boom estimation_quotation_links')
    expect(db.tables.estimation_price_snapshots).toHaveLength(1)
    await send(db)
    expect(db.tables.quotations).toHaveLength(1)
    expect(db.tables.quotation_items).toHaveLength(4)
    expect(lineMapComplete(db, ['a', 'b'])).toBe(true)
    expect(db.tables.estimation_quotation_links[0].last_pushed_at).toBeTruthy()
  })

  it('re-send adding an opening, failing on its map row, then retry: no duplicate pair', async () => {
    const db = makeFake(); seed(db)
    await send(db)
    const failing = makeFake({ table: 'estimation_quotation_lines', op: 'insert' }, db.tables)
    await expect(send(failing, { ids: ['a', 'b', 'c'] })).rejects.toThrow('boom')
    expect(db.tables.quotation_items).toHaveLength(4)
    await send(db, { ids: ['a', 'b', 'c'] })
    expect(db.tables.quotation_items).toHaveLength(6)
    expect(lineMapComplete(db, ['a', 'b', 'c'])).toBe(true)
  })

  it('pull-back retry after a failed status update does not double the history', async () => {
    const db = makeFake(); seed(db)
    const r1 = await send(db)
    Object.assign(qOf(db, r1.quotationId), { status: 'sent', revision: 1 })
    const failing = makeFake({ table: 'quotations', op: 'update' }, db.tables)
    await expect(send(failing)).rejects.toThrow('boom quotations')
    expect(db.tables.quotation_revisions).toHaveLength(1)
    const r2 = await send(db)
    expect(db.tables.quotation_revisions).toHaveLength(1)
    expect(r2.label).toBe('R2-1')
    expect(qOf(db, r1.quotationId)).toMatchObject({ status: 'draft', revision: 2 })
  })

  it('audit-logs the create and the pull-back', async () => {
    auditLog.mockClear()
    const db = makeFake(); seed(db)
    const r1 = await send(db)
    expect(auditLog).toHaveBeenCalledWith('quotations', r1.quotationId, 'INSERT', null, expect.objectContaining({ client_id: 'c1' }))
    Object.assign(qOf(db, r1.quotationId), { status: 'sent', revision: 1 })
    await send(db)
    expect(auditLog).toHaveBeenCalledWith('quotations', r1.quotationId, 'UPDATE', { status: 'sent', revision: 1 }, { status: 'draft', revision: 2 })
  })

  it('every description row is non-blank and item types are valid (fake enforces the check)', async () => {
    const db = makeFake(); seed(db)
    await send(db)
    expect(db.tables.quotation_items.filter(i => i.item_type === 'item_description').every(i => i.description.trim())).toBe(true)
  })
})
