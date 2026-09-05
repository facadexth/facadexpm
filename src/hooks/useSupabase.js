// ============================================================
// Custom hook สำหรับ fetch ข้อมูลจาก Supabase
// รองรับ loading / error state และ refetch
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { applyDateFilter } from '../lib/expenseFilters.js'
import { buildUnitSeedRows } from '../lib/invoiceCalc.js'

/** Generic fetch hook */
export function useQuery(queryFn, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await queryFn()
      setData(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, deps) // eslint-disable-line

  useEffect(() => { fetch() }, [fetch])

  return { data, loading, error, refetch: fetch }
}

/**
 * Supabase/PostgREST caps a single response at 1000 rows by default.
 * This walks `.range()` pages until a short page signals the end, so
 * list hooks return every matching row instead of silently truncating
 * past row 1000. `buildQuery` must return a fresh query each call
 * (query builders can't be re-awaited after their first request).
 */
async function fetchAllRows(buildQuery, pageSize = 1000) {
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    allRows = allRows.concat(data)
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return allRows
}

// ── Sites ────────────────────────────────────────────────────

export function useSites() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('site_financial_summary')  // ใช้ view ที่รวม income/expense แล้ว
      .select('*')
      .order('site_number')
    if (error) throw error
    return data
  })
}

export function useSite(id) {
  return useQuery(async () => {
    if (!id) return null
    const { data, error } = await supabase
      .from('sites').select('*').eq('id', id).single()
    if (error) throw error
    return data
  }, [id])
}

/**
 * site_retention_summary: one row per site with end_date/
 * default_retention_period_days/retention_released state and the summed
 * retention amount held. Sorted unreleased-first (retention_released
 * ascending puts false before true), then soonest due date first within
 * each group (nulls last, since a site with no period set has nothing
 * useful to sort by).
 */
export function useSiteRetentionSummary() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('site_retention_summary')
      .select('*')
      .order('retention_released', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    return data
  })
}

export function useSiteDepositSummary() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('site_deposit_summary')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}

export function useSiteDepositBalance(siteId) {
  return useQuery(async () => {
    if (!siteId) return null
    const { data, error } = await supabase
      .from('site_deposit_summary')
      .select('*')
      .eq('site_id', siteId)
      .single()
    if (error) throw error
    return data
  }, [siteId])
}

/**
 * useSiteOverview: one site's full picture for the Site Overview modal --
 * merges site_financial_summary (contract/income/expense/profit) with
 * nested .deposit (site_deposit_summary row) and .retention
 * (site_retention_summary row) for the same site, fetched in parallel.
 */
export function useSiteOverview(siteId) {
  return useQuery(async () => {
    if (!siteId) return null
    const [siteRes, depositRes, retentionRes] = await Promise.all([
      supabase.from('site_financial_summary').select('*').eq('id', siteId).single(),
      supabase.from('site_deposit_summary').select('*').eq('site_id', siteId).single(),
      supabase.from('site_retention_summary').select('*').eq('site_id', siteId).single(),
    ])
    if (siteRes.error) throw siteRes.error
    if (depositRes.error) throw depositRes.error
    if (retentionRes.error) throw retentionRes.error
    return { ...siteRes.data, deposit: depositRes.data, retention: retentionRes.data }
  }, [siteId])
}

/**
 * ค่าใช้จ่ายทั้งหมด (all-time) ของไซท์นี้ พร้อม category_name -- ใช้ทำ pie
 * chart ใน SiteOverviewModal. Appends real company-worker labor cost
 * (site_financial_summary.worker_labor_cost) as one synthetic category so
 * the pie's total matches total_expense, which folds worker cost in too.
 * Subcontractor labor cost is NOT synthesized here -- since
 * 2026-08-29-02-subcontractor-labor-cost-from-real-expenses.sql it's a
 * real `expenses` row (category "ค่าแรง", is_subcontract = true) created
 * when a payment is marked paid, so it already comes through
 * expenses_view like any other expense.
 */
export function useSiteExpensesByCategory(siteId) {
  return useQuery(async () => {
    if (!siteId) return []
    const [expensesRes, summaryRes] = await Promise.all([
      supabase.from('expenses_view').select('category_name, amount').eq('site_id', siteId),
      supabase.from('site_financial_summary').select('worker_labor_cost').eq('id', siteId).single(),
    ])
    if (expensesRes.error) throw expensesRes.error
    if (summaryRes.error) throw summaryRes.error
    const rows = [...expensesRes.data]
    if (summaryRes.data?.worker_labor_cost > 0) {
      rows.push({ category_name: 'ค่าแรงพนักงาน', amount: summaryRes.data.worker_labor_cost })
    }
    return rows
  }, [siteId])
}

// ── Expenses ─────────────────────────────────────────────────

