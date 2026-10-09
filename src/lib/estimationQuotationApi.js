// src/lib/estimationQuotationApi.js
// Writes a price structure into the standard quotation tables (create / overwrite / pull back to draft).
// Every step is awaited and throws on the first error; nothing here swallows a failure.
import { addDays, format } from 'date-fns'
import { planPush, revisionLabel, snapshotFor } from './quotationExport.js'
import { pickDefaultBankAccount } from './defaultBankAccount.js'
import { auditLog } from './audit.js'

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
export async function preparePlan({ supabase, project, quotation, newLines, projectOpeningIds = null, skippedOpeningIds = null }) {
  const lineRows = must(await supabase.from('estimation_quotation_lines').select('*').eq('project_id', project.id)) || []
  const existingLines = lineRows.map(r => ({ id: r.id, openingId: r.opening_id, itemRowId: r.item_row_id, descRowId: r.description_row_id }))
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
  return planPush({ quotation, existingLines, newLines, existingRowIds, invoiceRefs, userRows, snapshots, projectOpeningIds, skippedOpeningIds: skippedOpeningIds || new Set() })
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

// Reads the project's link and the quotation it points to, fresh from the database. A link whose quotation was
// deleted yields { link, quotation: null }. Always call this right before preparePlan (never trust a cached link: a
// failed earlier attempt may already have written it).
export async function loadLinkedQuotation({ supabase, project }) {
  const link = must(await supabase.from('estimation_quotation_links').select('*').eq('project_id', project.id).maybeSingle())
  let quotation = null
  if (link && link.quotation_id) quotation = must(await supabase.from('quotations').select('*, clients(name)').eq('id', link.quotation_id).maybeSingle())
  return { link: link || null, quotation: quotation || null }
}

// header: { client_id, site_name, date ('yyyy-MM-dd'), validDays, attach_enabled, attach_mode, attach_view, split_enabled, split_material_pct }
// plan: preparePlan output. lines: buildLines output. link/quotation: from loadLinkedQuotation. Returns { quotationId, label }.
//
// Retry safety: the link is written right after the quotation is created (so a retry finds it), and every generated
// pair is mapped in estimation_quotation_lines immediately after it is inserted. The only unmapped-generated-row window
// is between those two statements of one pair; if the map write fails the pair is deleted again (best effort) before the
// error is rethrown. Only if that delete also fails can a retry see the pair as a user row.
export async function pushToQuotation({ supabase, project, link, quotation, plan, header, lines, snapshotPayload, tenant }) {
  if (quotation && plan.action === 'create') throw new Error('แผนการส่งไม่ตรงกับสถานะใบเสนอราคา')
  if (!quotation && plan.action !== 'create') throw new Error('แผนการส่งไม่ตรงกับสถานะใบเสนอราคา')
  let quotationId = quotation ? quotation.id : null
  let linkId = link ? link.id : null
  const linkOptions = pick({
    attach_enabled: header.attach_enabled, attach_mode: header.attach_mode, attach_view: header.attach_view,
    split_enabled: !!header.split_enabled, split_material_pct: header.split_material_pct,
  }, LINK_COLS)

  // (1) create the quotation, exactly as the Quotation form's save writes a new one, and link it at once
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
    await auditLog('quotations', quotationId, 'INSERT', null, payload)
    if (linkId) must(await supabase.from('estimation_quotation_links').update({ quotation_id: quotationId }).eq('id', linkId))
    else {
      const l = must(await supabase.from('estimation_quotation_links').insert(pick({ project_id: project.id, quotation_id: quotationId, ...linkOptions }, LINK_COLS)).select().single())
      linkId = l.id
    }
  }

  // (2) pull back: keep the content being replaced in the same history the Quotation page uses
  if (plan.bumpRevision) {
    const q = must(await supabase.from('quotations').select('*, clients(name), bank_accounts(bank_name, account_name, account_no)').eq('id', quotationId).single())
    const oldRevision = q.revision || 1
    const have = must(await supabase.from('quotation_revisions').select('id').eq('quotation_id', quotationId).eq('revision', oldRevision)) || []
    if (!have.length) {   // a retry after a failed status update must not double the history
      const cur = must(await supabase.from('quotation_items').select('*').eq('quotation_id', quotationId).order('sort_order'))
      must(await supabase.from('quotation_revisions').insert({ quotation_id: quotationId, revision: oldRevision, snapshot: snapshotFor(q, cur || []) }))
    }
    must(await supabase.from('quotations').update({ status: plan.setStatus || 'draft', revision: plan.newRevision }).eq('id', quotationId))
    await auditLog('quotations', quotationId, 'UPDATE', { status: q.status, revision: oldRevision }, { status: plan.setStatus || 'draft', revision: plan.newRevision })
  }

  // (3) quotation_items + (4) the line map, pair by pair
  if (plan.deletes.length) must(await supabase.from('quotation_items').delete().in('id', plan.deletes.map(d => d.id)))
  const rowIdOf = new Map()   // `${openingId}:${kind}` -> quotation_items id
  for (const u of plan.updates) {
    must(await supabase.from('quotation_items').update(pick({ ...u.values, sort_order: u.sort_order }, ITEM_UPDATE_COLS)).eq('id', u.id))
    rowIdOf.set(`${u.openingId}:${u.kind}`, u.id)
  }
  const existing = must(await supabase.from('estimation_quotation_lines').select('*').eq('project_id', project.id)) || []
  const existingByOpening = new Map(existing.map(r => [r.opening_id, r]))
  for (const l of lines) {
    const mine = plan.inserts.filter(i => i.openingId === l.openingId)
    let createdIds = []
    if (mine.length) {
      const rows = mine.map(i => pick({ ...i.values, quotation_id: quotationId, catalog_item_id: null, sort_order: i.sort_order }, ITEM_COLS))
      const created = must(await supabase.from('quotation_items').insert(rows).select('id')) || []
      if (created.length !== mine.length) throw new Error('สร้างรายการในใบเสนอราคาไม่ครบ')
      createdIds = created.map(c => c.id)
      mine.forEach((i, idx) => rowIdOf.set(`${l.openingId}:${i.kind}`, createdIds[idx]))
    }
    const vals = { item_row_id: rowIdOf.get(`${l.openingId}:item`) || null, description_row_id: rowIdOf.get(`${l.openingId}:desc`) || null }
    const e = existingByOpening.get(l.openingId)
    try {
      if (e && e.item_row_id === vals.item_row_id && e.description_row_id === vals.description_row_id) continue
      if (e) must(await supabase.from('estimation_quotation_lines').update(vals).eq('id', e.id))
      else must(await supabase.from('estimation_quotation_lines').insert(pick({ project_id: project.id, opening_id: l.openingId, ...vals }, LINE_COLS)))
    } catch (err) {
      if (createdIds.length) { try { await supabase.from('quotation_items').delete().in('id', createdIds) } catch { /* best effort */ } }
      throw err
    }
  }
  for (const k of [...(plan.keepOrder || []), ...(plan.userRowOrder || [])]) {
    must(await supabase.from('quotation_items').update({ sort_order: k.sort_order }).eq('id', k.id))
  }
  const keptLineIds = new Set(plan.keeps.map(k => k.lineId || (existingByOpening.get(k.openingId) || {}).id).filter(Boolean))
  const goneLineIds = new Set(plan.deletes.map(d => d.lineId || (existingByOpening.get(d.openingId) || {}).id).filter(id => id && !keptLineIds.has(id)))
  for (const id of goneLineIds) must(await supabase.from('estimation_quotation_lines').delete().eq('id', id))

  // (5) append-only snapshot of what was sent
  must(await supabase.from('estimation_price_snapshots').insert(pick({
    project_id: project.id, quotation_id: quotationId, kind: 'sent', revision: plan.newRevision, sub_no: plan.subNo,
    price_as_of: project.price_as_of || null, factors: snapshotPayload.factors, items: snapshotPayload.items, totals: snapshotPayload.totals,
  }, SNAPSHOT_COLS)))

  // (6) the link: options and push time
  must(await supabase.from('estimation_quotation_links').update({ ...linkOptions, quotation_id: quotationId, last_pushed_at: new Date().toISOString() }).eq('id', linkId))

  return { quotationId, label: revisionLabel(plan.newRevision, plan.subNo) }
}
