// Fetches one month's inputs, runs the pure engine, and wraps the payroll RPCs.
// All money math stays in calc.js/run.js.
import { supabase } from '../supabase.js'
import { monthRange } from './period.js'
import { summarizeAttendance, findAssignGaps } from './attendance.js'
import { advancesDueFor, manualFromLines, buildPayrollRun, diffRuns } from './run.js'

const must = ({ data, error }) => { if (error) throw error; return data }

export async function loadPayrollMonth(year, month) {
  const { from, to } = monthRange(year, month)
  const [items, workers, amounts, period, records, shifts, otRows, holidays, advances, settingsRows] = await Promise.all([
    supabase.from('pay_items').select('*').order('sort_order').then(must),
    supabase.from('workers_with_rate').select('*').eq('status', 'active').order('name').then(must),
    supabase.from('worker_pay_item_amounts').select('worker_id, pay_item_id, amount').then(must),
    supabase.from('payroll_periods').select('*').eq('year', year).eq('month', month).maybeSingle().then(must),
    supabase.from('salary_records')
      .select('id, worker_id, net_pay, paid_date, facts, workers(name, nickname, position, employee_code, bank_code, bank_account_no, bank_account_name), salary_record_lines(*)')
      .eq('year', year).eq('month', month).then(must),
    supabase.from('worker_assignments').select('worker_id, type, shift, ot_hours, date, confirmed_at').gte('date', from).lte('date', to).then(must),
    supabase.from('worker_ot').select('worker_id, ot_hours').gte('date', from).lte('date', to).then(must),
    supabase.from('company_holidays').select('date').gte('date', from).lte('date', to).then(must),
    supabase.from('salary_advances').select('*').in('status', ['approved', 'settled']).then(must),
    supabase.from('app_settings').select('key, value').in('key', ['holiday_pay_multiplier', 'require_checkin_confirmation']).then(must),
  ])
  const setting = k => settingsRows.find(r => r.key === k)?.value
  const priorLines = await loadAdvanceLines(advances.map(a => a.id))
  const amountsByWorker = {}
  for (const a of amounts) (amountsByWorker[a.worker_id] ||= {})[a.pay_item_id] = Number(a.amount)
  const manualByWorker = {}
  for (const r of records) manualByWorker[r.worker_id] = manualFromLines(r.salary_record_lines)
  const inputs = {
    items, workers, amountsByWorker, manualByWorker,
    attendanceByWorker: summarizeAttendance({ shifts, otRows, holidayDates: holidays.map(h => h.date), requireConfirm: setting('require_checkin_confirmation') === 'true' }),
    advancesDueByWorker: advancesDueFor({ advances, priorLines, year, month }),
    settings: { holidayMultiplier: parseFloat(setting('holiday_pay_multiplier')) || 1.5 },
  }
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const assignGaps = findAssignGaps({ workers, shifts, holidayDates: holidays.map(h => h.date), year, month, today })
  return { period, items, workers, records, advances, inputs, assignGaps }
}

async function loadAdvanceLines(advanceIds) {
  if (!advanceIds.length) return []
  const rows = await supabase.from('salary_record_lines')
    .select('advance_id, amount, salary_records!inner(year, month)')
    .in('advance_id', advanceIds).then(must)
  return rows.map(r => ({ advance_id: r.advance_id, amount: Number(r.amount), year: r.salary_records.year, month: r.salary_records.month }))
}

export async function calculateMonth(year, month) {
  const m = await loadPayrollMonth(year, month)
  const run = buildPayrollRun(m.inputs)
  const saved = m.records.map(r => ({ worker_id: r.worker_id, worker_name: r.workers?.name, lines: r.salary_record_lines }))
  return { ...m, run, diff: diffRuns(saved, run) }
}

export async function saveDraft(year, month, run) {
  const p_records = run.map(r => ({ worker_id: r.worker_id, facts: r.facts, lines: r.lines }))
  return must(await supabase.rpc('save_payroll_draft', { p_year: year, p_month: month, p_records }))
}

const rpc = (fn, args) => supabase.rpc(fn, args).then(must)
export const setManualLine  = (recordId, payItemId, advanceId, amount) => rpc('set_payroll_manual_line', { p_record_id: recordId, p_pay_item_id: payItemId, p_advance_id: advanceId, p_amount: amount })
export const confirmMonth   = (y, m) => rpc('confirm_payroll_period', { p_year: y, p_month: m })
export const unconfirmMonth = (y, m) => rpc('unconfirm_payroll_period', { p_year: y, p_month: m })
export const closeMonth     = (y, m, paidDate) => rpc('close_payroll_period', { p_year: y, p_month: m, p_paid_date: paidDate })
export const reopenMonth    = (y, m, reason) => rpc('reopen_payroll_period', { p_year: y, p_month: m, p_reason: reason })
export const approveAdvance = id => rpc('approve_salary_advance', { p_id: id })
export const rejectAdvance  = (id, reason) => rpc('reject_salary_advance', { p_id: id, p_reason: reason })
export async function requestAdvance(row) {
  return must(await supabase.from('salary_advances').insert(row).select().single())
}
