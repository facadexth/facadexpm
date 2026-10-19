// Pure event handler for the customer LINE bot. No Deno or supabase imports: this
// file is also imported by vitest from src/lib. Deps may throw; the HTTP shell is
// the only place that catches.
import { matchCustomerCommand, looksLikeInviteCode } from './customer-line-commands.ts'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, repairTempText,
  repairStatusTempText, warrantyTempText, contactText, statusText, type SiteStatus,
} from './customer-line-replies.ts'
import type { LineMessage } from './line-reply.ts'

export type CustomerDeps = {
  getAccount: (lineUserId: string) => Promise<{ clientId: string; clientName: string } | null>
  claimInvite: (code: string, lineUserId: string, displayName: string | null) => Promise<{ status: 'ok' | 'invalid'; clientName: string | null }>
  getDisplayName: (lineUserId: string) => Promise<string | null>
  loadSites: (clientId: string) => Promise<SiteStatus[]>
  loadPhotos: (clientId: string) => Promise<{ url: string }[]>
  getContact: () => Promise<{ companyName: string; phone: string | null; hours: string | null }>
  openRequest: (kind: 'quote' | 'repair', lineUserId: string, clientId: string | null, displayName: string | null) => Promise<void>
  touchAccount: (lineUserId: string) => Promise<void>
}

// deno-lint-ignore no-explicit-any
export async function handleCustomerEvent(event: any, ctx: { tenantId: string; today: string }, deps: CustomerDeps): Promise<LineMessage[]> {
  if (event?.type !== 'message' || event.message?.type !== 'text') return []
  const userId: string | undefined = event.source?.userId
  const text: string = event.message.text ?? ''
  if (!userId) return []

  const account = await deps.getAccount(userId)
  if (account) await deps.touchAccount(userId)
  const txt = (t: string): LineMessage[] => [{ type: 'text', text: t }]

  if (looksLikeInviteCode(text)) {
    const name = await deps.getDisplayName(userId)
    const claim = await deps.claimInvite(text.trim().toUpperCase(), userId, name)
    if (claim.status === 'ok') return txt(inviteOkText(claim.clientName ?? ''))
    // A linked user typing a 6-letter word (THANKS) must not get an error.
    if (!account) return txt(inviteInvalidText())
    return []
  }

  const cmd = matchCustomerCommand(text)
  if (!cmd) return []

  if (cmd === 'contact') return txt(contactText(await deps.getContact()))

  if (cmd === 'quote') {
    await deps.openRequest('quote', userId, account?.clientId ?? null, await deps.getDisplayName(userId))
    return txt(quoteText())
  }

  if (!account) return txt(notLinkedText())

  if (cmd === 'repair') {
    await deps.openRequest('repair', userId, account.clientId, await deps.getDisplayName(userId))
    return txt(repairTempText())
  }
  if (cmd === 'repair_status') return txt(repairStatusTempText())

  const sites = await deps.loadSites(account.clientId)
  if (cmd === 'warranty') return txt(warrantyTempText(sites))

  // status
  const photos = await deps.loadPhotos(account.clientId)
  return [
    { type: 'text', text: statusText(sites, ctx.today) },
    ...photos.map((p): LineMessage => ({ type: 'image', originalContentUrl: p.url, previewImageUrl: p.url })),
  ]
}
