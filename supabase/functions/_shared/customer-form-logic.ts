// Logic behind the public customer-form edge function (/r/<token>, the LINE repair form).
// Pure: no Deno or supabase imports -- every read/write goes through CustomerFormDeps, so vitest
// imports this file from src/lib/customerForm.test.js.
//
// Actions: info | upload_url | submit. The tenant, client and LINE user always come from the token
// row, never from the request. Raw error text (SQL, storage) never reaches the client (ruling R7).

import {
  validateRepairForm, itemsDescription, preferredDayBounds,
  LIMITS, LOCATIONS, SYMPTOMS, SLOTS, TEXT_MAX, type FormPayload, type FormItem,
} from './repair-form.ts'

export type CustomerToken = {
  id: string
  tenantId: string
  clientId: string
  lineUserId: string
  purpose: string
  expiresAt: string
  usedAt: string | null
  refTicketNumber: string | null
}

export type SubmitRpcResult =
  | { status: 'ok'; ticket_id: string; ticket_number: string }
  | { status: 'already'; ticket_number: string }
  | { status: 'invalid'; reason: string }

export type CustomerFormDeps = {
  loadToken: (token: string) => Promise<CustomerToken | null>
  hasModule: (tenantId: string) => Promise<boolean>
  listSites: (tenantId: string, clientId: string) => Promise<{ id: string; name: string }[]>
  brand: (tenantId: string, clientId: string) => Promise<{ clientName: string; brandName: string }>
  countUploads: (tenantId: string, tokenId: string) => Promise<number>
  signUpload: (path: string) => Promise<{ signedUrl: string; token: string }>
  objectSize: (path: string) => Promise<number | null>
  submitRpc: (token: string, payload: unknown) => Promise<SubmitRpcResult | null>
  pushReceived: (tenantId: string, lineUserId: string, ticketNumber: string) => Promise<unknown>
}

export type FormResult = { status: number; body: Record<string, unknown> }

export const MAX_UPLOADS_PER_TOKEN = 120

// Ruling R4. HEIC is not here: the page converts every photo to JPEG first.
export const MIME_EXT: Readonly<Record<string, { ext: string; mediaType: 'image' | 'video' }>> = Object.freeze({
  'image/jpeg': { ext: 'jpg', mediaType: 'image' },
  'image/png': { ext: 'png', mediaType: 'image' },
  'video/mp4': { ext: 'mp4', mediaType: 'video' },
  'video/quicktime': { ext: 'mov', mediaType: 'video' },
  'video/webm': { ext: 'webm', mediaType: 'video' },
})

// Extension → media type, the same list the RPC accepts (jpeg included). Ruling R8.
const EXT_MEDIA: Readonly<Record<string, 'image' | 'video'>> = Object.freeze({
  jpg: 'image', jpeg: 'image', png: 'image', mp4: 'video', mov: 'video', webm: 'video',
})

export const MSG = Object.freeze({
  link: 'ลิงก์หมดอายุ กดแจ้งซ่อมใน LINE อีกครั้ง',
  upload: 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่',
  site: 'ไซท์ไม่ถูกต้อง',
  empty: 'ยังไม่มีรายการ',
  failed: 'ส่งไม่สำเร็จ กรุณาลองใหม่',
})

// Ruling R2.
const RPC_REASON_MSG: Readonly<Record<string, string>> = Object.freeze({
  site: MSG.site, path: MSG.upload, empty: MSG.empty, expired: MSG.link, not_found: MSG.link,
})

