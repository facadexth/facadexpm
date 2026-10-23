// Delivery report (รายงานส่งงาน, DR) data hook + writes. Plan B task 3.
// Flat queries joined on the client (no PostgREST embeds: avoids ambiguous-FK failures).
import { supabase } from '../lib/supabase.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
import { useQuery } from './useSupabase.js'
import { fetchProgressBillingData } from './useProgressBillingData.js'
import { buildReportRows } from '../lib/deliveryReport.js'
import { discountMultiplier } from '../lib/quotationCalc.js'
import { bangkokTodayIso } from '../lib/photoUpload.js'

const CHUNK = 200
const ITEM_COLS = 'id, invoice_id, quotation_item_id, description, unit, draw_qty, unit_price, line_total'

async function fetchIn(table, cols, column, ids, orderCol = 'id') {
  let all = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    all = all.concat(await fetchAllRows(() => supabase.from(table).select(cols).in(column, chunk).order(orderCol, { ascending: true })))
  }
  return all
}

// Supabase errors (incl. the signed-report lock trigger message) surfaced as plain Errors.
function check(error) {
  if (error) throw new Error(error.message || String(error))
}

// By (date, invoice_number). When either date is missing, fall back to the number only
// rather than sorting the undated invoice before everything.
function cmpInvoice(a, b) {
  const ad = a.date, bd = b.date
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1
  return String(a.invoice_number ?? '').localeCompare(String(b.invoice_number ?? ''), undefined, { numeric: true })
}

// Earlier invoices of the same quotation: non-void, strictly before `current` by (date, number), ascending.
export function earlierInvoicesOf(invoices, current) {
  return (invoices || [])
    .filter(i => i.id !== current.id && i.quotation_id === current.quotation_id && i.status !== 'void'
      && cmpInvoice(i, current) < 0)
    .sort(cmpInvoice)
}

export async function fetchDeliveryReport(invoiceId, reportId = null) {
  if (!invoiceId) return null
  const [invoice] = await fetchAllRows(() => supabase.from('invoices')
    .select('id, invoice_number, date, quotation_id, site_id, status').eq('id', invoiceId).order('id', { ascending: true }))
  if (!invoice) throw new Error('ไม่พบใบแจ้งหนี้')
  const { site_id: siteId, quotation_id: quotationId } = invoice

  const [invoiceItems, sameQuotation, quotations, qItems, reports, tasks, plans, pb] = await Promise.all([
    fetchAllRows(() => supabase.from('invoice_items').select(ITEM_COLS).eq('invoice_id', invoiceId).order('id', { ascending: true })),
    quotationId ? fetchAllRows(() => supabase.from('invoices').select('id, invoice_number, date, quotation_id, status')
      .eq('quotation_id', quotationId).order('id', { ascending: true })) : [],
    quotationId ? fetchAllRows(() => supabase.from('quotations').select('id, discount_amount, discount_pct').eq('id', quotationId).order('id', { ascending: true })) : [],
    quotationId ? fetchAllRows(() => supabase.from('quotation_items').select('id, description, unit_price, line_total')
      .eq('quotation_id', quotationId).order('id', { ascending: true })) : [],
    fetchAllRows(() => supabase.from('delivery_reports').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: false })),
    siteId ? fetchAllRows(() => supabase.from('phase_tasks')
      .select('id, phase_id, site_id, name, status, progress_mode, boq_item_id, planned_qty, done_qty')
      .eq('site_id', siteId).order('id', { ascending: true })) : [],
    siteId ? fetchAllRows(() => supabase.from('site_drawings').select('*').eq('site_id', siteId).order('sort_order', { ascending: true })) : [],
    fetchProgressBillingData(siteId, quotationId),
  ])

  const earlier = earlierInvoicesOf(sameQuotation, invoice)
  const earlierIds = earlier.map(i => i.id)
  const rank = new Map(earlierIds.map((id, i) => [id, i]))
  const earlierItems = earlierIds.length
    ? (await fetchIn('invoice_items', ITEM_COLS, 'invoice_id', earlierIds)).sort((a, b) => rank.get(a.invoice_id) - rank.get(b.invoice_id))
    : []
  const allItemIds = [...invoiceItems, ...earlierItems].map(i => i.id)
  const allPhases = allItemIds.length
    ? await fetchIn('invoice_item_phases', 'id, invoice_item_id, boq_item_id, phase_id, qty, amount', 'invoice_item_id', allItemIds)
    : []
  const thisIds = new Set(invoiceItems.map(i => i.id))
  const itemPhases = allPhases.filter(p => thisIds.has(p.invoice_item_id))
  const earlierItemPhases = allPhases.filter(p => !thisIds.has(p.invoice_item_id))

  // BOQ lines carry the quotation's discounted unit price + description (needed by buildReportRows).
  const mult = discountMultiplier({ ...(quotations[0] || {}), quotation_items: qItems })
  const qiById = new Map(qItems.map(q => [q.id, q]))
  const boqByQuotationItem = {}
  for (const [qiId, b] of Object.entries(pb?.boqByQuotationItem || {})) {
    const qi = qiById.get(qiId)
    boqByQuotationItem[qiId] = { ...b, unit_price: (Number(qi?.unit_price) || 0) * mult, description: qi?.description ?? '' }
  }
  const boqCards = tasks.filter(t => t.boq_item_id)

  const { rows, totals } = buildReportRows({
    invoice, invoiceItems, itemPhases, earlierItems, earlierItemPhases,
    boqByQuotationItem, splitsByBoq: pb?.splitsByBoq || {}, phases: pb?.phases || [], cards: boqCards,
  })

  const current = reports.find(r => r.status !== 'replaced' && r.status !== 'void') || null
  // The requested report (defaults to current): its cards are what the document prints.
  const report = (reportId && reports.find(r => r.id === reportId)) || current
  const replacedBy = report ? reports.find(r => r.replaces_id === report.id) || null : null
  const reportCards = report
    ? await fetchAllRows(() => supabase.from('delivery_report_cards').select('*').eq('report_id', report.id).order('sort_order', { ascending: true }))
    : []

  // "Delivered before" on plans = cards in issued/signed reports of the earlier invoices.
  const earlierReports = earlierIds.length
    ? (await fetchIn('delivery_reports', 'id, invoice_id, status', 'invoice_id', earlierIds)).filter(r => r.status === 'issued' || r.status === 'signed')
    : []
  const earlierCards = earlierReports.length
    ? await fetchIn('delivery_report_cards', 'id, report_id, task_id', 'report_id', earlierReports.map(r => r.id))
    : []
  const prevTaskIds = [...new Set(earlierCards.map(c => c.task_id).filter(Boolean))]

  const [site] = siteId
    ? await fetchAllRows(() => supabase.from('sites').select('*').eq('id', siteId).order('id', { ascending: true }))
    : []

  const taskIds = tasks.map(t => t.id)
  const photos = taskIds.length
    ? await fetchIn('line_site_photos', 'id, task_id, photo_path, date', 'task_id', taskIds)
    : []
  const photosByTask = {}
  for (const p of photos) (photosByTask[p.task_id] ||= []).push(p)

  const marks = plans.length ? await fetchIn('site_drawing_marks', '*', 'plan_id', plans.map(p => p.id)) : []
  const marksByPlan = {}
  for (const m of marks) (marksByPlan[m.plan_id] ||= []).push(m)

  return {
    invoice, reports, current, report, replacedBy, prevTaskIds, site: site || null, rows, totals,
    cards: reportCards, tasks, phases: pb?.phases || [],
    photosByTask, plans, marksByPlan,
  }
}

