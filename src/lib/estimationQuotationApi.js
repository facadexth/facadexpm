// src/lib/estimationQuotationApi.js
// Writes a price structure into the standard quotation tables (create / overwrite / pull back to draft).
// Every step is awaited and throws on the first error; nothing here swallows a failure.
import { addDays, format } from 'date-fns'
import { planPush, revisionLabel, snapshotFor } from './quotationExport.js'
import { pickDefaultBankAccount } from './defaultBankAccount.js'

const pick = (obj, cols) => Object.fromEntries(cols.filter(c => obj[c] !== undefined).map(c => [c, obj[c]]))
const must = ({ data, error }) => { if (error) throw error; return data }

const QUOTATION_COLS = ['client_id', 'site_name', 'date', 'valid_until', 'has_vat', 'price_includes_vat', 'discount_amount', 'discount_pct', 'pricing_mode', 'payment_terms', 'notes', 'bank_account_id']
const ITEM_COLS = ['quotation_id', 'catalog_item_id', 'description', 'quantity', 'unit', 'unit_price', 'unit_price_material', 'unit_price_labor', 'line_total', 'sort_order', 'item_type']
const ITEM_UPDATE_COLS = ITEM_COLS.filter(c => c !== 'quotation_id' && c !== 'catalog_item_id')
const LINE_COLS = ['project_id', 'opening_id', 'item_row_id', 'description_row_id']
const SNAPSHOT_COLS = ['project_id', 'quotation_id', 'kind', 'revision', 'sub_no', 'price_as_of', 'factors', 'items', 'totals']
const LINK_COLS = ['project_id', 'quotation_id', 'attach_enabled', 'attach_mode', 'attach_view', 'split_enabled', 'split_material_pct', 'last_pushed_at']

export const NO_LINES_MESSAGE = 'ใบเสนอราคานี้มีรายการอยู่แล้ว แต่ไม่พบข้อมูลบรรทัดที่ระบบเคยสร้างไว้ จึงไม่ส่งซ้ำเพื่อป้องกันรายการซ้ำ กรุณาติดต่อผู้ดูแลระบบ'

// Reads the quotation's current state from the database and plans the push. Throws (Thai message) when the push
// would risk duplicating rows. quotation: the linked quotations row or null.
export async function preparePlan({ supabase, project, quotation, newLines }) {
  const lineRows = must(await supabase.from('estimation_quotation_lines').select('*').eq('project_id', project.id)) || []
  const existingLines = lineRows.map(r => ({ openingId: r.opening_id, itemRowId: r.item_row_id, descRowId: r.description_row_id }))
  let items = []
  if (quotation) {
    items = must(await supabase.from('quotation_items').select('*').eq('quotation_id', quotation.id)) || []
    if (!lineRows.length && items.length) throw new Error(NO_LINES_MESSAGE)
  }
  const existingRowIds = new Set(items.map(i => i.id))
  const generated = new Set(existingLines.flatMap(l => [l.itemRowId, l.descRowId]).filter(Boolean))
  let invoiceRefs = new Set()
  const genIds = [...generated].filter(id => existingRowIds.has(id))
  if (genIds.length) {
    const refs = must(await supabase.from('invoice_items').select('quotation_item_id').in('quotation_item_id', genIds)) || []
    invoiceRefs = new Set(refs.map(r => r.quotation_item_id))
  }
  const userRows = items.filter(i => !generated.has(i.id)).map(i => ({ id: i.id, sort_order: i.sort_order }))
  const snapshots = must(await supabase.from('estimation_price_snapshots').select('*').eq('project_id', project.id)) || []
  return planPush({ quotation, existingLines, newLines, existingRowIds, invoiceRefs, userRows, snapshots })
}

// The jsonb written to estimation_price_snapshots. result = priceProject(...) output; items = the project's openings.
export function buildSnapshotPayload({ result, items, factors }) {
  const byId = new Map((items || []).map(i => [i.id, i]))
  return {
    factors: { ...(factors || {}) },
    items: (result.rows || []).map(r => {
      const b = r.breakdown || {}
      return {
        opening_id: r.id, opening_no: (byId.get(r.id) || {}).opening_no ?? null,
        cost: { alu: b.alu || 0, hardware: b.hardware || 0, glass: b.glass || 0, labour: b.labour || 0, other: b.other || 0, ...(r.extraCosts || {}) },
        v: r.v, w: r.w, x: r.x, y: r.y, z: r.z, pm: r.pm, perSet: r.perSet, price: r.price,
        quantity: r.quantity, profitPct: r.profitPct, weight: r.aluWeightKg, unresolved: !r.resolved,
      }
    }),
    totals: { ...(result.totals || {}) },
  }
}

