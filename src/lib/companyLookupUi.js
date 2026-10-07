// Browser mirror of the server allowlist (supabase/functions/_shared/company-lookup.ts
// ALLOWED_DOMAINS; a test keeps them in sync). Used to render source links safely.
export const LOOKUP_ALLOWED_DOMAINS = ['dbd.go.th', 'rd.go.th', 'set.or.th', 'sec.or.th', 'dataforthai.com']

// Returns the URL only when it is https and on the allowlist, else null.
export function safeSourceUrl(u) {
  try {
    const url = new URL(u)
    if (url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase()
    return LOOKUP_ALLOWED_DOMAINS.some(d => host === d || host.endsWith('.' + d)) ? url.href : null
  } catch {
    return null
  }
}

const digitsOnly = v => String(v ?? '').replace(/[๐-๙]/g, ch => '๐๑๒๓๔๕๖๗๘๙'.indexOf(ch)).replace(/\D/g, '')
const squash = v => String(v ?? '').replace(/\s+/g, ' ').trim()

// One-click fill from an AI candidate. Only EMPTY form fields are patched; a non-empty
// field that differs is listed in `skipped` (user may replace it from the banner). The typed
// company name is never overwritten: a differing registered name is offered as nameSuggestion.
// current: { name, address, taxId } as typed in the form.
export function computeAutofill(cand, current) {
  const patch = {}
  const skipped = []
  const c = cand || {}
  const cur = current || {}

  const aiTax = digitsOnly(c.taxId)
  if (aiTax) {
    const have = String(cur.taxId ?? '').trim()
    if (!have) patch.taxId = aiTax
    else if (digitsOnly(have) !== aiTax) skipped.push({ key: 'taxId', current: have, ai: aiTax })
  }
  const aiAddr = squash(c.address)
  if (aiAddr) {
    const have = squash(cur.address)
    if (!have) patch.address = aiAddr
    else if (have !== aiAddr) skipped.push({ key: 'address', current: have, ai: aiAddr })
  }
  const aiName = squash(c.name)
  const nameSuggestion = aiName && squash(cur.name).toLowerCase() !== aiName.toLowerCase() ? aiName : null
  return { patch, skipped, nameSuggestion }
}