export function useExpenses(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('expenses_view')
        .select('*')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.siteId)   q = q.eq('site_id', filters.siteId)
      if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
      if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
      // 'unpaid' is a pseudo-status (not a real DB value) meaning "still
      // owed" -- matches payment_forecast's own WHERE clause, so a KPI
      // built from that view can link here with an exactly-matching filter.
      if (filters.status === 'unpaid') q = q.in('status', ['pending', 'check_issued'])
      else if (filters.status)         q = q.eq('status', filters.status)
      if (filters.search)   q = q.ilike('description', `%${filters.search}%`)

      // dateField: 'date' (วันที่สั่งซื้อ, default) | 'billing_date' (วันวางบิล)
      // | 'due' (วันครบกำหนด — due_date for credit rows, check_date for cheque rows)
      q = applyDateFilter(q, filters.dateField || 'date', filters.from, filters.to)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

export function usePurchaseOrders(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('purchase_orders')
        .select('*, sites(name, site_number), suppliers(name, supplier_number, credit_days), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total, inventory_item_id, aluminum_profile_id, rod_length_m, glass_width_m, glass_height_m), purchase_order_attachments(id)')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.siteId)     q = q.eq('site_id', filters.siteId)
      if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
      if (filters.status)     q = q.eq('status', filters.status)
      if (filters.from)       q = q.gte('date', filters.from)
      if (filters.to)         q = q.lte('date', filters.to)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

export function useQuotations(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('quotations')
        .select('*, clients(name, client_number, address, tax_id), sites(name, site_number), bank_accounts(bank_name, account_name, account_no), quotation_items(id, catalog_item_id, description, unit, quantity, unit_price, line_total, sort_order, item_type)')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.clientId) q = q.eq('client_id', filters.clientId)
      if (filters.siteId)   q = q.eq('site_id', filters.siteId)
      if (filters.status)   q = q.eq('status', filters.status)
      if (filters.from)     q = q.gte('date', filters.from)
      if (filters.to)       q = q.lte('date', filters.to)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

// Idempotent: only inserts rows for quotation_items that don't have any
// quotation_item_units yet. Safe to call every time the invoice
// item-selection screen opens for a quotation.
export async function ensureQuotationItemUnits(quotationItems) {
  const ids = (quotationItems || []).map(qi => qi.id)
  if (!ids.length) return

  const { data: existing, error: fetchError } = await supabase
    .from('quotation_item_units')
    .select('quotation_item_id')
    .in('quotation_item_id', ids)
  if (fetchError) throw fetchError

  const alreadySeeded = new Set((existing || []).map(r => r.quotation_item_id))
  const toSeed = quotationItems.filter(qi => !alreadySeeded.has(qi.id))
  if (!toSeed.length) return

  const rows = toSeed.flatMap(buildUnitSeedRows)
  const { error: insertError } = await supabase.from('quotation_item_units').insert(rows)
  if (insertError) throw insertError
}

export function useQuotationItemUnits(quotationId, quotationItems) {
  return useQuery(async () => {
    if (!quotationId || !(quotationItems || []).length) return {}
    await ensureQuotationItemUnits(quotationItems)

    const { data, error } = await supabase
      .from('quotation_item_units')
      .select('*')
      .in('quotation_item_id', quotationItems.map(qi => qi.id))
      .order('unit_index')
    if (error) throw error

    const byQuotationItem = {}
    for (const row of data) {
      if (!byQuotationItem[row.quotation_item_id]) byQuotationItem[row.quotation_item_id] = []
      byQuotationItem[row.quotation_item_id].push(row)
    }
    return byQuotationItem
  }, [quotationId, JSON.stringify((quotationItems || []).map(qi => qi.id))])
}

export function useInvoices(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('invoices')
        // incomes ต้องระบุชื่อ FK ตรงๆ (invoices_income_id_fkey) เพราะระหว่าง
        // invoices/incomes มี FK สองทาง (invoices.income_id -> incomes.id
        // และ incomes.source_invoice_id -> invoices.id) -- ไม่งั้น PostgREST
        // จะ error "more than one relationship was found" ทันที ทำให้ query
        // ทั้งเส้นพังเงียบๆ (useInvoices ไม่มีใครอ่าน .error ใน Invoices.jsx เดิม)
        .select('*, quotations(quotation_number, client_id, clients(name, address, tax_id)), sites(name, site_number, default_tax_withheld_pct), invoice_items(id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order), incomes!invoices_income_id_fkey(tax_withheld, received_amount), bank_accounts(id, bank_name, account_name, account_no)')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.siteId) q = q.eq('site_id', filters.siteId)
      if (filters.status) q = q.eq('status', filters.status)
      if (filters.from)   q = q.gte('date', filters.from)
      if (filters.to)     q = q.lte('date', filters.to)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

