// _shared/material-sites.ts -- which sites a worker may pick on the material-request form.
//
// Ongoing sites, plus Completed sites with a repair job on today (Bangkok): a scheduled ticket
// booked for today, or an in_progress ticket that started on or before today (multi-day jobs),
// so the repair crew can request materials too.

export type SiteOption = { id: string; name: string }

export const REPAIR_ACTIVE_STATUSES = ['scheduled', 'in_progress']

// Is the crew on this repair site today? scheduled -> only on its date; in_progress -> from its date on.
// Dates are ISO 'YYYY-MM-DD' strings, so string comparison is date order.
export function repairTicketOnSiteToday(row: { status?: string | null; scheduled_date?: string | null } | null | undefined, today: string): boolean {
  const d = row?.scheduled_date
  if (!d) return false
  if (row?.status === 'scheduled') return d === today
  if (row?.status === 'in_progress') return d <= today
  return false
}

// Merge, drop duplicates by id (first one wins) and sort by name.
export function mergeSiteLists(ongoing: SiteOption[] | null | undefined, repairSites: SiteOption[] | null | undefined): SiteOption[] {
  const byId = new Map<string, SiteOption>()
  for (const s of [...(ongoing ?? []), ...(repairSites ?? [])]) {
    if (s && s.id && !byId.has(s.id)) byId.set(s.id, { id: s.id, name: s.name })
  }
  return [...byId.values()].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th'))
}

// Rows from repair_tickets joined to sites(id, name) -> site options.
export function repairSiteOptions(rows: any[] | null | undefined): SiteOption[] {
  const out: SiteOption[] = []
  for (const r of rows ?? []) {
    const s = Array.isArray(r?.sites) ? r.sites[0] : r?.sites
    if (s?.id) out.push({ id: s.id, name: s.name })
  }
  return out
}
