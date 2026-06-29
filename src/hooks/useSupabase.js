// ============================================================
// Custom hook สำหรับ fetch ข้อมูลจาก Supabase
// รองรับ loading / error state และ refetch
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'

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

// ── Expenses ─────────────────────────────────────────────────

export function useExpenses(filters = {}) {
  return useQuery(async () => {
    let q = supabase
      .from('expenses_view')
      .select('*')
      .order('date', { ascending: false })

    if (filters.siteId)   q = q.eq('site_id', filters.siteId)
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
    if (filters.status)   q = q.eq('status', filters.status)
    if (filters.from)     q = q.gte('date', filters.from)
    if (filters.to)       q = q.lte('date', filters.to)
    if (filters.search)   q = q.ilike('description', `%${filters.search}%`)

    const { data, error } = await q
    if (error) throw error
    return data
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
    let q = supabase
      .from('incomes_view')
      .select('*')
      .order('date', { ascending: false })

    if (filters.siteId) q = q.eq('site_id', filters.siteId)
    if (filters.from)   q = q.gte('date', filters.from)
    if (filters.to)     q = q.lte('date', filters.to)
    if (filters.search) q = q.ilike('description', `%${filters.search}%`)

    const { data, error } = await q
    if (error) throw error
    return data
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
      .select('*, workers(name, nickname, position)')
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
      .select('*, labor_contracts(work_description, contract_amount, labor_subcontractors(name, subcontractor_number), sites(name, site_number))')
      .order('payment_date', { ascending: false })
    if (filters.status) q = q.eq('status', filters.status)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}
