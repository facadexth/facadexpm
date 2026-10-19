// Sends a LINE reply; if it fails and a flex message was in it, retries once with every flex
// replaced by its plain altText. No Deno or supabase imports (vitest imports this file).
// Never logs tokens, bodies or user ids.
import type { LineMessage } from './line-reply.ts'

type Send = (replyToken: string, msgs: LineMessage[]) => Promise<{ ok: boolean; status: number }>

export async function replyWithFallback(
  send: Send,
  replyToken: string,
  msgs: LineMessage[],
  log: (...a: unknown[]) => void = console.error,
): Promise<{ ok: boolean; status: number }> {
  const res = await send(replyToken, msgs)
  if (res.ok) return res
  log('customer-line reply failed', res.status, msgs.map((m) => m.type).join(','))
  if (!msgs.some((m) => m.type === 'flex')) return res
  const plain = msgs.map((m): LineMessage => (m.type === 'flex' ? { type: 'text', text: m.altText } : m))
  const retry = await send(replyToken, plain)
  if (!retry.ok) log('customer-line reply failed', retry.status, plain.map((m) => m.type).join(','))
  return retry
}
