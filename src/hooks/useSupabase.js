// ============================================================
// Custom hook สำหรับ fetch ข้อมูลจาก Supabase
// รองรับ loading / error state และ refetch
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { applyDateFilter } from '../lib/expenseFilters.js'

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
      if (filters.status)   q = q.eq('status', filters.status)
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
  const { error } = await supabase.from('app_settings')
    .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' })
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
