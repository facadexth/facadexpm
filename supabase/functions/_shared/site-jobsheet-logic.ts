// Logic behind the public site-jobsheet edge function (/j/<token>, the crew's daily job sheet page,
// CRM G). Pure: no Deno or supabase imports -- every read/write goes through SiteJobsheetDeps, so
// vitest imports this file from src/lib/siteJobsheetLogic.test.js.
//
// Actions: view | upload_url | card_update. The token is a line_deep_link_tokens row with
// action_type='site_jobsheet', issued by LINE "งานวันนี้" to one worker for one site. It is multi-use
// (used_at ignored) until expires_at (end of that Bangkok day). The tenant, worker and site always
// come from the token row, never from the request. Every action re-checks that the worker still has an
// install assignment (repair_ticket_id null, type 'site') at the token's site on today's Bangkok date,
// so a worker moved to another site loses the sheet at once. Only today's team leader at that site may
// upload photos or move cards; other booked crew may view.
// Raw error text (SQL, storage) never reaches the client.

import type { JobSheet } from './site-jobsheet.ts'
import { isWorkerDoneable, doneBlockedMessage, doneErrorReply } from './lineTaskRules.ts'
import { bangkokDay } from './customer-form-logic.ts'

export type SheetToken = {
  id: string
  tenantId: string
  workerId: string
  actionType: string
  siteId: string | null
  expiresAt: string
}
export type SheetWorker = { id: string; tenantId: string; status: string }
// The worker's worker_assignments rows on one date (all sites, all kinds).
export type SheetAssignment = {
  siteId: string | null
  type: string | null
  repairTicketId: string | null
  isTeamLeader: boolean
}
export type SheetCard = {
  id: string
  tenantId: string
  siteId: string
  status: 'not_started' | 'in_progress' | 'done'
  progressMode: string | null
  parentTaskId: string | null
  hasChildren: boolean
}
export type PhotoInsert = {
  tenant_id: string
  worker_id: string
  site_id: string
  date: string
  photo_path: string
  description: string | null
  task_id: string
  customer_visible: false
}
// Result of a phase_tasks status update: how many rows changed, or the DB error message (never sent
// to the client; only mapped through doneErrorReply).
export type CardUpdateResult = { updated: number } | { errorMessage: string }

export type SiteJobsheetDeps = {
  loadToken: (token: string) => Promise<SheetToken | null>
  loadWorker: (workerId: string) => Promise<SheetWorker | null>
  hasModule: (tenantId: string) => Promise<boolean>
  loadAssignments: (tenantId: string, workerId: string, date: string) => Promise<SheetAssignment[]>
  loadSheet: (tenantId: string, siteId: string, date: string, viewerWorkerId: string) => Promise<JobSheet>
  // Objects already uploaded under `<tenant>/<site>/<date>/js-<tokenId>-` (the per-token daily cap).
  countUploads: (prefixDir: string, filePrefix: string) => Promise<number>
  signUpload: (path: string) => Promise<{ signedUrl: string; token: string }>
  // The stored object's size + mimetype (storage metadata), or null when it is not in the bucket.
  photoMeta: (path: string) => Promise<{ size: number | null; mimetype: string | null } | null>
  loadCard: (tenantId: string, siteId: string, taskId: string) => Promise<SheetCard | null>
  // Sets status on the card (tenant + site + id filters). fromStatus, when given, is an extra filter
  // (continue only moves a card that is still not_started).
  updateCardStatus: (tenantId: string, siteId: string, taskId: string, status: SheetCard['status'], fromStatus?: SheetCard['status']) => Promise<CardUpdateResult>
  insertPhotos: (rows: PhotoInsert[]) => Promise<string[]> // new line_site_photos ids
  deletePhotos: (tenantId: string, ids: string[]) => Promise<void>
}

export type JobsheetResult = { status: number; body: Record<string, unknown> }

export const TOKEN_ACTION = 'site_jobsheet'
export const PHOTO_BUCKET = 'line-site-photos'
export const SIGNED_URL_SECONDS = 30 * 60
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024
export const MAX_UPLOADS_PER_TOKEN_PER_DAY = 30
export const NOTE_MAX = 500
export const MAX_PHOTOS = 10
export const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png' })
const PHOTO_EXTS = new Set(['jpg', 'png'])
const PHOTO_MIMES = new Set(Object.keys(MIME_EXT))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Shown on the crew page when a continue kept its photos but the card's status could not move.
export const STATUS_UNCHANGED_NOTE = 'สถานะการ์ดไม่เปลี่ยน แจ้ง PM'

const ok = (body: Record<string, unknown>, status = 200): JobsheetResult => ({ status, body })
const failed = (): JobsheetResult => ({ status: 500, body: { error: 'failed' } })
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
const errName = (e: unknown) => (e as Error)?.name ?? 'Error'

function randomSuffix(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => abc[b % abc.length]).join('')
}

type Refusal = { reason: 'not_found' | 'expired' | 'line_bot_disabled' | 'not_assigned' }
type Checked = { tok: SheetToken & { siteId: string }; worker: SheetWorker; today: string; isLeader: boolean }

