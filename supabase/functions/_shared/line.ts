// supabase/functions/_shared/line.ts
// Shared LINE Messaging API primitives -- every function that talks to
// LINE (line-webhook, and Task 4's four scheduled push functions) goes
// through these three, so there is exactly one implementation of
// signature verification and exactly one of "send a message" to keep
// in sync with LINE's API, not five copies.

const LINE_API = 'https://api.line.me/v2/bot/message'

export async function verifyLineSignature(channelSecret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return expected === signatureHeader
}

export async function sendLinePush(accessToken: string, to: string, text: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${LINE_API}/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  return { ok: res.ok, status: res.status }
}

export async function sendLineReply(accessToken: string, replyToken: string, text: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${LINE_API}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
  return { ok: res.ok, status: res.status }
}

export async function linkRichMenuToUser(accessToken: string, lineUserId: string, richMenuId: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`https://api.line.me/v2/bot/user/${lineUserId}/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return { ok: res.ok, status: res.status }
}
