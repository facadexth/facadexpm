// Logic behind the public repair-workorder edge function (/w/<token>, the crew's work order page,
// CRM phase 2a). Pure: no Deno or supabase imports -- every read/write goes through
// RepairWorkorderDeps, so vitest imports this file from src/lib/repairWorkorderLogic.test.js.
//
// Actions: view | sign | sign_link. The token is a line_deep_link_tokens row with
// action_type='repair_workorder', issued by LINE "งานวันนี้" to one worker for one ticket. It is
// multi-use (used_at ignored) until expires_at. The tenant, worker and ticket always come from the
// token row, never from the request. Every action re-checks that the worker is still assigned to the
// ticket, so a worker taken off the job loses the customer's address/photos at once.
// Raw error text (SQL, storage) never reaches the client.

import type { WorkOrder } from './repair-workorder.ts'

export type CrewToken = {
  id: string
  tenantId: string
  workerId: string
  actionType: string
  repairTicketId: string | null
  expiresAt: string
}
export type CrewWorker = { id: string; tenantId: string; name: string; nickname: string | null; status: string }
export type CrewTicket = {
  id: string; tenantId: string; ticketNumber: string; status: string; lineUserId: string | null
  scheduledDate: string | null // 'YYYY-MM-DD'
}
export type CrewReceipt = { id: string; signer_name: string; signed_at: string }

export type ReceiptInsert = {
  tenant_id: string
  document_type: 'repair_ticket'
  document_id: string
  signer_name: string
  signature_path: string
  signed_by: string
}
export type SignLinkInsert = {
  tenant_id: string
  document_type: 'repair_ticket'
  document_id: string
  created_by: string
}

export type RepairWorkorderDeps = {
  loadToken: (token: string) => Promise<CrewToken | null>
  loadWorker: (workerId: string) => Promise<CrewWorker | null>
  hasModule: (tenantId: string) => Promise<boolean>
  // A worker_assignments row for this worker + ticket on exactly `date` (ruling R6).
  isAssigned: (tenantId: string, workerId: string, ticketId: string, date: string) => Promise<boolean>
  loadTicket: (tenantId: string, ticketId: string) => Promise<CrewTicket | null>
  loadWorkOrder: (ticketId: string, tenantId: string, today: string) => Promise<WorkOrder>
  latestReceipt: (tenantId: string, ticketId: string) => Promise<CrewReceipt | null>
  uploadSignature: (path: string, bytes: Uint8Array) => Promise<void>
  removeSignature: (path: string) => Promise<void>
  insertReceipt: (row: ReceiptInsert) => Promise<CrewReceipt>
  createSignLink: (row: SignLinkInsert) => Promise<{ id: string }>
  // An unsigned, unexpired document_receipt_links row for this ticket created at/after sinceIso (R7).
  recentSignLink: (tenantId: string, ticketId: string, sinceIso: string, nowIso: string) => Promise<{ id: string } | null>
  // document_receipt_links for this ticket made by any crew member (created_by 'crew:%') at/after
  // sinceIso (start of today Bangkok): how many, and the newest one's id (F1 per-ticket daily cap).
  crewSignLinksSince: (tenantId: string, ticketId: string, sinceIso: string) => Promise<{ count: number; newestId: string | null }>
  pushCustomer: (tenantId: string, lineUserId: string | null, text: string) => Promise<{ sent: boolean }>
  appUrl: string
}

export type WorkorderResult = { status: number; body: Record<string, unknown> }

export const TOKEN_ACTION = 'repair_workorder'
export const DOCUMENT_TYPE = 'repair_ticket' as const
export const SIGNED_URL_SECONDS = 30 * 60
export const MAX_SIGNATURE_BYTES = 300 * 1024
export const SIGNER_NAME_MAX = 100
export const SIGN_LINK_REUSE_MS = 10 * 60 * 1000
export const CREW_SIGN_LINKS_PER_DAY = 3
const PNG_PREFIX = 'data:image/png;base64,'
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const ok = (body: Record<string, unknown>, status = 200): WorkorderResult => ({ status, body })
const failed = (): WorkorderResult => ({ status: 500, body: { error: 'failed' } })
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string => (typeof x === 'string' ? x : '')