// header: { client_id, site_name, date ('yyyy-MM-dd'), validDays, attach_enabled, attach_mode, attach_view, split_enabled, split_material_pct }
// plan: preparePlan output. lines: buildLines output (needed for the opening -> row map). Returns { quotationId, label }.
export async function pushToQuotation({ supabase, project, link, quotation, plan, header, lines, snapshotPayload, tenant }) {
  if (quotation && plan.action === 'create') throw new Error('แผนการส่งไม่ตรงกับสถานะใบเสนอราคา')
  if (!quotation && plan.action !== 'create') throw new Error('แผนการส่งไม่ตรงกับสถานะใบเสนอราคา')
  let quotationId = quotation ? quotation.id : null

  // (1) create the quotation, exactly as the Quotation form's save writes a new one
  if (plan.action === 'create') {
    const accounts = must(await supabase.from('bank_accounts').select('*')) || []
    const bank = pickDefaultBankAccount(accounts, true)
    const days = parseInt(header.validDays, 10)
    const payload = pick({
      client_id: header.client_id, site_name: header.site_name || null, date: header.date,
      valid_until: header.date && Number.isFinite(days) ? format(addDays(new Date(header.date), days), 'yyyy-MM-dd') : null,
      has_vat: true, price_includes_vat: false, discount_amount: null, discount_pct: null,
      pricing_mode: header.split_enabled ? 'split' : 'combined',
      payment_terms: (tenant && tenant.default_payment_terms) || null,
      notes: (tenant && tenant.default_notes) || null,
      bank_account_id: bank ? bank.id : null,
    }, QUOTATION_COLS)
    const row = must(await supabase.from('quotations').insert(payload).select().single())
    quotationId = row.id
  }

  // (2) pull back: keep the content being replaced in the same history the Quotation page uses
  if (plan.bumpRevision) {
    const q = must(await supabase.from('quotations').select('*, clients(name), bank_accounts(bank_name, account_name, account_no)').eq('id', quotationId).single())
    const cur = must(await supabase.from('quotation_items').select('*').eq('quotation_id', quotationId).order('sort_order'))
    must(await supabase.from('quotation_revisions').insert({ quotation_id: quotationId, revision: q.revision || 1, snapshot: snapshotFor(q, cur || []) }))
    must(await supabase.from('quotations').update({ status: plan.setStatus || 'draft', revision: plan.newRevision }).eq('id', quotationId))
  }

  // (3) quotation_items
  if (plan.deletes.length) must(await supabase.from('quotation_items').delete().in('id', plan.deletes.map(d => d.id)))
  const rowIdOf = new Map()   // `${openingId}:${kind}` -> quotation_items id
  for (const u of plan.updates) {
    must(await supabase.from('quotation_items').update(pick({ ...u.values, sort_order: u.sort_order }, ITEM_UPDATE_COLS)).eq('id', u.id))
    rowIdOf.set(`${u.openingId}:${u.kind}`, u.id)
  }
  if (plan.inserts.length) {
    const rows = plan.inserts.map(i => pick({ ...i.values, quotation_id: quotationId, catalog_item_id: null, sort_order: i.sort_order }, ITEM_COLS))
    const created = must(await supabase.from('quotation_items').insert(rows).select('id')) || []
    if (created.length !== plan.inserts.length) throw new Error('สร้างรายการในใบเสนอราคาไม่ครบ')
    plan.inserts.forEach((i, idx) => rowIdOf.set(`${i.openingId}:${i.kind}`, created[idx].id))
  }
  for (const k of [...(plan.keepOrder || []), ...(plan.userRowOrder || [])]) {
    must(await supabase.from('quotation_items').update({ sort_order: k.sort_order }).eq('id', k.id))
  }

  // (4) estimation_quotation_lines: look up, then insert or update (no upsert)
  const existing = must(await supabase.from('estimation_quotation_lines').select('*').eq('project_id', project.id)) || []
  const existingByOpening = new Map(existing.map(r => [r.opening_id, r]))
  for (const l of lines) {
    const vals = { item_row_id: rowIdOf.get(`${l.openingId}:item`) || null, description_row_id: rowIdOf.get(`${l.openingId}:desc`) || null }
    const e = existingByOpening.get(l.openingId)
    if (e) must(await supabase.from('estimation_quotation_lines').update(vals).eq('id', e.id))
    else must(await supabase.from('estimation_quotation_lines').insert(pick({ project_id: project.id, opening_id: l.openingId, ...vals }, LINE_COLS)))
  }
  const keptOpenings = new Set(plan.keeps.map(k => k.openingId))
  const goneOpenings = [...new Set(plan.deletes.map(d => d.openingId))].filter(o => !keptOpenings.has(o) && existingByOpening.has(o))
  for (const o of goneOpenings) must(await supabase.from('estimation_quotation_lines').delete().eq('id', existingByOpening.get(o).id))

  // (5) append-only snapshot of what was sent
  must(await supabase.from('estimation_price_snapshots').insert(pick({
    project_id: project.id, quotation_id: quotationId, kind: 'sent', revision: plan.newRevision, sub_no: plan.subNo,
    price_as_of: project.price_as_of || null, factors: snapshotPayload.factors, items: snapshotPayload.items, totals: snapshotPayload.totals,
  }, SNAPSHOT_COLS)))

  // (6) the link
  const linkVals = pick({
    project_id: project.id, quotation_id: quotationId,
    attach_enabled: header.attach_enabled, attach_mode: header.attach_mode, attach_view: header.attach_view,
    split_enabled: !!header.split_enabled, split_material_pct: header.split_material_pct,
    last_pushed_at: new Date().toISOString(),
  }, LINK_COLS)
  if (link) must(await supabase.from('estimation_quotation_links').update(linkVals).eq('id', link.id))
  else must(await supabase.from('estimation_quotation_links').insert(linkVals))

  return { quotationId, label: revisionLabel(plan.newRevision, plan.subNo) }
}