// Order: unknown/wrong kind, expired, worker (active, same tenant), module, assignment today at the site.
async function checkToken(token: string, deps: SiteJobsheetDeps, now: number): Promise<Checked | Refusal> {
  const tok = await deps.loadToken(token)
  if (!tok || tok.actionType !== TOKEN_ACTION || !tok.siteId) return { reason: 'not_found' }
  const exp = Date.parse(tok.expiresAt)
  if (!Number.isFinite(exp) || exp <= now) return { reason: 'expired' }

  const worker = await deps.loadWorker(tok.workerId)
  if (!worker || worker.tenantId !== tok.tenantId || worker.status !== 'active') return { reason: 'not_found' }

  if (!(await deps.hasModule(tok.tenantId))) return { reason: 'line_bot_disabled' }

  const today = bangkokDay(now)
  const rows = (await deps.loadAssignments(tok.tenantId, worker.id, today))
    .filter((a) => a.siteId === tok.siteId && a.type === 'site' && !a.repairTicketId)
  if (!rows.length) return { reason: 'not_assigned' }
  return { tok: tok as SheetToken & { siteId: string }, worker, today, isLeader: rows.some((a) => a.isTeamLeader === true) }
}

const sheetOf = (c: Checked, deps: SiteJobsheetDeps) => deps.loadSheet(c.tok.tenantId, c.tok.siteId, c.today, c.worker.id)

// Every photo path the crew page may send: `<tenant>/<site>/<date>/js-…` of today's sheet.
const photoDir = (c: Checked) => `${c.tok.tenantId}/${c.tok.siteId}/${c.today}`

async function view(c: Checked, deps: SiteJobsheetDeps): Promise<JobsheetResult> {
  return ok({ ok: true, sheet: await sheetOf(c, deps) })
}

async function uploadUrl(c: Checked, ext: string, deps: SiteJobsheetDeps, now: number): Promise<JobsheetResult> {
  if (!c.isLeader) return ok({ reason: 'not_leader' })
  const dir = photoDir(c)
  // The token id is part of the file name, so the cap counts this token's uploads only.
  const filePrefix = `js-${c.tok.id}-`
  if ((await deps.countUploads(dir, filePrefix)) >= MAX_UPLOADS_PER_TOKEN_PER_DAY) return ok({ error: 'too_many' }, 429)
  const path = `${dir}/${filePrefix}${now}-${randomSuffix()}.${ext}`
  const signed = await deps.signUpload(path)
  return ok({ path, signedUrl: signed.signedUrl, uploadToken: signed.token })
}

// Shape check (prefix, no '..', jpg/png); existence is checked against storage afterwards.
function photoShapeOk(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix) || path.length > 300 || path.includes('..')) return false
  const rest = path.slice(prefix.length)
  if (!rest || rest.includes('/')) return false
  const dot = rest.lastIndexOf('.')
  return dot > 0 && PHOTO_EXTS.has(rest.slice(dot + 1).toLowerCase())
}

type CardInput = { taskId: string; mode: 'done' | 'continue'; note: string; photos: string[] }

