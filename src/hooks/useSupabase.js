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
        .select('*, sites(name, site_number), suppliers(name, supplier_number, credit_days), expense_categories(name), purchase_order_items(id, description, quantity, unit, unit_price, line_total), purchase_order_attachments(id)')
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
        .select('*, clients(name, client_number), sites(name, site_number), quotation_items(id, catalog_item_id, description, unit, quantity, unit_price, line_total, sort_order)')
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
        .select('*, quotations(quotation_number, client_id, clients(name, address, tax_id)), sites(name, site_number, default_tax_withheld_pct), invoice_items(id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order), incomes!invoices_income_id_fkey(tax_withheld, received_amount)')
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
      .select('id, worker_id, site_id, date, type, shift, ot_hours, notes, workers(name, nickname, monthly_salary), sites(name, site_number)')
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

/** ข้อมูลไซท์งานแบบไม่มีตัวเลขการเงิน (สำหรับ WORKER) — site_number, name, status, billing_pct */
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
      .select('*, labor_contracts(work_description, contract_amount, labor_subcontractors(name, subcontractor_number), sites(id, name, site_number))')
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