// Bangkok has no DST: a fixed +7 h offset is always right.
function bangkokDay(nowMs: number): string {
  return new Date(nowMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// 00:00 Bangkok of the day containing nowMs, as a UTC ISO string.
function bangkokDayStartIso(nowMs: number): string {
  return new Date(`${bangkokDay(nowMs)}T00:00:00+07:00`).toISOString()
}

// 'data:image/png;base64,…' -> PNG bytes, or null when it is not a real PNG of 1..300 KB.
// The length is checked before decoding so a huge body is never decoded.
export function decodePngDataUrl(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_PREFIX)) return null
  const b64 = dataUrl.slice(PNG_PREFIX.length)
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const size = (b64.length / 4) * 3 - padding
  if (size > MAX_SIGNATURE_BYTES) return null
  let bin: string
  try {
    bin = atob(b64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  if (bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => bytes[i] !== b)) return null
  return bytes
}

type Refusal = { reason: 'not_found' | 'expired' | 'line_bot_disabled' | 'not_assigned' | 'declined' }
type Checked = { tok: CrewToken; worker: CrewWorker; ticket: CrewTicket }

// Order: unknown/wrong kind, expired, worker (active, same tenant), module, ticket, declined, assignment.
// Ruling R6: the worker must be on the ticket's CURRENT scheduled_date (the same rule the loader uses
// for the crew list). A reschedule keeps past rows, so "any date" would let a crew member who was
// moved off the job keep seeing the customer's address/photos. No scheduled_date -> not_assigned.
async function checkToken(token: string, deps: RepairWorkorderDeps, now: number): Promise<Checked | Refusal> {
  const tok = await deps.loadToken(token)
  if (!tok || tok.actionType !== TOKEN_ACTION || !tok.repairTicketId) return { reason: 'not_found' }
  const exp = Date.parse(tok.expiresAt)
  if (!Number.isFinite(exp) || exp <= now) return { reason: 'expired' }

  const worker = await deps.loadWorker(tok.workerId)
  if (!worker || worker.tenantId !== tok.tenantId || worker.status !== 'active') return { reason: 'not_found' }

  // Same gate as field-form for every LINE crew link (and the repairs page is a line_bot module page).
  if (!(await deps.hasModule(tok.tenantId))) return { reason: 'line_bot_disabled' }

  const ticket = await deps.loadTicket(tok.tenantId, tok.repairTicketId)
  if (!ticket || ticket.tenantId !== tok.tenantId) return { reason: 'not_found' }
  if (ticket.status === 'declined') return { reason: 'declined' }

  if (!ticket.scheduledDate) return { reason: 'not_assigned' }
  if (!(await deps.isAssigned(tok.tenantId, worker.id, ticket.id, ticket.scheduledDate))) return { reason: 'not_assigned' }
  return { tok, worker, ticket }
}

const crewBy = (w: CrewWorker): string => 'crew:' + (w.name || w.nickname || w.id)

async function view(c: Checked, deps: RepairWorkorderDeps, now: number): Promise<WorkorderResult> {
  const workOrder = await deps.loadWorkOrder(c.ticket.id, c.tok.tenantId, bangkokDay(now))
  return ok({ ok: true, workOrder })
}

async function sign(c: Checked, signerName: string, png: Uint8Array, force: boolean, deps: RepairWorkorderDeps, now: number): Promise<WorkorderResult> {
  const tenantId = c.tok.tenantId
  if (!force) {
    const existing = await deps.latestReceipt(tenantId, c.ticket.id)
    if (existing) return ok({ ok: true, already: true, receipt: existing })
  }
  const path = `${tenantId}/${DOCUMENT_TYPE}/${c.ticket.id}/${now}-crew.png`
  await deps.uploadSignature(path, png)
  let receipt: CrewReceipt
  try {
    receipt = await deps.insertReceipt({
      tenant_id: tenantId,
      document_type: DOCUMENT_TYPE,
      document_id: c.ticket.id,
      signer_name: signerName,
      signature_path: path,
      signed_by: crewBy(c.worker),
    })
  } catch (e) {
    console.error('repair-workorder: receipt insert failed', (e as Error)?.name ?? 'Error')
    try {
      await deps.removeSignature(path)
    } catch {
      // An orphan PNG is harmless; the receipt row is what counts.
    }
    return failed()
  }
  return ok({ ok: true, receipt })
}

// Ruling R7: sign_link spends the tenant's shared customer push budget, so
//  (a) already signed and no force -> the receipt, no link, no push;
//  (b) an unsigned, unexpired link made in the last 10 minutes -> its URL again, sent:false,
//      reused:true, no push;
//  (c) F1: at most CREW_SIGN_LINKS_PER_DAY crew-made links per ticket per Bangkok day -> after that
//      the newest one's URL, sent:false, capped:true, no new link, no push;
//  (d) the ticket has no customer LINE user -> a link is still made (the crew shows/shares it), no
//      push, sent:false, noLine:true.
// Whenever sent is false the page shows the URL so the crew can copy/share it.
async function signLink(c: Checked, force: boolean, deps: RepairWorkorderDeps, now: number): Promise<WorkorderResult> {
  const tenantId = c.tok.tenantId
  if (!force) {
    const existing = await deps.latestReceipt(tenantId, c.ticket.id)
    if (existing) return ok({ ok: true, already: true, receipt: existing })
  }
  const linkUrl = (id: string) => `${deps.appUrl}/sign/${id}`
  const recent = await deps.recentSignLink(tenantId, c.ticket.id, new Date(now - SIGN_LINK_REUSE_MS).toISOString(), new Date(now).toISOString())
  if (recent) return ok({ ok: true, sent: false, reused: true, url: linkUrl(recent.id) })

  const today = await deps.crewSignLinksSince(tenantId, c.ticket.id, bangkokDayStartIso(now))
  if (today.count >= CREW_SIGN_LINKS_PER_DAY && today.newestId) {
    return ok({ ok: true, sent: false, capped: true, url: linkUrl(today.newestId) })
  }

  const link = await deps.createSignLink({
    tenant_id: tenantId,
    document_type: DOCUMENT_TYPE,
    document_id: c.ticket.id,
    created_by: crewBy(c.worker),
  })
  const url = linkUrl(link.id)
  if (!c.ticket.lineUserId) return ok({ ok: true, sent: false, url, noLine: true })

  let sent = false
  try {
    const res = await deps.pushCustomer(tenantId, c.ticket.lineUserId, `กรุณาเซ็นรับงานซ่อม ${c.ticket.ticketNumber}\n${url}`)
    sent = res?.sent === true
  } catch (e) {
    // LINE refused or the tenant's push budget is spent: the crew still gets the link to show/copy.
    console.error('repair-workorder: sign link push failed', (e as Error)?.name ?? 'Error')
  }
  return ok({ ok: true, sent, url })
}

export async function handleRepairWorkorder(body: unknown, deps: RepairWorkorderDeps, now: number): Promise<WorkorderResult> {
  if (!isObj(body)) return ok({ error: 'bad_request' }, 400)
  const token = str(body.token)
  if (!token || token.length > 128) return ok({ error: 'missing_token' }, 400)
  const action = body.action
  if (action !== 'view' && action !== 'sign' && action !== 'sign_link') return ok({ error: 'unknown_action' }, 400)

  // Body checks for sign come before any DB read.
  let signerName = ''
  let png: Uint8Array | null = null
  if (action === 'sign') {
    signerName = str(body.signerName).trim()
    if (!signerName || signerName.length > SIGNER_NAME_MAX) return ok({ error: 'bad_name' }, 400)
    png = decodePngDataUrl(body.signaturePng)
    if (!png) return ok({ error: 'bad_signature' }, 400)
  }

  try {
    const c = await checkToken(token, deps, now)
    if ('reason' in c) return ok({ reason: c.reason })
    if (action === 'view') return await view(c, deps, now)
    if (action === 'sign') return await sign(c, signerName, png as Uint8Array, body.force === true, deps, now)
    return await signLink(c, body.force === true, deps, now)
  } catch (e) {
    console.error('repair-workorder failed', (e as Error)?.name ?? 'Error')
    return failed()
  }
}
