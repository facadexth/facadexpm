// Pure helpers for the customer LINE OA connection (Settings card + invite links).
export function buildWebhookUrl(supabaseUrl, key) {
  return `${String(supabaseUrl || '').replace(/\/+$/, '')}/functions/v1/customer-line-webhook?t=${key}`
}

export function buildOaInviteLink(basicId, code) {
  return `https://line.me/R/oaMessage/@${String(basicId || '').replace(/^@/, '')}/?${code}`
}
