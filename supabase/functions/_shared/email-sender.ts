// _shared/email-sender.ts -- the one place that sends mail through Resend.
//
// Mail goes out as CHANG <noreply@changpm.app> (the domain verified in Resend
// for the product). If Resend refuses that sender with a 4xx -- e.g. an older
// API key that is limited to a different domain -- it retries once from the
// previous sender so receipts and signing confirmations are never lost over a
// sender name. A 429 or 5xx is not retried here: the message was not refused
// for its sender.

export const EMAIL_FROM = 'CHANG <noreply@changpm.app>'
export const LEGACY_EMAIL_FROM = 'FacadeXPM <contact@facadex.co.th>'
export const EMAIL_REPLY_TO = 'support@changpm.app'

export type EmailPayload = { to: string[]; subject: string; html: string }
export type EmailResult = { ok: boolean; status: number; error?: string }

export async function sendResendEmail(
  apiKey: string,
  payload: EmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailResult> {
  const attempt = (from: string) =>
    fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, reply_to: EMAIL_REPLY_TO, ...payload }),
    })

  let res = await attempt(EMAIL_FROM)
  if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) {
    res = await attempt(LEGACY_EMAIL_FROM)
  }
  if (res.ok) return { ok: true, status: res.status }
  return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) }
}