export function useDeliveryReport(invoiceId, reportId = null) {
  return useQuery(() => fetchDeliveryReport(invoiceId, reportId), [invoiceId, reportId])
}

// Insert-then-remove: capture old ids, insert the new rows, then remove only the old ids, so a
// failed insert leaves the existing rows untouched. Errors (incl. the signed-report lock) rethrown.
async function replaceRows(table, parentCol, parentId, rows) {
  const old = await fetchAllRows(() => supabase.from(table).select('id').eq(parentCol, parentId).order('id', { ascending: true }))
  let inserted = []
  if (rows.length) {
    const { data, error } = await supabase.from(table).insert(rows).select()
    check(error)
    inserted = data || []
  }
  if (old.length) {
    const { error } = await supabase.from(table).delete().in('id', old.map(r => r.id))
    check(error)
  }
  return inserted
}

async function replaceCards(reportId, cards) {
  const rows = cards.map((c, i) => ({
    report_id: reportId, task_id: c.taskId ?? null, card_title: c.cardTitle,
    photo_ids: c.photoIds || [], caption: c.caption ?? null, sort_order: i,
  }))
  await replaceRows('delivery_report_cards', 'report_id', reportId, rows)
}

async function insertReport(fields) {
  const { data, error } = await supabase.from('delivery_reports').insert(fields).select().single()
  check(error)
  return data
}

export async function saveDeliveryReport({ reportId = null, invoiceId, siteId, phaseIds, note, cards }) {
  let report
  if (reportId) {
    const { data, error } = await supabase.from('delivery_reports')
      .update({ phase_ids: phaseIds || [], note: note ?? null }).eq('id', reportId).select().single()
    check(error)
    report = data
  } else {
    report = await insertReport({
      invoice_id: invoiceId, site_id: siteId, phase_ids: phaseIds || [], note: note ?? null,
      status: 'draft', date: bangkokTodayIso(),
    })
  }
  await replaceCards(report.id, cards)
  return report
}

