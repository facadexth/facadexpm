// _shared/todays-sites.ts -- "which site(s) is this worker on today" for the LINE bot.
//
// A worker can have more than one site on the same day (e.g. morning at one site,
// evening at another). Bug found live 2026-10-19: the bot took an arbitrary one, so a
// worker standing at the morning site got a check-in link for the evening site.
// Owner decision: when there are 2+ DIFFERENT sites today, the worker picks the site
// (one link per site); a single-site day works exactly as before.
//
// Pure (no Deno imports) so vitest can import it: src/lib/todaysSites.test.js.

export type Shift = 'morning' | 'evening'
export type NextAction = 'check_in' | 'check_out' | 'done'

export type TodaysAssignment = { site_id: string | null; site_name: string | null; shift: string | null; type?: string | null }
export type TodaysCheckin = { site_id: string | null; checkin_at: string | null; checkout_at: string | null }
export type TodaysSite = { siteId: string; siteName: string; shifts: Shift[]; nextAction: NextAction }

const SHIFT_RANK: Record<Shift, number> = { morning: 0, evening: 1 }
const isShift = (s: unknown): s is Shift => s === 'morning' || s === 'evening'

// A site with no shift recorded counts as a full day, which starts in the morning.
const earliestRank = (shifts: Shift[]) => (shifts.length ? Math.min(...shifts.map((s) => SHIFT_RANK[s])) : 0)

// DISTINCT sites, ordered by earliest shift (morning before evening), then by name.
// nextAction comes from that site's own worker_checkins row.
export function todaysSites(assignments: TodaysAssignment[], checkins: TodaysCheckin[]): TodaysSite[] {
  const bySite = new Map<string, { siteName: string; shifts: Set<Shift> }>()
  for (const a of assignments ?? []) {
    if (!a?.site_id) continue
    let entry = bySite.get(a.site_id)
    if (!entry) {
      entry = { siteName: a.site_name ?? '', shifts: new Set() }
      bySite.set(a.site_id, entry)
    }
    if (!entry.siteName && a.site_name) entry.siteName = a.site_name
    if (isShift(a.shift)) entry.shifts.add(a.shift)
  }
  const checkinBySite = new Map<string, TodaysCheckin>()
  for (const c of checkins ?? []) if (c?.site_id) checkinBySite.set(c.site_id, c)

  const sites: TodaysSite[] = [...bySite.entries()].map(([siteId, e]) => {
    const shifts = [...e.shifts].sort((x, y) => SHIFT_RANK[x] - SHIFT_RANK[y])
    const row = checkinBySite.get(siteId)
    const nextAction: NextAction = !row?.checkin_at ? 'check_in' : !row.checkout_at ? 'check_out' : 'done'
    return { siteId, siteName: e.siteName, shifts, nextAction }
  })
  return sites.sort((a, b) => earliestRank(a.shifts) - earliestRank(b.shifts) || a.siteName.localeCompare(b.siteName, 'th'))
}

export function shiftLabel(shifts: Shift[]): 'เช้า' | 'บ่าย' | 'ทั้งวัน' {
  const m = shifts.includes('morning')
  const e = shifts.includes('evening')
  if (m && !e) return 'เช้า'
  if (e && !m) return 'บ่าย'
  return 'ทั้งวัน'
}

function shiftEmoji(shifts: Shift[]): string {
  const label = shiftLabel(shifts)
  return label === 'เช้า' ? '🌅' : label === 'บ่าย' ? '🌇' : '📍'
}

// For callers that need ONE site (photo filing, issue report, งานวันนี้, งานเสร็จ):
// before 12:00 Bangkok the first morning site, from 12:00 the first evening site,
// otherwise the first site. `bangkokHour` is 0-23.
export function pickSiteForNow<T extends { shifts: Shift[] }>(sites: T[], bangkokHour: number): T | null {
  if (!sites.length) return null
  const want: Shift = bangkokHour < 12 ? 'morning' : 'evening'
  return sites.find((s) => s.shifts.includes(want)) ?? sites[0]
}

// Which sites get a link in a multi-site reply.
//   mode 'auto'      -- the Rich Menu เช็คอิน/เช็คเอาท์ button: every site that is not done
//   mode 'check_in'  -- the typed เช็คอิน command: only sites still to check in
//   mode 'check_out' -- the typed เช็คเอาท์ command: only sites still to check out
// `enabled` drops an action the company turned off.
export function sitesNeedingLinks(
  sites: TodaysSite[],
  mode: 'auto' | 'check_in' | 'check_out',
  enabled: { check_in: boolean; check_out: boolean } = { check_in: true, check_out: true },
): TodaysSite[] {
  return sites.filter((s) => s.nextAction !== 'done'
    && (mode === 'auto' || s.nextAction === mode)
    && enabled[s.nextAction as 'check_in' | 'check_out'])
}

// The ONE reply for a 2+ site day. `links` maps siteId -> its link; a site with a link
// gets a link block, a done site gets a ✅ line, any other site is left out.
export function multiSiteReplyText(sites: TodaysSite[], links: Record<string, string>): string {
  const lines = [`📍 วันนี้คุณมี ${sites.length} ไซท์ — กดลิงก์ของไซท์ที่คุณอยู่ตอนนี้`, '']
  for (const s of sites) {
    const label = shiftLabel(s.shifts)
    const link = links[s.siteId]
    if (link && s.nextAction !== 'done') {
      lines.push(`${shiftEmoji(s.shifts)} ${label} · ${s.siteName} → ${s.nextAction === 'check_in' ? 'เช็คอิน' : 'เช็คเอาท์'}`)
      lines.push(link)
    } else if (s.nextAction === 'done') {
      lines.push(`✅ ${label} · ${s.siteName} — ครบแล้ว`)
    }
  }
  return lines.join('\n')
}