export function useReceipts(invoiceIds) {
  return useQuery(async () => {
    const ids = (invoiceIds || []).filter(Boolean)
    if (!ids.length) return []
    const { data, error } = await supabase
      .from('receipts')
      .select('*')
      .in('invoice_id', ids)
    if (error) throw error
    return data
  }, [JSON.stringify(invoiceIds || [])])
}

// ใบเซ็นรับล่าสุดของเอกสารหนึ่งชิ้น (document_receipts เป็นตารางกลาง ใช้ร่วมกัน
// ทุกประเภทเอกสาร) -- ใช้แสดงลายเซ็นจริงในเอกสารที่พิมพ์ออกมา (ใบเสนอราคา/
// ใบแจ้งหนี้) เมื่อลูกค้าเซ็นผ่านลิงก์ระยะไกลแล้ว เอาแค่ใบล่าสุด เพราะแต่ละ
// เอกสารเซ็นได้ครั้งเดียวจริงๆ (ลิงก์ใช้ซ้ำไม่ได้ ดู sign-link Edge Function)
// แต่เผื่อกรณี edge case มีมากกว่า 1 แถวไว้ก่อน
export function useDocumentReceipt(documentType, documentId) {
  return useQuery(async () => {
    if (!documentType || !documentId) return null
    const { data, error } = await supabase
      .from('document_receipts')
      .select('*')
      .eq('document_type', documentType)
      .eq('document_id', documentId)
      .order('signed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  }, [documentType, documentId])
}

// วันนี้ พนักงานเช็คอิน/เช็คเอาท์ที่ไซท์นี้แล้วหรือยัง -- ใช้โดย
// TodayCheckinCard (MySchedule) เพื่อตัดสินใจว่าจะโชว์ปุ่ม "เช็คอิน" /
// "เช็คเอาท์" / เสร็จแล้ว สำหรับไซท์นั้นๆ (คนละแถวต่อไซท์ ต่อวัน)
export function useTodayCheckin(workerId, siteId, date) {
  return useQuery(async () => {
    if (!workerId || !siteId || !date) return null
    const { data, error } = await supabase
      .from('worker_checkins')
      .select('*')
      .eq('worker_id', workerId).eq('site_id', siteId).eq('date', date)
      .maybeSingle()
    if (error) throw error
    return data
  }, [workerId, siteId, date])
}

// ลายเซ็นส่วนตัวของผู้ใช้ที่ล็อกอินอยู่ตอนนี้ -- วาดครั้งเดียวที่หน้าตั้งค่า
// แล้วเอาไปแปะอัตโนมัติในช่องลายเซ็นฝั่งพนักงานของทุกเอกสาร (ไม่ผูกกับ
// เอกสารใบใดใบหนึ่ง) ดู saveMySignature ด้านล่างสำหรับการบันทึก
export function useMySignature() {
  return useQuery(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const email = session?.user?.email
    if (!email) return null
    const { data, error } = await supabase
      .from('user_signatures')
      .select('*')
      .eq('user_email', email)
      .maybeSingle()
    if (error) throw error
    return data
  }, [])
}

export async function saveMySignature(tenantId, dataUrl) {
  const { data: { session } } = await supabase.auth.getSession()
  const email = session?.user?.email
  if (!email) throw new Error('ไม่พบผู้ใช้ที่ล็อกอินอยู่')
  const blob = await (await fetch(dataUrl)).blob()
  const filePath = `${tenantId}/${email}/signature.png`
  const { error: upErr } = await supabase.storage.from('user-signatures').upload(filePath, blob, { contentType: 'image/png', upsert: true })
  if (upErr) throw upErr
  const { error: dbErr } = await supabase.from('user_signatures').upsert(
    { tenant_id: tenantId, user_email: email, signature_path: filePath, updated_at: new Date().toISOString() },
    { onConflict: 'tenant_id,user_email' }
  )
  if (dbErr) throw dbErr
}

export async function deleteMySignature(signature) {
  const { error: rmErr } = await supabase.storage.from('user-signatures').remove([signature.signature_path])
  if (rmErr) throw rmErr
  const { error: delErr } = await supabase.from('user_signatures').delete().eq('id', signature.id)
  if (delErr) throw delErr
}

// ดึงลายเซ็นส่วนตัว + แปลงเป็น signed URL พร้อมใช้แปะในเอกสาร -- ใช้ใน
// ทุกที่ที่มีช่องลายเซ็นฝั่งพนักงาน (QuotationPaper, DocumentPaper,
// WorkPhotosDocumentModal) จะได้ไม่ต้องเขียน useEffect + createSignedUrl
// ซ้ำทุกที่
export function useMySignatureUrl() {
  const { data: signature } = useMySignature()
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!signature) { setUrl(null); return }
    let cancelled = false
    supabase.storage.from('user-signatures').createSignedUrl(signature.signature_path, 300)
      .then(({ data }) => { if (!cancelled) setUrl(data?.signedUrl) })
    return () => { cancelled = true }
  }, [signature])
  return signature && url ? { url } : null
}

