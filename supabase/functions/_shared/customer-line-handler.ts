// Pure event handler for the customer LINE bot. No Deno or supabase imports: this
// file is also imported by vitest from src/lib. Deps may throw; the HTTP shell is
// the only place that catches.
import { matchCustomerCommand, looksLikeInviteCode } from './customer-line-commands.ts'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, warrantyFlex, contactText, statusText,
  type SiteStatus,
} from './customer-line-replies.ts'
import {
  repairStartText, repairPickSiteText, repairReceivedText, repairCancelledText, repairTooBigText,
  repairNoTicketsText, repairStatusFlex, mediaTooBig, quickReplyLabel, type RepairTicket, type MediaCounts,
} from './repair.ts'
import type { LineMessage, QuickReplyItem } from './line-reply.ts'

export type RepairMediaType = 'image' | 'video' | 'file'
export type RepairSession = { ticketId: string; siteName: string; expiresAt: string }

export type CustomerDeps = {
  getAccount: (lineUserId: string) => Promise<{ clientId: string; clientName: string } | null>
  claimInvite: (code: string, lineUserId: string, displayName: string | null) => Promise<{ status: 'ok' | 'invalid'; clientName: string | null }>
  getDisplayName: (lineUserId: string) => Promise<string | null>
  loadSites: (clientId: string) => Promise<SiteStatus[]>
  loadPhotos: (clientId: string) => Promise<{ url: string }[]>
  getContact: () => Promise<{ companyName: string; phone: string | null; hours: string | null; brandName: string }>
  openRequest: (kind: 'quote', lineUserId: string, clientId: string | null, displayName: string | null) => Promise<void>
  touchAccount: (lineUserId: string) => Promise<void>
  // true = this (tenant, user) has not been welcomed yet today (Bangkok); the claim is atomic.
  claimWelcome: (lineUserId: string) => Promise<boolean>
  // Repair intake. The session row may be expired; the handler compares expiresAt with ctx.now.
  getRepairSession: (lineUserId: string) => Promise<RepairSession | null>
  // The client's non-Cancelled sites, most recent first.
  listClientSites: (clientId: string) => Promise<{ id: string; name: string }[]>
  // New pending_review ticket (source line) + a session expiring in 30 minutes (replaces any old session).
  startRepair: (clientId: string, siteId: string, lineUserId: string, displayName: string | null) => Promise<{ ticketId: string; siteName: string }>
  appendRepairText: (ticketId: string, text: string) => Promise<void>
  storeRepairMedia: (ticketId: string, messageId: string, mediaType: RepairMediaType, fileName?: string) => Promise<'ok' | 'too_big' | 'error'>
  // Deletes the session (even an expired one); null when there was none.
  finishRepair: (lineUserId: string) => Promise<{ ticketNumber: string; siteName: string; counts: MediaCounts } | null>
  // Deletes the session's ticket, its media rows and storage objects, and the session.
  cancelRepair: (lineUserId: string) => Promise<void>
  listRepairTickets: (clientId: string) => Promise<RepairTicket[]>
}

const FINISH_TEXT = 'ส่งครบแล้ว'
const CANCEL_TEXT = 'ยกเลิก'
const PICK_PREFIX = 'แจ้งซ่อม:'
const MAX_QUICK_REPLIES = 13
const MEDIA_TYPES: RepairMediaType[] = ['image', 'video', 'file']

const qrItem = (label: string, text: string): QuickReplyItem => ({ type: 'action', action: { type: 'message', label: quickReplyLabel(label), text } })

function startReply(siteName: string): LineMessage {
  return { type: 'text', text: repairStartText(siteName), quickReply: { items: [qrItem(FINISH_TEXT, FINISH_TEXT), qrItem(CANCEL_TEXT, CANCEL_TEXT)] } }
}

function pickSiteReply(sites: { name: string }[]): LineMessage {
  return {
    type: 'text', text: repairPickSiteText(),
    quickReply: { items: sites.slice(0, MAX_QUICK_REPLIES).map((s) => qrItem(s.name, `${PICK_PREFIX}${s.name}`)) },
  }
}

// 'แจ้งซ่อม:<name>' -> name (trimmed), else null.
function parsePick(text: string): string | null {
  const t = text.trim()
  return t.startsWith(PICK_PREFIX) ? t.slice(PICK_PREFIX.length).trim() : null
}

function isActive(s: RepairSession | null, now: number): s is RepairSession {
  if (!s) return false
  const exp = Date.parse(s.expiresAt)
  return Number.isFinite(exp) && exp > now
}

