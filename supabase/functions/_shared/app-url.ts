// supabase/functions/_shared/app-url.ts
// The public base URL of the web app, used to build every link we send to
// people: LINE form links (/f/<token>), document signing links (/sign/<id>)
// and the payment return URL. One place, so moving the app to a new domain
// is a single secret (`supabase secrets set APP_URL=https://changpm.app`)
// plus redeploying the functions that import this file, not a code edit.
//
// A misconfigured value must never produce broken links, so anything that is
// not a plain https origin falls back to the current production URL.

export const DEFAULT_APP_URL = 'https://pm.facadex.co.th'

export function normalizeAppUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  return /^https:\/\/[^/\s]+$/.test(trimmed) ? trimmed : DEFAULT_APP_URL
}

// `Deno` is absent when vitest imports this file, hence the guard.
export const APP_URL = normalizeAppUrl(typeof Deno !== 'undefined' ? Deno.env.get('APP_URL') : undefined)
