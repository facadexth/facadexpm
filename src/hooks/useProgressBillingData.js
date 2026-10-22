// Everything the "ตามความคืบหน้า" invoice editor needs for one site + quotation: the BOQ
// lines of that quotation, their % per phase, the site's phases (no issue phases), the cards
// tied to BOQ lines, and earlier per-phase draws with their invoice's status (void draws are
// dropped later by deliveredBefore). The draws are joined on the client from three flat
// queries instead of a nested PostgREST embed (avoids ambiguous-FK embed failures).
import { supabase } from '../lib/supabase.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
import { useQuery } from './useSupabase.js'
import { fetchBoqPhaseSplits, SPLIT_ID_CHUNK } from '../pages/sites/useBoqPhaseSplits.js'

async function fetchIn(table, cols, column, ids) {
  let all = []
  for (let i = 0; i < ids.length; i += SPLIT_ID_CHUNK) {
    const chunk = ids.slice(i, i + SPLIT_ID_CHUNK)
    all = all.concat(await fetchAllRows(() => supabase.from(table).select(cols).in(column, chunk).order('id', { ascending: true })))
  }
  return all
}

export async function fetchProgressBillingData(siteId, quotationId) {
  if (!siteId || !quotationId) return null
  const [qItems, boqRows, phases, cardRows] = await Promise.all([
    fetchAllRows(() => supabase.from('quotation_items').select('id').eq('quotation_id', quotationId).order('id', { ascending: true })),
    fetchAllRows(() => supabase.from('boq_items').select('id, quotation_item_id, code, unit, planned_qty').eq('site_id', siteId).order('id', { ascending: true })),
    fetchAllRows(() => supabase.from('site_phases').select('id, name, sort_order').eq('site_id', siteId).eq('is_issue_phase', false)
      .order('sort_order', { ascending: true }).order('id', { ascending: true })),
    fetchAllRows(() => supabase.from('phase_tasks').select('id, boq_item_id, phase_id, done_qty, planned_qty, progress_mode, name')
      .eq('site_id', siteId).not('boq_item_id', 'is', null).order('id', { ascending: true })),
  ])

  const qiIds = new Set(qItems.map(r => r.id))
  const boqByQuotationItem = {}
  for (const b of boqRows) {
    if (!qiIds.has(b.quotation_item_id)) continue
    boqByQuotationItem[b.quotation_item_id] = { id: b.id, unit: b.unit, planned_qty: b.planned_qty, code: b.code }
  }
  const boqIds = Object.values(boqByQuotationItem).map(b => b.id)
  const boqSet = new Set(boqIds)

  const splitsByBoq = {}
  const splits = boqIds.length ? await fetchBoqPhaseSplits(boqIds) : []
  for (const s of splits) (splitsByBoq[s.boq_item_id] ||= []).push({ phase_id: s.phase_id, pct: s.pct })

  const cards = cardRows.filter(c => boqSet.has(c.boq_item_id)).map(c => ({
    boq_item_id: c.boq_item_id, phase_id: c.phase_id, done_qty: c.done_qty,
    planned_qty: c.planned_qty, progress_mode: c.progress_mode, name: c.name,
  }))

  let phaseDraws = []
  if (boqIds.length) {
    const draws = await fetchIn('invoice_item_phases', 'id, invoice_item_id, boq_item_id, phase_id, qty', 'boq_item_id', boqIds)
    const items = draws.length ? await fetchIn('invoice_items', 'id, invoice_id', 'id', [...new Set(draws.map(d => d.invoice_item_id))]) : []
    const invoices = items.length ? await fetchIn('invoices', 'id, status', 'id', [...new Set(items.map(i => i.invoice_id))]) : []
    const invOfItem = new Map(items.map(i => [i.id, i.invoice_id]))
    const statusOf = new Map(invoices.map(i => [i.id, i.status]))
    phaseDraws = draws.map(d => ({
      boq_item_id: d.boq_item_id, phase_id: d.phase_id, qty: d.qty,
      invoice_status: statusOf.get(invOfItem.get(d.invoice_item_id)) ?? null,
    }))
  }

  return {
    boqByQuotationItem,
    splitsByBoq,
    phases: phases.map(p => ({ id: p.id, name: p.name, sort_order: p.sort_order })),
    cards,
    phaseDraws,
  }
}

export function useProgressBillingData(siteId, quotationId) {
  return useQuery(() => fetchProgressBillingData(siteId, quotationId), [siteId, quotationId])
}
