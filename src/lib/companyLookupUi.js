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