// ชื่อพนักงานที่ผูกกับ user ที่ล็อกอินอยู่ตอนนี้ (workers.email = session
// email, ตั้งค่าได้จากฟอร์มเพิ่ม/แก้ไขพนักงานในหน้า HR -- ช่อง "ผูกกับ User
// Account (Login)") ใช้แสดงชื่อใต้เส้นลายเซ็นฝั่งพนักงานในเอกสาร
// (QuotationPaper, DocumentPaper) เดียวกับที่ signerName ของลูกค้าแสดงใต้
// เส้นลายเซ็นฝั่งลูกค้าอยู่แล้ว. null เงียบๆ ถ้าไม่ได้ผูก -- เอกสารยัง
// แสดงป้ายบทบาท ("ผู้เสนอราคา" ฯลฯ) ได้ตามปกติโดยไม่มีชื่อกำกับ
export function useMyWorkerName() {
  return useQuery(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const email = session?.user?.email
    if (!email) return null
    // .limit(1) + array, not .maybeSingle() -- workers.email has no unique
    // constraint (the HR form's "ผูกกับ User Account" dropdown doesn't
    // filter out logins already linked to another worker), so two rows
    // sharing an email is a real possibility, not just theoretical.
    // maybeSingle() throws on 2+ rows; this instead just picks one rather
    // than breaking every document render for the tenant until someone
    // notices and fixes the duplicate link.
    const { data, error } = await supabase
      .from('workers')
      .select('name')
      .eq('email', email)
      .limit(1)
    if (error) throw error
    return data?.[0]?.name || null
  }, [])
}

// จำนวนครั้งที่เอกสารนี้เคยถูกพิมพ์/ดาวน์โหลดมาก่อน -- ใช้คำนวณว่าครั้งต่อไป
// จะเป็น "ต้นฉบับ" (ครั้งแรก) หรือ "สำเนาที่ N" (ดู printTagFor ใน lib/pdf.js)
export function useDocumentPrintCount(documentType, documentId) {
  return useQuery(async () => {
    if (!documentType || !documentId) return 0
    const { count, error } = await supabase
      .from('document_prints')
      .select('id', { count: 'exact', head: true })
      .eq('document_type', documentType)
      .eq('document_id', documentId)
    if (error) throw error
    return count || 0
  }, [documentType, documentId])
}

export async function logDocumentPrint(tenantId, documentType, documentId, format) {
  const { data: { session } } = await supabase.auth.getSession()
  const { error } = await supabase.from('document_prints').insert({
    tenant_id: tenantId, document_type: documentType, document_id: documentId,
    format, printed_by: session?.user?.email || 'system',
  })
  if (error) throw error
}

export function useInvoicePhotos(invoiceId) {
  return useQuery(async () => {
    if (!invoiceId) return []
    const { data, error } = await supabase
      .from('invoice_photos')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('sort_order')
    if (error) throw error
    return data
  }, [invoiceId])
}

/** ยอดที่ต้องชำระรายเดือน (สำหรับ cash forecast) */
export function usePaymentForecast() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('payment_forecast')
      .select('*')
    if (error) throw error
    return data
  })
}

// ── Incomes ──────────────────────────────────────────────────

export function useIncomes(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('incomes_view')
        .select('*')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.siteId) q = q.eq('site_id', filters.siteId)
      if (filters.from)   q = q.gte('date', filters.from)
      if (filters.to)     q = q.lte('date', filters.to)
      if (filters.search) q = q.ilike('description', `%${filters.search}%`)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

// ── Workers ──────────────────────────────────────────────────

export function useWorkers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('workers_with_rate')
      .select('*')
      .eq('status', 'active')
      .eq('show_in_assign', true)
      .order('name')
    if (error) throw error
    return data
  })
}

// Same as useWorkers() but WITHOUT the show_in_assign filter -- used by
// MySchedule.jsx, which must let a worker find and manage their own
// schedule even if an admin has hidden them from the Assign roster.
export function useAllActiveWorkers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('workers_with_rate')
      .select('*')
      .eq('status', 'active')
      .order('name')
    if (error) throw error
    return data
  })
}

// ── Worker Assignments ────────────────────────────────────────

export function useAssignments(month, year) {
  return useQuery(async () => {
    if (!month || !year) return []
    const from = `${year}-${String(month).padStart(2,'0')}-01`
    const to   = new Date(year, month, 0).toISOString().slice(0,10)
    const { data, error } = await supabase
      .from('worker_assignments')
      .select('*, workers(name, nickname, position, monthly_salary, monthly_contribution, has_social_security), sites(name, site_number)')
      .gte('date', from)
      .lte('date', to)
      .order('date')
    if (error) throw error
    return data
  }, [month, year])
}

