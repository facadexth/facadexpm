// Reads everything the crew daily job sheet (ใบงานประจำวัน) shows and returns a JobSheetInput for
// buildJobSheet (_shared/site-jobsheet.ts). Shared by the web app (src/lib/siteJobsheetLoad.js,
// logged-in client under RLS) and the site-jobsheet edge function (service-role client), so:
//   - only plain supabase-js query calls (from/select/eq/is/gte/lte/order/maybeSingle), no Deno/web imports;
//   - nothing relies on RLS or the logged-in user: the site is read first and every other query is
//     also filtered by the site's tenant_id.
// Signed URLs come from the caller (signUrls), so the storage client and expiry stay the caller's choice.
// Every query error throws Error('โหลดใบงานไม่สำเร็จ: …').

import { runAtSite, RUN_WINDOW_DAYS, type JobSheetInput } from './site-jobsheet.ts'

export const DRAWINGS_BUCKET = 'site-drawings'
export const SAFETY_SETTING_KEY = 'site_safety_note_default'
const DAY_MS = 24 * 60 * 60 * 1000

// deno-lint-ignore no-explicit-any
type Db = any
export type SignUrls = (bucket: string, paths: string[]) => Promise<(string | null)[]>
export type JobSheetLoadOptions = {
  date: string // Bangkok YYYY-MM-DD
  tenant: JobSheetInput['tenant']
  viewerWorkerId?: string | null // crew page: the token's worker; staff PDF: omitted
  signUrls: SignUrls
  // Web only, for a PM (RLS hides sites and workers from PMs; they go through pm_sites()/pm_workers()):
  //   siteFallback -- the site row (with tenant_id) when the direct sites read returns no row;
  //   workerNames  -- names for crew whose workers(...) embed came back empty.
  // The edge function (service role) passes neither.
  siteFallback?: (siteId: string) => Promise<SiteRow | null>
  workerNames?: (workerIds: string[]) => Promise<Record<string, { name?: string | null; nickname?: string | null }>>
}

export type SiteRow = {
  id: string; tenant_id: string; name: string; site_number?: string | null; location?: string | null
  map_url?: string | null; lat?: number | null; lng?: number | null; safety_note?: string | null
}

const FAIL = 'โหลดใบงานไม่สำเร็จ: '

function fail(e: { message?: string } | null | undefined): never {
  throw new Error(FAIL + (e?.message || 'ไม่ทราบสาเหตุ'))
}

function shiftDay(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) fail({ message: 'วันที่ไม่ถูกต้อง' })
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * DAY_MS
  return new Date(t).toISOString().slice(0, 10)
}

// app_settings.value is TEXT; saveAppSetting stores String(value), but a JSON-encoded string
// ('"..."') is decoded too so either form works.
export function decodeSettingText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v.startsWith('"')) {
    try {
      const parsed = JSON.parse(v)
      if (typeof parsed === 'string') return parsed
    } catch { /* not JSON: use as typed */ }
  }
  return value
}

// Signs the non-empty paths in one call; result is aligned with `paths` (null where missing/failed).
async function signAligned(signUrls: SignUrls, bucket: string, paths: (string | null | undefined)[]): Promise<(string | null)[]> {
  const wanted = paths.filter((p): p is string => typeof p === 'string' && p !== '')
  if (!wanted.length) return paths.map(() => null)
  const signed = await signUrls(bucket, wanted)
  const byPath = new Map<string, string | null>()
  wanted.forEach((p, i) => byPath.set(p, signed?.[i] ?? null))
  return paths.map((p) => (p ? byPath.get(p) ?? null : null))
}

type AssignmentRow = {
  worker_id: string; shift?: string | null; is_team_leader?: boolean | null
  workers?: { name?: string | null; nickname?: string | null } | null
}
type TaskRow = {
  id: string; phase_id: string; name: string; zone?: string | null; status: JobSheetInput['cards'][number]['status']
  sort_order?: number | null; progress_mode?: string | null; planned_qty?: number | null; done_qty?: number | null
  issue_report_id?: string | null; parent_task_id?: string | null; status_changed_at?: string | null
  boq_items?: { unit?: string | null } | null
  phase_task_workers?: Array<{ worker_id: string }> | null
}