// Ruling R8 + fix round 1: photos are saved first, then the status moves.
//  - done: rules on the DB row (progress_mode, children) first -> blocked. If the status update is
//    refused (doneErrorReply text) -> blocked; any other failure -> failed. Either way the photo rows
//    just inserted are deleted again, so a refused "done" leaves nothing behind.
//  - continue: photos always stay. not_started -> in_progress is only tried when the card is
//    worker-doneable (quantity/parent status is derived by DB triggers). If the DB refuses or fails,
//    the photos are kept and the reply carries statusNote.
async function cardUpdate(c: Checked, input: CardInput, deps: SiteJobsheetDeps): Promise<JobsheetResult> {
  if (!c.isLeader) return ok({ reason: 'not_leader' })
  const tenantId = c.tok.tenantId
  const siteId = c.tok.siteId

  // Only this token's own uploads of today (upload_url names them js-<tokenId>-…).
  const prefix = `${photoDir(c)}/js-${c.tok.id}-`
  if (input.photos.some((p) => !photoShapeOk(p, prefix))) return ok({ error: 'bad_photo' }, 400)
  // Ruling R9: the stored object, not the client's upload_url claim, must be a JPEG/PNG within the limit.
  for (const p of input.photos) {
    const meta = await deps.photoMeta(p)
    if (!meta) return ok({ error: 'bad_photo' }, 400)
    if (typeof meta.size !== 'number' || !Number.isFinite(meta.size) || meta.size <= 0 || meta.size > MAX_PHOTO_BYTES) {
      return ok({ error: 'bad_photo' }, 400)
    }
    if (!meta.mimetype || !PHOTO_MIMES.has(meta.mimetype)) return ok({ error: 'bad_photo' }, 400)
  }

  const card = await deps.loadCard(tenantId, siteId, input.taskId)
  if (!card || card.tenantId !== tenantId || card.siteId !== siteId) return ok({ reason: 'card_not_found' })

  const rule = { progress_mode: card.progressMode, parent_task_id: card.parentTaskId, has_children: card.hasChildren }
  const doneable = isWorkerDoneable(rule)
  if (input.mode === 'done' && !doneable) {
    return ok({ reason: 'blocked', message: doneBlockedMessage(rule) ?? 'ปิดงานนี้ไม่ได้' })
  }

  let photoIds: string[]
  try {
    photoIds = await deps.insertPhotos(input.photos.map((p) => ({
      tenant_id: tenantId,
      worker_id: c.worker.id,
      site_id: siteId,
      date: c.today,
      photo_path: p,
      description: input.note || null,
      task_id: card.id,
      customer_visible: false as const,
    })))
  } catch (e) {
    console.error('site-jobsheet: photo insert failed', errName(e))
    return failed()
  }

  const undoPhotos = async () => {
    try {
      await deps.deletePhotos(tenantId, photoIds)
    } catch (e) {
      console.error('site-jobsheet: photo cleanup failed', errName(e))
    }
  }

  let statusNote: string | null = null
  if (input.mode === 'done') {
    if (card.status !== 'done') {
      let res: CardUpdateResult
      try {
        res = await deps.updateCardStatus(tenantId, siteId, card.id, 'done')
      } catch (e) {
        console.error('site-jobsheet: card update failed', errName(e))
        await undoPhotos()
        return failed()
      }
      if ('errorMessage' in res) {
        await undoPhotos()
        const reply = doneErrorReply(res.errorMessage)
        if (reply) return ok({ reason: 'blocked', message: reply })
        console.error('site-jobsheet: card update failed')
        return failed()
      }
      if (res.updated === 0) {
        await undoPhotos()
        return ok({ reason: 'card_not_found' })
      }
    }
  } else if (card.status === 'not_started') {
    if (!doneable) {
      // Quantity/parent cards: status follows qty/children, so it is not touched; photos are kept.
      statusNote = doneBlockedMessage(rule) ?? STATUS_UNCHANGED_NOTE
    } else {
      try {
        const res = await deps.updateCardStatus(tenantId, siteId, card.id, 'in_progress', 'not_started')
        // 0 rows: someone moved the card meanwhile -- it is no longer not_started, which is fine.
        if ('errorMessage' in res) statusNote = doneErrorReply(res.errorMessage) ?? STATUS_UNCHANGED_NOTE
      } catch (e) {
        console.error('site-jobsheet: card update failed', errName(e))
        statusNote = STATUS_UNCHANGED_NOTE
      }
    }
  }

  const sheet = await sheetOf(c, deps)
  return ok(statusNote ? { ok: true, sheet, statusNote } : { ok: true, sheet })
}

export async function handleSiteJobsheet(body: unknown, deps: SiteJobsheetDeps, now: number): Promise<JobsheetResult> {
  if (!isObj(body)) return ok({ error: 'bad_request' }, 400)
  const token = str(body.token)
  if (!token || token.length > 128) return ok({ error: 'missing_token' }, 400)
  const action = body.action
  if (action !== 'view' && action !== 'upload_url' && action !== 'card_update') return ok({ error: 'unknown_action' }, 400)

  // Body checks come before any DB read.
  let ext = ''
  let card: CardInput | null = null
  if (action === 'upload_url') {
    ext = MIME_EXT[str(body.mime)] ?? ''
    if (!ext) return ok({ error: 'bad_type' }, 400)
    const bytes = body.bytes
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ok({ error: 'bad_size' }, 400)
    if (bytes > MAX_PHOTO_BYTES) return ok({ error: 'too_big' }, 400)
  }
  if (action === 'card_update') {
    const taskId = str(body.taskId)
    if (!UUID_RE.test(taskId)) return ok({ error: 'bad_task' }, 400)
    const mode = body.mode
    if (mode !== 'done' && mode !== 'continue') return ok({ error: 'bad_mode' }, 400)
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return ok({ error: 'bad_note' }, 400)
    const note = str(body.note).trim()
    if (note.length > NOTE_MAX) return ok({ error: 'bad_note' }, 400)
    const photos = body.photos
    if (!Array.isArray(photos) || photos.length < 1 || photos.length > MAX_PHOTOS) return ok({ error: 'bad_photos' }, 400)
    if (photos.some((p) => typeof p !== 'string' || !p)) return ok({ error: 'bad_photo' }, 400)
    if (new Set(photos).size !== photos.length) return ok({ error: 'bad_photo' }, 400)
    card = { taskId, mode, note, photos: photos as string[] }
  }

  try {
    const c = await checkToken(token, deps, now)
    if ('reason' in c) return ok({ reason: c.reason })
    if (action === 'view') return await view(c, deps)
    if (action === 'upload_url') return await uploadUrl(c, ext, deps, now)
    return await cardUpdate(c, card as CardInput, deps)
  } catch (e) {
    console.error('site-jobsheet failed', errName(e))
    return failed()
  }
}