/** Assignments ในช่วงวันที่ (รวม shift) — ใช้กับมุมมอง Day/Week/Month */
export function useAssignmentsRange(from, to) {
  return useQuery(async () => {
    if (!from || !to) return []
    const { data, error } = await supabase
      .from('worker_assignments')
      .select('id, worker_id, site_id, date, type, shift, ot_hours, notes, confirmed_at, confirmed_by, workers(name, nickname, monthly_salary), sites(name, site_number)')
      .gte('date', from)
      .lte('date', to)
      .order('date')
    if (error) throw error
    return data
  }, [from, to])
}

/** ค่าแรงช่างต่อไซท์ */
export function useLaborCost(siteId) {
  return useQuery(async () => {
    let q = supabase.from('labor_cost_by_site').select('*')
    if (siteId) q = q.eq('site_id', siteId)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [siteId])
}

/** OT entries ในช่วงวันที่ — ใช้กับมุมมอง Day/Week/Month และ copy-for-LINE */
export function useWorkerOTRange(from, to) {
  return useQuery(async () => {
    if (!from || !to) return []
    const { data, error } = await supabase
      .from('worker_ot')
      .select('id, worker_id, site_id, date, start_time, end_time, ot_hours, is_overnight, notes, workers(name, nickname, monthly_salary), sites(name, site_number)')
      .gte('date', from)
      .lte('date', to)
      .order('date')
    if (error) throw error
    return data
  }, [from, to])
}

/** เหมือน useWorkerOTRange แต่เรียกแบบ imperative (ไม่ใช่ hook) — ใช้ใน Payroll/HR handleCalcFromAssign */
export async function fetchWorkerOTForRange(from, to) {
  const { data, error } = await supabase
    .from('worker_ot')
    .select('worker_id, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
    .gte('date', from)
    .lte('date', to)
  if (error) throw error
  return data
}

/** ต้นทุน OT ต่อไซท์ (all-time) */
export function useOTCostBySite() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('ot_cost_by_site').select('*')
    if (error) throw error
    return data
  })
}

// ── Company Holidays ──────────────────────────────────────────

/** ปฏิทินวันหยุดบริษัททั้งหมด — ใช้ในแท็บ HR */
export function useCompanyHolidays() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('company_holidays')
      .select('id, date, name')
      .order('date')
    if (error) throw error
    return data
  })
}

/** วันหยุดในช่วงวันที่ — ใช้กับหัวตาราง Assign (week/month/day) */
export function useCompanyHolidaysRange(from, to) {
  return useQuery(async () => {
    if (!from || !to) return []
    const { data, error } = await supabase
      .from('company_holidays')
      .select('id, date, name')
      .gte('date', from)
      .lte('date', to)
      .order('date')
    if (error) throw error
    return data
  }, [from, to])
}

/** เหมือน useCompanyHolidaysRange แต่เรียกแบบ imperative — ใช้ใน Payroll/HR handleCalcFromAssign */
export async function fetchCompanyHolidaysForRange(from, to) {
  const { data, error } = await supabase
    .from('company_holidays')
    .select('date, name')
    .gte('date', from)
    .lte('date', to)
  if (error) throw error
  return data
}

export async function saveCompanyHoliday({ date, name }) {
  const { error } = await supabase.from('company_holidays').insert({ date, name })
  if (error) throw error
}

export async function deleteCompanyHoliday(id) {
  const { error } = await supabase.from('company_holidays').delete().eq('id', id)
  if (error) throw error
}

// ── Leave Quota ────────────────────────────────────────────────

/** วันลากิจที่ใช้ไปแล้วในปีนั้นๆ ต่อคน (ลาป่วยไม่หักโควต้าจึงไม่นับ) */
export function useLeaveQuotaUsage(year) {
  return useQuery(async () => {
    const from = `${year}-01-01`
    const to   = `${year}-12-31`
    // Legacy 'leave' rows (predating the sick/personal split) count as
    // leave_personal here too — must match the same rule Payroll.jsx/
    // HR.jsx use for the pay deduction, or quota-used and pay-deducted
    // silently disagree for any worker with pre-split assignment rows.
    const { data, error } = await supabase
      .from('worker_assignments')
      .select('worker_id')
      .in('type', ['leave_personal', 'leave'])
      .gte('date', from).lte('date', to)
    if (error) throw error
    const used = {}
    ;(data || []).forEach(r => { used[r.worker_id] = (used[r.worker_id] || 0) + 0.5 })
    return used
  }, [year])
}

/** ลาป่วยที่ใช้ไปแล้วในปีนั้น (แยกจาก useLeaveQuotaUsage ซึ่งนับเฉพาะลากิจ) --
 * ไม่มี legacy 'leave' rows ให้นับรวมด้วย เพราะแยก type ตั้งแต่แรกที่มี leave_sick */