export async function loadJobSheetInput(db: Db, siteId: string, opts: JobSheetLoadOptions): Promise<JobSheetInput> {
  const { date, tenant, signUrls } = opts
  const viewerWorkerId = opts.viewerWorkerId || null

  const { data: siteRead, error: se } = await db.from('sites')
    .select('id, tenant_id, name, site_number, location, map_url, lat, lng, safety_note')
    .eq('id', siteId).maybeSingle()
  if (se) fail(se)
  let site = siteRead as SiteRow | null
  if (!site && opts.siteFallback) site = await opts.siteFallback(siteId)
  if (!site || !site.tenant_id) fail({ message: 'ไม่พบไซต์นี้' })
  const tenantId = site.tenant_id

  const { data: setting, error: ae } = await db.from('app_settings')
    .select('value')
    .eq('tenant_id', tenantId).eq('key', SAFETY_SETTING_KEY).maybeSingle()
  if (ae) fail(ae)

  // Crew = today's install assignments at this site (one row per shift -> one entry per worker,
  // shifts merged; leader when any of that worker's rows is marked). Repair visits are not installs.
  const { data: todayRows, error: ce } = await db.from('worker_assignments')
    .select('worker_id, shift, is_team_leader, workers(name, nickname)')
    .eq('tenant_id', tenantId).eq('site_id', site.id).eq('date', date).eq('type', 'site')
    .is('repair_ticket_id', null)
    .order('created_at', { ascending: true })
  if (ce) fail(ce)
  const crew: JobSheetInput['crew'] = []
  const byWorker = new Map<string, JobSheetInput['crew'][number]>()
  for (const r of (todayRows || []) as AssignmentRow[]) {
    let entry = byWorker.get(r.worker_id)
    if (!entry) {
      entry = { worker_id: r.worker_id, name: r.workers?.name || '', nickname: r.workers?.nickname || null, shifts: [], is_team_leader: false }
      byWorker.set(r.worker_id, entry)
      crew.push(entry)
    }
    if (r.shift && !entry.shifts.includes(r.shift)) entry.shifts.push(r.shift)
    if (r.is_team_leader) entry.is_team_leader = true
  }
  const nameless = crew.filter((c) => !c.name).map((c) => c.worker_id)
  if (nameless.length && opts.workerNames) {
    const names = await opts.workerNames(nameless)
    for (const c of crew) {
      if (c.name) continue
      const n = names?.[c.worker_id]
      if (n) { c.name = n.name || ''; c.nickname = n.nickname || null }
    }
  }

  // Run of days: the viewer (crew page) or else the first leader / first crew member (staff PDF).
  const runWorker = viewerWorkerId || crew.find((c) => c.is_team_leader)?.worker_id || crew[0]?.worker_id || null
  let run: JobSheetInput['run'] = null
  if (runWorker) {
    const { data: runRows, error: re } = await db.from('worker_assignments')
      .select('date, site_id')
      .eq('tenant_id', tenantId).eq('worker_id', runWorker).eq('type', 'site')
      .is('repair_ticket_id', null)
      .gte('date', shiftDay(date, -RUN_WINDOW_DAYS)).lte('date', shiftDay(date, RUN_WINDOW_DAYS))
    if (re) fail(re)
    // A day at another site (even half a day) breaks the run; today itself is always this sheet's day.
    run = runAtSite((runRows || []) as Array<{ date: string; site_id: string | null }>, site.id, date)
  }

  const { data: phases, error: pe } = await db.from('site_phases')
    .select('id, name, sort_order, is_issue_phase')
    .eq('tenant_id', tenantId).eq('site_id', site.id)
    .order('sort_order', { ascending: true })
  if (pe) fail(pe)

  const { data: tasks, error: ke } = await db.from('phase_tasks')
    .select('id, phase_id, name, zone, status, sort_order, progress_mode, planned_qty, done_qty, issue_report_id, parent_task_id, status_changed_at, boq_items(unit), phase_task_workers(worker_id)')
    .eq('tenant_id', tenantId).eq('site_id', site.id)
    .order('sort_order', { ascending: true })
  if (ke) fail(ke)
  const taskRows = (tasks || []) as TaskRow[]
  const parents = new Set(taskRows.map((t) => t.parent_task_id).filter((id): id is string => !!id))
  const cards: JobSheetInput['cards'] = taskRows.map((t) => ({
    id: t.id, phase_id: t.phase_id, name: t.name, zone: t.zone ?? null, status: t.status,
    sort_order: t.sort_order ?? null, progress_mode: t.progress_mode ?? null,
    planned_qty: t.planned_qty ?? null, done_qty: t.done_qty ?? null, unit: t.boq_items?.unit ?? null,
    issue_report_id: t.issue_report_id ?? null, parent_task_id: t.parent_task_id ?? null, has_children: parents.has(t.id),
    worker_ids: [...new Set((t.phase_task_workers || []).map((w) => w.worker_id).filter(Boolean))],
    status_changed_at: t.status_changed_at ?? null,
  }))

  const { data: drawingRows, error: de } = await db.from('site_drawings')
    .select('id, title, file_path, mime')
    .eq('tenant_id', tenantId).eq('site_id', site.id)
    .order('sort_order', { ascending: true })
  if (de) fail(de)
  const drawingList = (drawingRows || []) as Array<{ id: string; title: string; file_path: string; mime?: string | null }>
  const urls = await signAligned(signUrls, DRAWINGS_BUCKET, drawingList.map((d) => d.file_path))

  return {
    tenant: tenant || {},
    date,
    site: {
      id: site.id, name: site.name, site_number: site.site_number ?? null, location: site.location ?? null,
      map_url: site.map_url ?? null, lat: site.lat ?? null, lng: site.lng ?? null, safety_note: site.safety_note ?? null,
    },
    tenantSafetyDefault: decodeSettingText(setting?.value),
    run,
    crew,
    phases: (phases || []).map((p: { id: string; name: string; sort_order: number; is_issue_phase?: boolean | null }) => ({
      id: p.id, name: p.name, sort_order: p.sort_order, is_issue_phase: p.is_issue_phase === true,
    })),
    cards,
    drawings: drawingList.map((d, i) => ({ id: d.id, title: d.title, url: urls[i], mime: d.mime ?? null })),
    viewerWorkerId,
  }
}
