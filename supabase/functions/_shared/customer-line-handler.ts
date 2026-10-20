// Pure event handler for the customer LINE bot. No Deno or supabase imports: this
// file is also imported by vitest from src/lib. Deps may throw; the HTTP shell is
// the only place that catches.
import { matchCustomerCommand, looksLikeInviteCode } from './customer-line-commands.ts'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, warrantyFlex, contactText, statusText,
  type SiteStatus,
} from './customer-line-replies.ts'
import {
  repairStartText, repairPickSiteText, repairCancelledText, repairTooBigText,
  repairNoTicketsText, repairStatusFlex, mediaTooBig, repairGotItText, repairReceivedFlex, quickReplyLabel, type RepairTicket, type MediaCounts,
  repairChooserText, repairAddStartText, repairAddNotFoundText, repairAddCancelledText, repairAddedLine, MAX_CHOOSER_TICKETS,
} from './repair.ts'
import type { LineMessage, QuickReplyItem } from './line-reply.ts'

export type RepairMediaType = 'image' | 'video' | 'file'
// mode 'new' = the session's ticket was opened by this report; 'add' = adding to an existing open ticket
// (ticketNumber names it in the replies). A row written before migration -13 reads as 'new'.
export type RepairSession = { ticketId: string; siteName: string; expiresAt: string; mode?: 'new' | 'add'; startedAt?: string; ticketNumber?: string }
export type RepairSessionStart = { mode: 'new' | 'add'; ticketNumber: string; siteName: string }

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
  // New pending_review ticket (source line) + a session expiring in 30 minutes. If another active
  // session already exists (double tap), returns that session's ticket instead of a new one.
  startRepair: (clientId: string, siteId: string, lineUserId: string, displayName: string | null) => Promise<{ ticketId: string; siteName: string }>
  appendRepairText: (ticketId: string, text: string) => Promise<void>
  // Sets repair_tickets.customer_update_at = now() (staff badge + bell). Add sessions only.
  markCustomerUpdate: (ticketId: string) => Promise<void>
  // This client's open tickets (pending_review / received / scheduled / in_progress) on one site, newest first.
  listOpenTickets: (clientId: string, siteId: string) => Promise<RepairTicket[]>
  // Opens a 30-minute add session on the client's own OPEN ticket with this number; null = not theirs / closed.
  // Same rules as startRepair: only an expired session is cleared; if an active one already exists
  // (concurrent start) that session is returned instead, whatever its mode.
  startAddSession: (clientId: string, ticketNumber: string, lineUserId: string) => Promise<RepairSessionStart | null>
  storeRepairMedia: (ticketId: string, messageId: string, mediaType: RepairMediaType, fileName?: string) => Promise<'ok' | 'too_big' | 'error'>
  // Deletes the session (even an expired one); null when there was none. In an add session the counts
  // cover only what this session added.
  finishRepair: (lineUserId: string) => Promise<{ ticketNumber: string; siteName: string; counts: MediaCounts; mode?: 'new' | 'add' } | null>
  // New session: deletes its ticket (only while still pending_review), its media rows, storage objects
  // and the session -> 'cancelled'. 'kept' = staff already picked it up; nothing deleted, session left
  // for finishRepair. Add session: removes only this session's customer media and restores the
  // description, never the ticket -> 'reverted'.
  cancelRepair: (lineUserId: string) => Promise<'cancelled' | 'kept' | 'reverted'>
  listRepairTickets: (clientId: string) => Promise<RepairTicket[]>
}

const FINISH_TEXT = 'ส่งครบแล้ว'
const CANCEL_TEXT = 'ยกเลิก'
const PICK_PREFIX = 'แจ้งซ่อม:'
const NEW_PREFIX = 'แจ้งเรื่องใหม่:'
const ADD_PREFIX = 'เพิ่มเรื่อง:'
const TICKET_NUMBER = /^[A-Za-z0-9-]{1,40}$/
const MAX_QUICK_REPLIES = 13
const MAX_ACTION_TEXT = 300
const MEDIA_TYPES: RepairMediaType[] = ['image', 'video', 'file']