export async function reissueDeliveryReport(oldReport, draft) {
  const report = await insertReport({
    invoice_id: oldReport.invoice_id, site_id: oldReport.site_id, replaces_id: oldReport.id,
    phase_ids: draft.phaseIds || [], note: draft.note ?? null, status: 'draft', date: bangkokTodayIso(),
  })
  try {
    await replaceCards(report.id, draft.cards)
    const { data, error } = await supabase.from('delivery_reports').update({ status: 'replaced' }).eq('id', oldReport.id).select()
    check(error)
    if (!data?.length) throw new Error('เปลี่ยนสถานะรายงานเดิมไม่สำเร็จ')
  } catch (e) {
    // roll back the new draft (its cards cascade) so a retry doesn't leave a second draft
    const { error: rbErr } = await supabase.from('delivery_reports').delete().eq('id', report.id)
    if (rbErr) console.error('reissue rollback failed for', report.id, rbErr)
    throw e
  }
  return report
}

async function updateOne(id, fields) {
  const { data, error } = await supabase.from('delivery_reports').update(fields).eq('id', id).select()
  check(error)
  if (!data?.length) throw new Error('บันทึกไม่สำเร็จ (ไม่มีสิทธิ์หรือรายงานถูกล็อก)')
  return data[0]
}

export function markDeliveryReportIssued(id) {
  return updateOne(id, { status: 'issued' })
}

// Local signing paths (this device / paper photo): lock the report with the receipt.
export function markDeliveryReportSigned(id, receiptId) {
  return updateOne(id, { status: 'signed', signed_at: new Date().toISOString(), signed_receipt_id: receiptId })
}

export function markSignedSeen(id) {
  return updateOne(id, { signed_seen_at: new Date().toISOString() })
}

// Invoices list: newest live (non-replaced/void) report per invoice, ONE query for all rows.
export async function fetchDeliveryReportStatuses(invoiceIds) {
  const ids = [...new Set((invoiceIds || []).filter(Boolean))]
  if (!ids.length) return {}
  const { data, error } = await supabase.from('delivery_reports')
    .select('id, invoice_id, status, signed_at, signed_seen_at, created_at').in('invoice_id', ids)
  check(error)
  const out = {}
  for (const r of [...(data || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (r.status === 'replaced' || r.status === 'void' || out[r.invoice_id]) continue
    out[r.invoice_id] = r
  }
  return out
}

// One update for many reports (opening the invoices tab clears the bell for shown signed reports).
export async function markSignedSeenMany(ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return
  const { error } = await supabase.from('delivery_reports').update({ signed_seen_at: new Date().toISOString() }).in('id', list)
  check(error)
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

async function imageSize(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const size = { width: bmp.width, height: bmp.height }
  bmp.close?.()
  return size
}

// Page 1 of a one-page PDF -> PNG blob. pdf.js is loaded only here (lazy, its own chunk).
async function pdfToPng(file) {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  try {
    if (doc.numPages > 1) throw new Error('รองรับ PDF หน้าเดียว')
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    const blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('แปลง PDF ไม่สำเร็จ'))), 'image/png'))
    return { blob, width: canvas.width, height: canvas.height }
  } finally {
    doc.destroy?.()
  }
}

export async function uploadSiteDrawing({ siteId, tenantId, file }) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
  let blob, width, height, mime, ext
  if (isPdf) {
    ({ blob, width, height } = await pdfToPng(file))
    mime = 'image/png'
    ext = 'png'
  } else if (IMAGE_TYPES.includes(file.type)) {
    ({ width, height } = await imageSize(file))
    blob = file
    mime = file.type
    ext = mime.split('/')[1].replace('jpeg', 'jpg')
  } else {
    throw new Error('รองรับเฉพาะรูปภาพ หรือ PDF หน้าเดียว')
  }
  const base = String(file.name || 'plan').replace(/\.[^.]*$/, '')
  const safeName = (base.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'plan') + '.' + ext
  const path = `${tenantId}/${siteId}/${Date.now()}-${safeName}`
  const { error: upErr } = await supabase.storage.from('site-drawings').upload(path, blob, { contentType: mime })
  check(upErr)
  const { data, error } = await supabase.from('site_drawings')
    .insert({ tenant_id: tenantId, site_id: siteId, title: base || 'แบบ', file_path: path, mime, width, height })
    .select().single()
  if (error) {
    const { error: rmErr } = await supabase.storage.from('site-drawings').remove([path])
    if (rmErr) console.error('orphan cleanup failed for', path, rmErr)
    check(error)
  }
  return data
}

export async function saveSiteDrawingMarks(planId, marks) {
  const rows = (marks || []).map(m => ({
    plan_id: planId, task_id: m.task_id ?? m.taskId ?? null, kind: m.kind,
    x: m.x, y: m.y, w: m.w ?? null, h: m.h ?? null, label: m.label ?? null,
  }))
  return replaceRows('site_drawing_marks', 'plan_id', planId, rows)
}
