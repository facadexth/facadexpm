import { useQuery } from './useSupabase.js'
import { supabase } from '../lib/supabase.js'
import { loadPayrollMonth, chunk } from '../lib/payroll/load.js'

const must = ({ data, error }) => { if (error) throw error; return data }

export function usePayItems() {
  return useQuery(() => supabase.from('pay_items').select('*').order('sort_order').then(must), [])
}

export function usePayrollMonth(year, month) {
  return useQuery(() => loadPayrollMonth(year, month), [year, month])
}

export function useAdvances(workerId = null) {
  return useQuery(async () => {
    let q = supabase.from('salary_advances').select('*, workers(name, nickname)').order('requested_at', { ascending: false })
    if (workerId) q = q.eq('worker_id', workerId)
    const rows = must(await q)
    const ids = rows.filter(r => ['approved', 'settled'].includes(r.status)).map(r => r.id)
    if (!ids.length) return rows
    const lines = []
    for (const part of chunk(ids)) {
      lines.push(...must(await supabase.from('salary_record_lines')
        .select('advance_id, amount, salary_records!inner(period_id, payroll_periods!inner(status))')
        .in('advance_id', part)))
    }
    return rows.map(r => {
      const mine = lines.filter(l => l.advance_id === r.id)
      const closed = mine.filter(l => l.salary_records.payroll_periods.status === 'closed')
      const deducted = closed.reduce((s, l) => s + Number(l.amount), 0)
      return { ...r, deducted, remaining: Number(r.amount) - deducted, paidInstallments: closed.filter(l => Number(l.amount) > 0).length }
    })
  }, [workerId])
}

export function useBankSettings() {
  return useQuery(() => supabase.from('payroll_bank_settings').select('*').maybeSingle().then(must), [])
}

export function useWorkerPayAmounts(workerId) {
  return useQuery(async () => {
    if (!workerId) return {}
    const rows = must(await supabase.from('worker_pay_item_amounts').select('pay_item_id, amount').eq('worker_id', workerId))
    return Object.fromEntries(rows.map(r => [r.pay_item_id, Number(r.amount)]))
  }, [workerId])
}