export function useSickLeaveQuotaUsage(year) {
  return useQuery(async () => {
    const from = `${year}-01-01`
    const to   = `${year}-12-31`
    const { data, error } = await supabase
      .from('worker_assignments')
      .select('worker_id')
      .eq('type', 'leave_sick')
      .gte('date', from).lte('date', to)
    if (error) throw error
    const used = {}
    ;(data || []).forEach(r => { used[r.worker_id] = (used[r.worker_id] || 0) + 0.5 })
    return used
  }, [year])
}

// ── Sites Progress (WORKER-safe) ──────────────────────────────

/** ข้อมูลไซท์งานแบบไม่มีตัวเลขการเงิน (สำหรับ ADMIN เท่านั้น) — site_number, name, status, billing_pct.
 *  หมายเหตุ: ชื่อฟังก์ชันนี้ทำให้เข้าใจผิดว่า WORKER อ่านได้ -- จริงๆ แล้ว
 *  sites_progress เป็น security_invoker=true บน sites ซึ่ง RLS อนุญาต
 *  แค่ admin_reads เท่านั้น เรียกจาก WORKER จะได้ 0 แถวเงียบๆ ดู
 *  useMySiteNames() ด้านล่างสำหรับ path ที่ WORKER ใช้ได้จริง */
export function useSitesProgress() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('sites_progress')
      .select('id, site_number, name, status, start_date, end_date, billing_pct')
      .order('site_number')
    if (error) throw error
    return data
  })
}

/** ชื่อไซท์งานที่พนักงาน (WORKER) มี assignment อยู่ -- ผ่าน SECURITY DEFINER
 *  function เพราะ sites เป็น admin/owner-read-only โดยตรง (ดูคอมเมนต์ที่
 *  get_my_site_names() ใน schema.sql) คืนแค่ id/site_number/name เท่านั้น
 *  ไม่มีตัวเลขการเงิน ใช้แทน useSitesProgress() ใน MySchedule.jsx */
export function useMySiteNames() {
  return useQuery(async () => {
    const { data, error } = await supabase.rpc('get_my_site_names')
    if (error) throw error
    return data
  })
}

// ── Contractor Types ────────────────────────────────────────────

/** รายการประเภทผู้รับเหมาทั้งหมด — ใช้ในฟอร์ม signup และหน้า Settings */
export function useContractorTypes() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('contractor_types')
      .select('id, key, label_th')
      .order('sort_order')
    if (error) throw error
    return data
  })
}

// ── App Settings (key/value) ──────────────────────────────────

export function useAppSetting(key, fallback = '') {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('app_settings').select('value').eq('key', key).maybeSingle()
    if (error) throw error
    return data?.value ?? fallback
  }, [key])
}

export async function saveAppSetting(key, value) {
  // app_settings' real primary key is (tenant_id, key) -- onConflict must
  // name that exact composite or Postgres has no matching unique
  // constraint to resolve against and the upsert fails outright, even on
  // a first-ever save for that key (not just a repeat one).
  const { error } = await supabase.from('app_settings')
    .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,key' })
  if (error) throw error
}

/** ค่าเดินทางต่อไซท์ (distance × 2 × rate ต่อวันที่มีงานไซท์) */
export function useSiteTravelCost() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('site_travel_cost').select('*')
    if (error) throw error
    return data
  })
}

// ── Expense Categories ────────────────────────────────────────

export function useCategories() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('expense_categories')
      .select('*')
      .order('sort_order')
    if (error) throw error
    return data
  })
}

// ── Cheques ──────────────────────────────────────────────────

export function useCheques() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('cheques')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  })
}

// ── Salary ───────────────────────────────────────────────────

export function useSalary(month, year) {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('salary_records')
      .select('*, workers(name, nickname, position, email)')
      .eq('month', month)
      .eq('year', year)
      .order('workers(name)')
    if (error) throw error
    return data
  }, [month, year])
}

/** เดือนก่อนหน้า — ใช้สำหรับ copy previous month ใน payroll */
export function usePreviousMonthSalaries(month, year) {
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear  = month === 1 ? year - 1 : year
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('salary_records')
      .select('*, workers(id, name, nickname, position, monthly_salary, monthly_contribution, has_social_security)')
      .eq('month', prevMonth)
      .eq('year', prevYear)
      .order('workers(name)')
    if (error) throw error
    return data
  }, [month, year])
}

// ── Clients ──────────────────────────────────────────────────
export function useClients() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('client_number')
    if (error) throw error
    return data
  })
}

// ── Suppliers ─────────────────────────────────────────────────
export function useSuppliers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('supplier_number')
    if (error) throw error
    return data
  })
}