// deno-lint-ignore no-explicit-any
export async function handleCustomerEvent(event: any, ctx: { tenantId: string; today: string; now?: number }, deps: CustomerDeps): Promise<LineMessage[]> {
  const now = ctx.now ?? Date.now()
  if (event?.type === 'follow') {
    if (event.source?.type !== 'user' || !event.source?.userId) return []
    // Always greet a new friend; follow events are rare, so no daily claim here.
    if (await deps.getAccount(event.source.userId)) return []
    return [{ type: 'text', text: notLinkedText((await deps.getContact()).brandName) }]
  }
  if (event?.type !== 'message') return []
  // 1:1 chats only. In a group/room the bot must not answer, link, or open requests.
  if (event.source?.type !== 'user') return []
  const userId: string | undefined = event.source?.userId
  if (!userId) return []
  const txt = (t: string): LineMessage[] => [{ type: 'text', text: t }]

  const msgType = event.message?.type
  if (MEDIA_TYPES.includes(msgType)) {
    // Media only counts inside an active repair session (sessions exist only for linked accounts).
    const session = await deps.getRepairSession(userId)
    if (!isActive(session, now)) return []
    const messageId = String(event.message.id ?? '')
    if (!messageId) return []
    if (msgType === 'file' && Number(event.message.fileSize) > 0 && mediaTooBig(Number(event.message.fileSize))) {
      return txt(repairTooBigText())
    }
    const fileName = msgType === 'file' && typeof event.message.fileName === 'string' ? event.message.fileName : undefined
    const r = await deps.storeRepairMedia(session.ticketId, messageId, msgType, fileName)
    return r === 'too_big' ? txt(repairTooBigText()) : []
  }
  if (msgType !== 'text') return []
  const text: string = event.message.text ?? ''

  const account = await deps.getAccount(userId)
  if (account) await deps.touchAccount(userId)

  const session = account ? await deps.getRepairSession(userId) : null
  const active = isActive(session, now) ? session : null
  const trimmed = text.trim()
  const cmd = matchCustomerCommand(text)
  const pick = parsePick(text)

  if (account) {
    // A late "ส่งครบแล้ว" (after expiry) still closes the stale session and confirms.
    if (trimmed === FINISH_TEXT) {
      const done = await deps.finishRepair(userId)
      return done ? txt(repairReceivedText(done.ticketNumber, done.siteName, done.counts)) : []
    }
    if (active) {
      if (trimmed === CANCEL_TEXT) {
        await deps.cancelRepair(userId)
        return txt(repairCancelledText())
      }
      // Pressing แจ้งซ่อม again keeps the open report instead of starting a second ticket.
      if (cmd === 'repair' || pick !== null) return [startReply(active.siteName)]
      // Other menu commands are answered below; the session stays open.
      if (!cmd) {
        if (trimmed) await deps.appendRepairText(active.ticketId, trimmed)
        return []
      }
    }
  }

  if (looksLikeInviteCode(text)) {
    const name = await deps.getDisplayName(userId)
    const claim = await deps.claimInvite(text.trim().toUpperCase(), userId, name)
    if (claim.status === 'ok') return txt(inviteOkText(claim.clientName ?? ''))
    // A linked user typing a 6-letter word (THANKS) must not get an error.
    if (!account) return txt(inviteInvalidText())
    return []
  }

  if (pick !== null) {
    if (!account) return txt(notLinkedText((await deps.getContact()).brandName))
    return await startOrPick(account.clientId, userId, pick, deps)
  }

  if (!cmd) {
    // Ordinary chat from someone not linked yet: greet at most once per Bangkok day, else stay silent for staff.
    if (!account && await deps.claimWelcome(userId)) return txt(notLinkedText((await deps.getContact()).brandName))
    return []
  }

  if (cmd === 'contact') return txt(contactText(await deps.getContact()))

  if (cmd === 'quote') {
    await deps.openRequest('quote', userId, account?.clientId ?? null, await deps.getDisplayName(userId))
    return txt(quoteText())
  }

  if (!account) return txt(notLinkedText((await deps.getContact()).brandName))

  if (cmd === 'repair') return await startOrPick(account.clientId, userId, null, deps)
  if (cmd === 'repair_status') {
    const tickets = await deps.listRepairTickets(account.clientId)
    return tickets.length === 0 ? txt(repairNoTicketsText()) : [repairStatusFlex(tickets, ctx.today)]
  }

  const sites = await deps.loadSites(account.clientId)
  if (cmd === 'warranty') return [warrantyFlex(sites, ctx.today, (await deps.getContact()).brandName)]

  // status
  const photos = await deps.loadPhotos(account.clientId)
  const { brandName } = await deps.getContact()
  return [
    { type: 'text', text: statusText(sites, ctx.today, brandName) },
    ...photos.map((p): LineMessage => ({ type: 'image', originalContentUrl: p.url, previewImageUrl: p.url })),
  ]
}

// One site: start at once. Several: the picked name must be one of the client's own sites
// (exact name, first match), otherwise ask again. No sites: point them to contact.
async function startOrPick(clientId: string, userId: string, pick: string | null, deps: CustomerDeps): Promise<LineMessage[]> {
  const sites = await deps.listClientSites(clientId)
  if (sites.length === 0) return [{ type: 'text', text: contactText(await deps.getContact()) }]
  let chosen = sites.length === 1 && pick === null ? sites[0] : null
  if (pick !== null) chosen = sites.find((s) => s.name.trim() === pick) ?? null
  if (!chosen) return [pickSiteReply(sites)]
  const started = await deps.startRepair(clientId, chosen.id, userId, await deps.getDisplayName(userId))
  return [startReply(started.siteName)]
}
