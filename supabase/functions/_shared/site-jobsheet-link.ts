// Crew LINE "งานวันนี้": one 📋 ใบงานวันนี้ link per install site the worker is booked at today.
// Pure rules here (unit-tested from src/lib/siteJobsheetLink.test.js); line-webhook does the DB
// reads and the token inserts. Token expiry reuses workOrderTokenExpiry (end of the Bangkok day).

import type { JobSheetRun } from './site-jobsheet.ts'

type JoinedSite = { name?: string | null }
export type InstallAssignmentRow = {
  site_id?: string | null
  type?: string | null
  repair_ticket_id?: string | null
  sites?: JoinedSite | JoinedSite[] | null
}

// Today's worker_assignments rows -> one entry per install site, in first-seen order. The
// site-jobsheet function accepts a token only when the worker has an install assignment (type
// 'site', repair_ticket_id null) at that site today, so repair rows and other types are skipped;
// morning + evening rows for the same site are de-duplicated.
export function installSitesToday(rows: InstallAssignmentRow[]): Array<{ siteId: string; siteName: string }> {
  const seen = new Set<string>()
  const out: Array<{ siteId: string; siteName: string }> = []
  for (const r of rows || []) {
    const id = r.site_id
    if (!id || r.repair_ticket_id) continue
    if (r.type != null && r.type !== 'site') continue
    if (seen.has(id)) continue
    seen.add(id)
    const s = Array.isArray(r.sites) ? r.sites[0] : r.sites
    out.push({ siteId: id, siteName: (s?.name || '').trim() || 'ไซต์' })
  }
  return out
}

// 'วันที่ 3/5', or null when the run is unknown.
export function jobSheetRunText(run: JobSheetRun | null | undefined): string | null {
  return run ? `วันที่ ${run.index}/${run.total}` : null
}

// Reply lines to append; url null = the token insert failed.
export function jobSheetLines(rows: Array<{ siteName: string; runText: string | null; url: string | null }>): string[] {
  return rows.flatMap((r) => [
    '',
    `📋 ใบงานวันนี้ ${r.siteName}${r.runText ? ` (${r.runText})` : ''}: ${r.url ?? 'เปิดไม่ได้ตอนนี้ ลองใหม่'}`,
  ])
}