const qrItem = (label: string, text: string): QuickReplyItem => ({ type: 'action', action: { type: 'message', label: quickReplyLabel(label), text } })

// LINE hides quick replies as soon as the customer sends anything, so every reply during a report carries them again.
function sessionReply(text: string): LineMessage {
  return { type: 'text', text, quickReply: { items: [qrItem(FINISH_TEXT, FINISH_TEXT), qrItem(CANCEL_TEXT, CANCEL_TEXT)] } }
}

function startReply(siteName: string): LineMessage {
  return sessionReply(repairStartText(siteName))
}

// The start reply of whichever session is open (new report or adding to an existing ticket).
function sessionStartReply(s: { mode?: string; ticketNumber?: string; siteName: string }): LineMessage {
  return s.mode === 'add' ? sessionReply(repairAddStartText(s.ticketNumber ?? '', s.siteName)) : startReply(s.siteName)
}

function finishedReply(done: { ticketNumber: string; siteName: string; counts: MediaCounts; mode?: string } | null): LineMessage[] {
  if (!done) return []
  return [repairReceivedFlex(done.ticketNumber, done.siteName, done.counts, { added: done.mode === 'add' })]
}

// "เพิ่มในเรื่องเดิม หรือแจ้งเรื่องใหม่?" with one quick reply per open ticket (max 3) + แจ้งเรื่องใหม่.
function chooserReply(siteName: string, open: RepairTicket[]): LineMessage {
  const shown = open.slice(0, MAX_CHOOSER_TICKETS)
  return {
    type: 'text', text: repairChooserText(siteName, shown),
    quickReply: {
      items: [
        ...shown.map((t) => qrItem(`เพิ่มใน ${t.ticket_number}`, `${ADD_PREFIX}${t.ticket_number}`)),
        qrItem('แจ้งเรื่องใหม่', `${NEW_PREFIX}${siteName}`),
      ],
    },
  }
}

// Photos picked together arrive as separate events sharing an imageSet: ack only the last one.
// deno-lint-ignore no-explicit-any
function lastOfSet(message: any): boolean {
  const set = message?.imageSet
  if (!set || !Number(set.total)) return true
  return Number(set.index) === Number(set.total)
}

function pickSiteReply(sites: { name: string }[]): LineMessage {
  return {
    type: 'text', text: repairPickSiteText(),
    quickReply: {
      items: sites
        .filter((s) => `${PICK_PREFIX}${s.name}`.length <= MAX_ACTION_TEXT)
        .slice(0, MAX_QUICK_REPLIES)
        .map((s) => qrItem(s.name, `${PICK_PREFIX}${s.name}`)),
    },
  }
}

