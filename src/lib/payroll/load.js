// Fetches one month's inputs, runs the pure engine, and wraps the payroll RPCs.
// All money math stays in calc.js/run.js.
import { supabase } from '../supabase.js'
import { monthRange } from './period.js'
import { summarizeAttendance, findAssignGaps } from './attendance.js'
import { buildCheckinDays, otByWorkerDate } from '../checkinDay.js'
import { advancesDueFor, manualFromLines, buildPayrollRun, diffRuns } from './run.js'

const must = ({ data, error }) => { if (error) throw error; return data }

const PAGE = 1000
const CHUNK = 100

// Fetch every row of a query, 1000 at a time (PostgREST caps a response).
// build() must return a fresh query each call; ordering by id keeps pages stable.
export async function fetchAllPages(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const rows = must(await build().order('id').range(from, from + PAGE - 1))
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

export const chunk = (arr, n = CHUNK) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export async function loadPayrollMonth(year, month) {
  const { from, to } = monthRange(year, month)
  const [items, activeWorkers, amounts, period, records, shifts, otRows, holidays, advances, settingsRows] = await Promise.all([
    supabase.from('pay_items').select('*').order('sort_order').then(must),
    supabase.from('workers_with_rate').select('*').eq('status', 'active').order('name').then(must),
    supabase.from('worker_pay_item_amounts').select('worker_id, pay_item_id, amount').then(must),
    supabase.from('payroll_periods').select('*').eq('year', year).eq('month', month).maybeSingle().then(must),
    supabase.from('salary_records')
      .select('id, worker_id, net_pay, paid_date, facts, workers(name, nickname, position, employee_code, bank_code, bank_account_no, bank_account_name, bank_branch_code), salary_record_lines(*)')
      .eq('year', year).eq('month', month).then(must),
    fetchAllPages(() => supabase.from('worker_assignments').select('id, worker_id, type, shift, ot_hours, date, confirmed_at').gte('date', from).lte('date', to)),
    fetchAllPages(() => supabase.from('worker_ot').select('id, worker_id, ot_hours, date').gte('date', from).lte('date', to)),
    supabase.from('company_holidays').select('date').gte('date', from).lte('date', to).then(must),
    supabase.from('salary_advances').select('*').in('status', ['approved', 'settled']).then(must),
    supabase.from('app_settings').select('key, value').in('key', ['holiday_pay_multiplier', 'require_checkin_confirmation', 'ot_from_checkin', 'checkin_standard_day_hours', 'checkin_break_minutes', 'assembly_mode', 'assembly_location_id']).then(must),
  ])
  // Ex-workers who still have a record or shifts this month stay in the run.
  const activeIds = new Set(activeWorkers.map(w => w.id))
  const extraIds = [...new Set([...records.map(r => r.worker_id), ...shifts.map(s => s.worker_id)])].filter(id => !activeIds.has(id))
  const extra = []
  for (const ids of chunk(extraIds)) {
    extra.push(...must(await supabase.from('workers_with_rate').select('*').in('id', ids)))
  }
  const workers = [...activeWorkers, ...extra.map(w => ({ ...w, inactive: true }))]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'))
  const setting = k => settingsRows.find(r => r.key === k)?.value
  const checkinOt = setting('ot_from_checkin') === 'true' ? await loadCheckinOt(from, to, setting) : null
  const priorLines = await loadAdvanceLines(advances.filter(a => ['approved', 'settled'].includes(a.status)).map(a => a.id))
  const amountsByWorker = {}
  for (const a of amounts) (amountsByWorker[a.worker_id] ||= {})[a.pay_item_id] = Number(a.amount)
  const manualByWorker = {}
  for (const r of records) manualByWorker[r.worker_id] = manualFromLines(r.salary_record_lines)
  const inputs = {
    items, workers, amountsByWorker, manualByWorker,
    attendanceByWorker: summarizeAttendance({ shifts, otRows, holidayDates: holidays.map(h => h.date), requireConfirm: setting('require_checkin_confirmation') === 'true', checkinOt }),
    advancesDueByWorker: advancesDueFor({ advances, priorLines, year, month }),
    settings: { holidayMultiplier: parseFloat(setting('holiday_pay_multiplier')) || 1.5 },
  }
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const assignGaps = findAssignGaps({ workers: workers.filter(w => !w.inactive), shifts, holidayDates: holidays.map(h => h.date), year, month, today })
  return { period, items, workers, records, advances, advanceLines: priorLines, inputs, assignGaps }
}

// "คิด OT จากเวลาเช็คอิน" (app_settings ot_from_checkin = 'true', default off): OT per
// worker-date from check-in work time (src/lib/checkinDay.js). Only read when the switch is on,
// so payroll is unchanged for every tenant that never turned it on.
async function loadCheckinOt(from, to, setting) {
  const [checkins, assignments, sites] = await Promise.all([
    fetchAllPages(() => supabase.from('worker_checkins').select('id, worker_id, date, site_id, checkin_location_id, is_assembly, checkin_at, checkout_at').gte('date', from).lte('date', to)),
    fetchAllPages(() => supabase.from('worker_assignments').select('id, worker_id, date, site_id, shift, type, is_team_leader').gte('date', from).lte('date', to)),
    supabase.from('sites').select('id, name, assembly_mode').then(must),
  ])
  const days = buildCheckinDays({
    checkins, assignments,
    sites: Object.fromEntries(sites.map(s => [s.id, s])),
    settings: { assemblyMode: setting('assembly_mode') || 'none', assemblyLocationId: setting('assembly_location_id') || null },
  })
  const brk = parseFloat(setting('checkin_break_minutes'))
  return otByWorkerDate(days, parseFloat(setting('checkin_standard_day_hours')) || 8, Number.isFinite(brk) ? brk : 60)
}

export async function loadAdvanceLines(advanceIds) {
  if (!advanceIds.length) return []
  const rows = []
  for (const ids of chunk(advanceIds)) {
    rows.push(...must(await supabase.from('salary_record_lines')
      .select('advance_id, amount, salary_record_id, salary_records!inner(year, month)')
      .in('advance_id', ids)))
  }
  return rows.map(r => ({ advance_id: r.advance_id, salary_record_id: r.salary_record_id, amount: Number(r.amount), year: r.salary_records.year, month: r.salary_records.month }))
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
// Every approval goes through the edit RPC (owner only; it refuses a confirmed/closed start month).
export const approveAdvanceEdit = (id, { amount, installments, startYear, startMonth }) =>
  rpc('approve_salary_advance_edit', { p_id: id, p_amount: amount, p_installments: installments, p_start_year: startYear, p_start_month: startMonth })
// How many saved salary records a month has, and whether its period is still a draft (for the recalc warning).
export async function loadMonthRecalcState(year, month) {
  const [period, cnt] = await Promise.all([
    supabase.from('payroll_periods').select('status').eq('year', year).eq('month', month).maybeSingle().then(must),
    supabase.from('salary_records').select('id', { count: 'exact', head: true }).eq('year', year).eq('month', month),
  ])
  if (cnt.error) throw cnt.error
  return { status: period?.status ?? null, saved: cnt.count || 0 }
}
export const rejectAdvance  = (id, reason) => rpc('reject_salary_advance', { p_id: id, p_reason: reason })
export async function requestAdvance(row) {
  return must(await supabase.from('salary_advances').insert(row).select().single())
}
