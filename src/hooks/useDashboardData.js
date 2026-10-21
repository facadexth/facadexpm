// Data for the home dashboard cards. Each role gets ONE batched loader (Promise.all, no
// per-row queries). The PM loader touches no money table at all: worker_assignments and
// worker_checkins (PM read policies), pm_workers/pm_sites (SECURITY DEFINER RPCs) and
// site_progress_daily (a %), nothing else.
import { supabase } from '../lib/supabase.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
import { loadAssignmentsRange, useQuery } from './useSupabase.js'
import { addDaysIso, monthEndIso, weekRange } from '../lib/dashboardCards.js'

const unwrap = ({ data, error }) => { if (error) throw error; return data || [] }

const loadCheckins = today => supabase
  .from('worker_checkins')
  .select('worker_id, site_id, is_assembly, checkin_at, checkout_at')
  .eq('date', today)
  .then(unwrap)

// Unpaid = the same statuses payment_forecast and Expenses' 'unpaid' filter use.
const loadUnpaidExpenses = () => fetchAllRows(() => supabase
  .from('expenses')
  .select('id, amount, due_date, check_date, date, cheque_id')
  .in('status', ['pending', 'check_issued'])
  .order('id'))

export async function loadOwnerDashboard(today) {
  const ym = today.slice(0, 7)
  const [assignments, checkins, unpaid, quotations] = await Promise.all([
    loadAssignmentsRange(today, today),
    loadCheckins(today),
    loadUnpaidExpenses(),
    supabase.from('quotations').select('status').gte('date', `${ym}-01`).lte('date', monthEndIso(ym)).then(unwrap),
  ])
  return { assignments, checkins, unpaid, quotations }
}

export async function loadAdminDashboard(today) {
  const [assignments, checkins, unpaid, invoices] = await Promise.all([
    loadAssignmentsRange(today, today),
    loadCheckins(today),
    loadUnpaidExpenses(),
    fetchAllRows(() => supabase.from('invoices').select('id, total').eq('status', 'unpaid').order('id')),
  ])
  return { assignments, checkins, unpaid, invoices }
}

export async function loadPmDashboard(today) {
  const week = weekRange(today)
  const [weekAssignments, checkins, sites] = await Promise.all([
    loadAssignmentsRange(week.from, week.to),
    loadCheckins(today),
    fetchAllRows(() => supabase.rpc('pm_sites')),
  ])
  const todayAssignments = weekAssignments.filter(a => a.date === today)
  // Latest % ตามสัญญา snapshot of the sites that have people today, in ONE query.
  // (site_progress_pct() is not SECURITY DEFINER and reads sites, which PM cannot read,
  // so it would return nothing for a PM; the daily snapshot table is PM-readable.)
  const siteIds = [...new Set(todayAssignments.map(a => a.site_id).filter(Boolean))]
  const snaps = siteIds.length
    ? await supabase.from('site_progress_daily').select('site_id, day, contract_pct')
      .in('site_id', siteIds).gte('day', addDaysIso(today, -60)).order('day', { ascending: false }).then(unwrap)
    : []
  const pctBySite = {}
  for (const r of snaps) if (!(r.site_id in pctBySite)) pctBySite[r.site_id] = Number(r.contract_pct) || 0
  return { weekAssignments, todayAssignments, checkins, sites, pctBySite }
}

export const useOwnerDashboard = (today, enabled) => useQuery(() => (enabled ? loadOwnerDashboard(today) : null), [today, enabled])
export const useAdminDashboard = (today, enabled) => useQuery(() => (enabled ? loadAdminDashboard(today) : null), [today, enabled])
export const usePmDashboard = (today, enabled) => useQuery(() => (enabled ? loadPmDashboard(today) : null), [today, enabled])