// '<prefix><name>' -> name (trimmed), else null. Default prefix 'แจ้งซ่อม:'.
function parsePick(text: string, prefix = PICK_PREFIX): string | null {
  const t = text.trim()
  return t.startsWith(prefix) ? t.slice(prefix.length).trim() : null
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
      return [sessionReply(repairTooBigText())]
    }
    const fileName = msgType === 'file' && typeof event.message.fileName === 'string' ? event.message.fileName : undefined
    const r = await deps.storeRepairMedia(session.ticketId, messageId, msgType, fileName)
    if (r === 'too_big') return [sessionReply(repairTooBigText())]
    if (r !== 'ok' || event.deliveryContext?.isRedelivery === true) return []
    if (session.mode === 'add') await deps.markCustomerUpdate(session.ticketId)
    return lastOfSet(event.message) ? [sessionReply(repairGotItText())] : []
  }
  if (msgType !== 'text') return []
  const text: string = event.message.text ?? ''
  // LINE redelivers events our earlier attempt may already have handled: skip non-idempotent writes.
  const redelivery = event.deliveryContext?.isRedelivery === true

  const account = await deps.getAccount(userId)
  if (account) await deps.touchAccount(userId)

  const session = account ? await deps.getRepairSession(userId) : null
  const active = isActive(session, now) ? session : null
  const trimmed = text.trim()
  const cmd = matchCustomerCommand(text)
  const pick = parsePick(text)
  const newPick = parsePick(text, NEW_PREFIX)
  const addPick = parsePick(text, ADD_PREFIX)

  if (account) {
    // A late "ส่งครบแล้ว" (after expiry) still closes the stale session and confirms.
    if (trimmed === FINISH_TEXT) return finishedReply(await deps.finishRepair(userId))
    if (active) {
      if (trimmed === CANCEL_TEXT) {
        const r = await deps.cancelRepair(userId)
        if (r === 'cancelled') return txt(repairCancelledText())
        if (r === 'reverted') return txt(repairAddCancelledText())
        // Staff already took the ticket: confirm it as received instead (R12).
        return finishedReply(await deps.finishRepair(userId))
      }
      // Pressing แจ้งซ่อม (or a chooser / status-card button) again keeps the open session
      // instead of starting a second one; finish or cancel it first.
      if (cmd === 'repair' || pick !== null || newPick !== null || addPick !== null) return [sessionStartReply(active)]
      // Other menu commands are answered below; the session stays open.
      if (!cmd) {
        if (!trimmed || redelivery) return []
        if (active.mode === 'add') {
          await deps.appendRepairText(active.ticketId, repairAddedLine(trimmed, now))
          await deps.markCustomerUpdate(active.ticketId)
        } else {
          await deps.appendRepairText(active.ticketId, trimmed)
        }
        return [sessionReply(repairGotItText())]
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

  if (pick !== null || newPick !== null) {
    if (!account) return txt(notLinkedText((await deps.getContact()).brandName))
    // แจ้งเรื่องใหม่:<site> = the chooser's "new ticket" answer: no second ask.
    return redelivery ? [] : await startOrPick(account.clientId, userId, pick ?? newPick, deps, newPick !== null)
  }

  if (addPick !== null) {
    if (!account) return txt(notLinkedText((await deps.getContact()).brandName))
    if (redelivery) return []
    if (!TICKET_NUMBER.test(addPick)) return txt(repairAddNotFoundText())
    const started = await deps.startAddSession(account.clientId, addPick, userId)
    return started ? [sessionStartReply(started)] : txt(repairAddNotFoundText())
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

  if (cmd === 'repair') return redelivery ? [] : await startOrPick(account.clientId, userId, null, deps)
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
// If the chosen site still has open tickets of this client, ask first (add to one, or new), unless
// forceNew (the customer already answered "แจ้งเรื่องใหม่").
async function startOrPick(clientId: string, userId: string, pick: string | null, deps: CustomerDeps, forceNew = false): Promise<LineMessage[]> {
  const sites = await deps.listClientSites(clientId)
  if (sites.length === 0) return [{ type: 'text', text: contactText(await deps.getContact()) }]
  let chosen = sites.length === 1 && pick === null ? sites[0] : null
  if (pick !== null) chosen = sites.find((s) => s.name.trim() === pick) ?? null
  if (!chosen) return [pickSiteReply(sites)]
  // A name too long for the แจ้งเรื่องใหม่ action text cannot be offered as a button: start new as before.
  if (!forceNew && `${NEW_PREFIX}${chosen.name}`.length <= MAX_ACTION_TEXT) {
    const open = await deps.listOpenTickets(clientId, chosen.id)
    if (open.length > 0) return [chooserReply(chosen.name, open)]
  }
  const started = await deps.startRepair(clientId, chosen.id, userId, await deps.getDisplayName(userId))
  return [startReply(started.siteName)]
}