export function useCatalogItems() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('catalog_items')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}

// ── Bank Accounts ───────────────────────────────────────────────

/** ทุกบัญชีธนาคารของ tenant (ทั้ง vat/non_vat, active/inactive) -- ใช้ในหน้า
 *  ตั้งค่าและตัว dropdown เลือกบัญชีในใบเสนอราคา/ใบแจ้งหนี้ (กรองเองตาม
 *  vat_category ที่ฝั่ง component) */
export function useBankAccounts() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('bank_accounts')
      .select('*')
      .order('vat_category').order('is_default', { ascending: false }).order('bank_name')
    if (error) throw error
    return data
  })
}

// ── Units ────────────────────────────────────────────────────────

/** รายการหน่วยนับที่ tenant เคยใช้/เพิ่มไว้ -- ใช้ร่วมกันทั้งฝั่งซื้อ
 *  (purchase_order_items) และฝั่งขาย (catalog_items, quotation_items) */
export function useUnits() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('units').select('*').order('name')
    if (error) throw error
    return data
  })
}

/** ตั้งบัญชีนี้เป็น default ของหมวด vat_category ของมันเอง -- ต้องปลด
 *  default เดิมในหมวดเดียวกันก่อน (unique index กันไว้ให้ default ได้แค่
 *  บัญชีเดียวต่อหมวดต่อ tenant) ไม่งั้น insert/update จะชนกัน */
export async function setDefaultBankAccount(tenantId, accountId, vatCategory) {
  const { error: clearError } = await supabase.from('bank_accounts')
    .update({ is_default: false }).eq('tenant_id', tenantId).eq('vat_category', vatCategory).eq('is_default', true)
  if (clearError) throw clearError
  const { error } = await supabase.from('bank_accounts').update({ is_default: true }).eq('id', accountId)
  if (error) throw error
}

/** Every sold line item (accepted quotations only), for lookup/analysis. */
export function useSalesReport(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('sales_report_view')
        .select('*')
        .order('date', { ascending: false })
        .order('id', { ascending: false })

      if (filters.siteId)   q = q.eq('site_id', filters.siteId)
      if (filters.clientId) q = q.eq('client_id', filters.clientId)
      if (filters.from)     q = q.gte('date', filters.from)
      if (filters.to)       q = q.lte('date', filters.to)
      if (filters.search)   q = q.ilike('description', `%${filters.search}%`)
      return q
    }

    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}

/** Past snapshots of a quotation, newest revision first. Empty until the
 *  quotation has been edited at least once (revision 1 has no snapshot —
 *  the live row itself IS revision 1 until an edit bumps it forward). */
export function useQuotationRevisions(quotationId) {
  return useQuery(async () => {
    if (!quotationId) return []
    const { data, error } = await supabase
      .from('quotation_revisions')
      .select('*')
      .eq('quotation_id', quotationId)
      .order('revision', { ascending: false })
    if (error) throw error
    return data
  }, [quotationId])
}

// ── Audit Logs ────────────────────────────────────────────────
export function useAuditLogs(tableName, limit = 50) {
  return useQuery(async () => {
    let q = supabase
      .from('audit_logs')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit)
    if (tableName) q = q.eq('table_name', tableName)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [tableName, limit])
}

// ── Labor Subcontractors ──────────────────────────────────────
export function useLaborSubcontractors() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('labor_subcontractors').select('*').order('subcontractor_number')
    if (error) throw error
    return data
  })
}

export function useLaborContracts(filters = {}) {
  return useQuery(async () => {
    let q = supabase.from('labor_contract_summary').select('*').order('subcontractor_number')
    if (filters.siteId)          q = q.eq('site_id', filters.siteId)
    if (filters.subcontractorId) q = q.eq('subcontractor_id', filters.subcontractorId)
    if (filters.status)          q = q.eq('status', filters.status)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}

export function useLaborPayments(contractId) {
  return useQuery(async () => {
    if (!contractId) return []
    const { data, error } = await supabase
      .from('labor_payments').select('*')
      .eq('contract_id', contractId)
      .order('payment_date', { ascending: false })
    if (error) throw error
    return data
  }, [contractId])
}

export function useAllLaborPayments(filters = {}) {
  return useQuery(async () => {
    let q = supabase
      .from('labor_payments')
      .select('*, labor_contracts(work_description, contract_amount, withholding_tax_pct, labor_subcontractors(name, subcontractor_number, id_card_number, address), sites(id, name, site_number))')
      .order('payment_date', { ascending: false })
    if (filters.status) q = q.eq('status', filters.status)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}

// ── Tenant management (platform admin only) ─────────────────────

/**
 * Whether the logged-in user is a platform admin -- checked directly
 * against platform_admins (readable by any authenticated user for their
 * own row only, per that table's RLS), not by probing platform_list_tenants()
 * for a non-empty result. Used purely for nav-item visibility: the real
 * security boundary is the platform_admins check inside
 * platform_list_tenants()/platform_set_tenant_package() themselves.
 */
export function usePlatformAdmin() {
  return useQuery(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) return false
    const { data, error } = await supabase
      .from('platform_admins').select('user_email').eq('user_email', user.email).maybeSingle()
    if (error) throw error
    return !!data
  }, [])
}

export function usePlatformTenants() {
  return useQuery(async () => {
    const { data, error } = await supabase.rpc('platform_list_tenants')
    if (error) throw error
    return data
  }, [])
}

export function usePackages() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('packages').select('*').order('sort_order')
    if (error) throw error
    return data
  }, [])
}

