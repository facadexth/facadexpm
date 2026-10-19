// Multi-message LINE reply helper. No Deno or supabase imports: this file is also
// imported by vitest from src/lib. Never throws.

export type QuickReplyItem = { type: 'action'; action: { type: 'message'; label: string; text: string } }

export type LineMessage =
  | { type: 'text'; text: string; quickReply?: { items: QuickReplyItem[] } }
  | { type: 'flex'; altText: string; contents: object }
  | { type: 'image'; originalContentUrl: string; previewImageUrl: string }

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply'
const MAX_MESSAGES = 5

export async function sendLineReplyMessages(
  accessToken: string,
  replyToken: string,
  messages: LineMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(LINE_REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ replyToken, messages: messages.slice(0, MAX_MESSAGES) }),
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