// Bangkok has no DST: a fixed +7 h offset is always right.
export function bangkokDay(nowMs: number): string {
  return new Date(nowMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

const ok = (body: Record<string, unknown>, status = 200): FormResult => ({ status, body })
const failed = (): FormResult => ({ status: 500, body: { errors: [MSG.failed] } })
const uploadFailed = (): FormResult => ({ status: 400, body: { errors: [MSG.upload] } })
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string => (typeof x === 'string' ? x : '')

type Refusal =
  | { reason: 'not_found' | 'expired' }
  | { reason: 'used'; ticketNumber: string | null }
  | { reason: 'line_bot_disabled' }
type TokenCheck = { tok: CustomerToken } | Refusal

// Order matches the RPC: unknown/wrong purpose, then used (so a used link always shows its number),
// then expired. The module gate comes last because it needs the tenant.
async function checkToken(token: string, deps: CustomerFormDeps, now: number): Promise<TokenCheck> {
  const tok = await deps.loadToken(token)
  if (!tok || tok.purpose !== 'repair_form') return { reason: 'not_found' }
  if (tok.usedAt) return { reason: 'used', ticketNumber: tok.refTicketNumber ?? null }
  const exp = Date.parse(tok.expiresAt)
  if (!Number.isFinite(exp) || exp <= now) return { reason: 'expired' }
  if (!(await deps.hasModule(tok.tenantId))) return { reason: 'line_bot_disabled' }
  return { tok }
}

// Refusal for upload_url / submit (info answers 200 with just {reason}).
function refuse(c: Refusal): FormResult {
  if (c.reason === 'used') {
    const n = c.ticketNumber ?? ''
    return ok({ reason: 'used', ticketNumber: n, errors: [`ส่งเรื่องนี้แล้ว เลขที่ ${n}`] }, 400)
  }
  if (c.reason === 'line_bot_disabled') return ok({ reason: 'line_bot_disabled', errors: [MSG.failed] }, 403)
  return ok({ reason: c.reason, errors: [MSG.link] }, 400)
}

function randomSuffix(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => abc[b % abc.length]).join('')
}

async function info(token: string, deps: CustomerFormDeps, now: number): Promise<FormResult> {
  const c = await checkToken(token, deps, now)
  if ('reason' in c) {
    if (c.reason === 'used') return ok({ reason: 'used', ticketNumber: c.ticketNumber })
    return ok({ reason: c.reason })
  }
  const { tok } = c
  const sites = await deps.listSites(tok.tenantId, tok.clientId)
  if (!sites.length) return ok({ reason: 'no_sites' })
  const { clientName, brandName } = await deps.brand(tok.tenantId, tok.clientId)
  return ok({
    ok: true,
    clientName,
    brandName,
    sites: sites.map((s) => ({ id: s.id, name: s.name })),
    bounds: preferredDayBounds(bangkokDay(now)),
    locations: LOCATIONS,
    symptoms: SYMPTOMS,
    limits: LIMITS,
    slots: SLOTS,
  })
}

async function uploadUrl(body: Record<string, unknown>, deps: CustomerFormDeps, now: number): Promise<FormResult> {
  const kind = MIME_EXT[str(body.mime)]
  if (!kind || body.mediaType !== kind.mediaType) return ok({ error: 'bad_type' }, 400)
  const bytes = body.bytes
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ok({ error: 'bad_size' }, 400)
  if (bytes > LIMITS.maxBytes) return ok({ error: 'too_big' }, 400)

  const c = await checkToken(str(body.token), deps, now)
  if ('reason' in c) return refuse(c)
  const { tok } = c

  if ((await deps.countUploads(tok.tenantId, tok.id)) >= MAX_UPLOADS_PER_TOKEN) return ok({ error: 'too_many' }, 429)

  const path = `${tok.tenantId}/form-${tok.id}/${now}-${randomSuffix()}.${kind.ext}`
  const signed = await deps.signUpload(path)
  return ok({ path, signedUrl: signed.signedUrl, uploadToken: signed.token })
}

// Rebuild the payload from known fields only, so nothing extra reaches the RPC.
function cleanPayload(p: Record<string, unknown>): FormPayload {
  const items = Array.isArray(p.items) ? p.items : []
  return {
    siteId: str(p.siteId),
    preferredDays: Array.isArray(p.preferredDays) ? p.preferredDays.map(str) : [],
    preferredSlot: (typeof p.preferredSlot === 'string' ? p.preferredSlot : null) as FormPayload['preferredSlot'],
    note: str(p.note).slice(0, TEXT_MAX.note),
    items: items.map((raw): FormItem => {
      const it = isObj(raw) ? raw : {}
      const files = Array.isArray(it.files) ? it.files : []
      return {
        location: str(it.location),
        room: str(it.room).slice(0, TEXT_MAX.room),
        symptom: str(it.symptom),
        note: str(it.note).slice(0, TEXT_MAX.note),
        files: files.map((f) => {
          const o = isObj(f) ? f : {}
          const file: FormItem['files'][number] = {
            path: str(o.path),
            mediaType: o.mediaType as 'image' | 'video',
            bytes: o.bytes as number,
          }
          if (typeof o.seconds === 'number') file.seconds = o.seconds
          return file
        }),
      }
    }),
  }
}

const extOf = (path: string): string => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase()

async function submit(body: Record<string, unknown>, deps: CustomerFormDeps, now: number): Promise<FormResult> {
  const token = str(body.token)
  const c = await checkToken(token, deps, now)
  if ('reason' in c) {
    // A second send after success (double tap, back button) is not an error: show the same number.
    if (c.reason === 'used' && c.ticketNumber) return ok({ ok: true, ticketNumber: c.ticketNumber, already: true })
    return refuse(c)
  }
  const { tok } = c

  if (!isObj(body.payload)) return ok({ errors: [MSG.empty] }, 400)
  const p = cleanPayload(body.payload)

  const errors = validateRepairForm(p, bangkokDay(now))
  if (errors.length) return ok({ errors }, 400)

  // Every file: inside this token's folder, extension matches its media type (R8), then really stored.
  const prefix = `${tok.tenantId}/form-${tok.id}/`
  const files = p.items.flatMap((it) => it.files)
  for (const f of files) {
    if (!f.path.startsWith(prefix) || f.path.length === prefix.length || f.path.includes('..')) return uploadFailed()
    if (EXT_MEDIA[extOf(f.path)] !== f.mediaType) return uploadFailed()
  }
  const sizes = await Promise.all(files.map((f) => deps.objectSize(f.path)))
  if (sizes.some((s) => typeof s !== 'number' || !Number.isFinite(s) || s > LIMITS.maxBytes)) return uploadFailed()
  files.forEach((f, i) => { f.bytes = sizes[i] as number })

  const note = (p.note ?? '').trim()
  const description = itemsDescription(p.items) + (note ? `\nหมายเหตุ: ${note}` : '')
  const rpcPayload = {
    siteId: p.siteId,
    description,
    preferredDays: p.preferredDays,
    preferredSlot: p.preferredSlot,
    items: p.items.map((it) => ({
      location: it.location,
      room: it.room,
      symptom: it.symptom,
      note: it.note,
      files: it.files.map((f) => ({ path: f.path, mediaType: f.mediaType, bytes: f.bytes })),
    })),
  }

  let res: SubmitRpcResult | null
  try {
    res = await deps.submitRpc(token, rpcPayload)
  } catch (e) {
    console.error('customer-form: submit rpc failed', (e as Error)?.name ?? 'Error')
    return failed()
  }

  if (res?.status === 'already') return ok({ ok: true, ticketNumber: res.ticket_number, already: true })
  if (res?.status === 'invalid') {
    const msg = RPC_REASON_MSG[res.reason]
    return msg ? ok({ errors: [msg] }, 400) : failed()
  }
  if (res?.status !== 'ok' || !res.ticket_number) return failed()

  try {
    await deps.pushReceived(tok.tenantId, tok.lineUserId, res.ticket_number)
  } catch (e) {
    // The done screen shows the number anyway; a push problem never fails the submit.
    console.error('customer-form: received push failed', (e as Error)?.name ?? 'Error')
  }
  return ok({ ok: true, ticketNumber: res.ticket_number })
}

export async function handleCustomerForm(body: unknown, deps: CustomerFormDeps, now: number): Promise<FormResult> {
  if (!isObj(body)) return ok({ error: 'bad_request' }, 400)
  const token = str(body.token)
  if (!token || token.length > 128) return ok({ error: 'missing_token' }, 400)
  try {
    switch (body.action) {
      case 'info': return await info(token, deps, now)
      case 'upload_url': return await uploadUrl(body, deps, now)
      case 'submit': return await submit(body, deps, now)
      default: return ok({ error: 'unknown_action' }, 400)
    }
  } catch (e) {
    console.error('customer-form failed', (e as Error)?.name ?? 'Error')
    return failed()
  }
}