/**
 * ทุกแถวของ package_modules (package_id + module_key) -- ใช้คู่กับ
 * usePackages() เพื่อสร้างตารางเปรียบเทียบว่าแต่ละ tier มี module อะไรบ้าง
 */
export function usePackageModules() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('package_modules').select('package_id, module_key')
    if (error) throw error
    return data
  }, [])
}

/**
 * ประวัติการเปลี่ยนสถานะ/หมดอายุ ของ tenant หนึ่งราย -- ไม่ต้องผ่าน
 * SECURITY DEFINER wrapper เพราะ tenant_status_log ไม่ได้ scope ด้วย
 * current_tenant_id() (เหมือน packages) อ่านตรงได้เลยถ้าเป็น platform admin
 */
export function useTenantStatusLog(tenantId) {
  return useQuery(async () => {
    if (!tenantId) return []
    const { data, error } = await supabase
      .from('tenant_status_log').select('*').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  }, [tenantId])
}

/**
 * seat/site usage vs package limit ของ tenant ตัวเอง -- ใช้เตือนก่อนกดบันทึก
 * ใน UserManagement/HR/Sites (บังคับจริงอยู่ที่ RLS, นี่แค่ UI warning)
 * คืนค่าเป็น { admins: {used, max}, workers: {used, max}, sites: {used, max} }
 * max === null คือไม่จำกัด
 */
export function useSeatStatus() {
  return useQuery(async () => {
    const { data, error } = await supabase.rpc('tenant_seat_status')
    if (error) throw error
    const out = {}
    for (const row of data || []) out[row.kind] = { used: row.used, max: row.max_allowed }
    return out
  }, [])
}

// ── Inventory ────────────────────────────────────────────────

/** Every active inventory item, for link-pickers on PO lines (a picker
 *  should only offer active items -- do NOT use this for a management
 *  list, since a deactivated item would vanish and become unreachable;
 *  use useAllInventoryItems() there instead). */
export function useInventoryItems() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('active', true)
      .order('name')
    if (error) throw error
    return data
  })
}

/** Every inventory item regardless of active flag, for the Inventory
 *  page's own item-management list -- so deactivating an item doesn't
 *  strand it with no UI path to view/edit/reactivate it. */
export function useAllInventoryItems() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}

/** Every active aluminum profile, for the PO-line profile picker (a
 *  picker should only offer active profiles). */
export function useAluminumProfiles() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('aluminum_profiles')
      .select('*')
      .eq('active', true)
      .order('name')
    if (error) throw error
    return data
  })
}

/** Every aluminum profile regardless of active flag, for the Inventory
 *  page's own profile-management list -- mirrors useAllInventoryItems(). */
export function useAllAluminumProfiles() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('aluminum_profiles')
      .select('*')
      .order('name')
    if (error) throw error
    return data
  })
}

/** All fixed unit-conversion factors across every inventory item --
 *  a small table, fetched whole and filtered client-side by
 *  (inventory_item_id, unit_name) rather than one query per item. */
export function useInventoryItemUnitFactors() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_item_unit_factors')
      .select('*')
    if (error) throw error
    return data
  })
}

/** Current stock balance per (item, site) -- the valuation report and
 *  the PO receive-preview both read this. */
export function useStockBalances() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('inventory_stock_balances')
      .select('*, inventory_items(name, base_unit, unit_conversion_mode, reference_area_sqm), sites(name, site_number)')
      .order('inventory_item_id')
    if (error) throw error
    return data
  })
}

/** Append-only stock ledger, newest first -- the stock card. */
export function useStockMovements(filters = {}) {
  return useQuery(async () => {
    const buildQuery = () => {
      let q = supabase
        .from('stock_movements')
        .select('*, inventory_items(name, base_unit), sites(name, site_number)')
        .order('created_at', { ascending: false })
      if (filters.inventoryItemId) q = q.eq('inventory_item_id', filters.inventoryItemId)
      if (filters.siteId) q = q.eq('site_id', filters.siteId)
      return q
    }
    return fetchAllRows(buildQuery)
  }, [JSON.stringify(filters)])
}
