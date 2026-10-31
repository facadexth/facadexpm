// Pure warranty date rules. No Deno/supabase imports: shared by the web app and the LINE webhook.
// All math is on 'YYYY-MM-DD' strings via UTC, so timezone never shifts a date.

export type WarrantyKind = 'not_handed_over' | 'none' | 'active' | 'expired'

function parts(d: string): [number, number, number] {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  return [y, m, day]
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function warrantyEnd(handoverDate: string | null | undefined, months: number): string | null {
  if (!handoverDate || !(months > 0)) return null
  const [y, m, d] = parts(handoverDate)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return fmt(ny, nm, Math.min(d, last))
}

function dayNumber(d: string): number {
  const [y, m, day] = parts(d)
  return Math.round(Date.UTC(y, m - 1, day) / 86400000)
}

export function warrantyStatus(
  handoverDate: string | null | undefined,
  months: number,
  today: string,
): { kind: WarrantyKind; end: string | null; daysLeft: number | null } {
  if (!handoverDate) return { kind: 'not_handed_over', end: null, daysLeft: null }
  const end = warrantyEnd(handoverDate, months)
  if (!end) return { kind: 'none', end: null, daysLeft: null }
  const daysLeft = dayNumber(end) - dayNumber(today)
  return { kind: daysLeft >= 0 ? 'active' : 'expired', end, daysLeft }
}

export function followupDue(
  site: {
    status?: string | null
    handover_date?: string | null
    warranty_months?: number | null
    warranty_followup_at?: string | null
  },
  today: string,
): boolean {
  if (site.status !== 'Completed') return false
  if (!site.handover_date) return false
  if (!((site.warranty_months ?? 0) > 0)) return false
  if (site.warranty_followup_at) return false
  const s = warrantyStatus(site.handover_date, site.warranty_months as number, today)
  return s.kind === 'active' && s.daysLeft !== null && s.daysLeft <= 30
}
