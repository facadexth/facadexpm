// supabase/functions/extract-map-coordinates/index.ts
// Resolves a Google Maps link (full or shortened, e.g.
// https://maps.app.goo.gl/xxxx) into {lat, lng} for Sites.jsx's "ดึง
// พิกัดจากลิงก์" button. A short link's destination (and the real
// coordinates) only exist after following its redirect -- the browser
// can't do that itself and read the final URL (cross-origin redirect
// target isn't readable from page JS, CORS blocks it), so this has to
// happen server-side. A full (non-shortened) link already has
// coordinates in the URL itself and doesn't strictly need this
// function, but routing both cases through the same endpoint keeps the
// frontend simple -- one button, one call, works either way.
//
// Auth: bound to the caller's own JWT, gated on is_admin_or_owner() --
// same tier as being allowed to edit a site at all (sites' own
// admin_updates/admin_inserts RLS policies require the same check).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Tried in order of precision: !3d<lat>!4d<lng> is Google's own marker
// pin (present on a "place" link, more precise than the viewport
// center); @<lat>,<lng> is the viewport center (present on every map
// URL, including a bare dropped-pin link); q=<lat>,<lng> is the older
// query-param form. Looked for in both the resolved URL and the page
// body, since some redirect targets only carry the coordinate in an
// embedded script/meta tag rather than the URL itself.
const COORD_PATTERNS = [
  /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
  /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
  /[?&]q=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
]
function extractCoords(text: string): { lat: number; lng: number } | null {
  for (const pattern of COORD_PATTERNS) {
    const m = text.match(pattern)
    if (m) {
      const lat = parseFloat(m[1])
      const lng = parseFloat(m[2])
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng }
      }
    }
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization' }, 401)

  let body: { url?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const inputUrl = (body.url || '').trim()
  if (!inputUrl) return json({ ok: false, error: 'url required' }, 400)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isAdminOrOwner, error: authError } = await userClient.rpc('is_admin_or_owner')
  if (authError || !isAdminOrOwner) return json({ error: 'Unauthorized' }, 403)

  // The bare URL itself might already carry coordinates (a full,
  // non-shortened link) -- cheap check before spending a real request.
  const directMatch = extractCoords(inputUrl)
  if (directMatch) return json({ ok: true, ...directMatch })

  let res: Response
  try {
    res = await fetch(inputUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FacadeXPM-site-coords/1.0)' },
    })
  } catch (e) {
    return json({ ok: false, error: 'เปิดลิงก์ไม่สำเร็จ — เช็คว่าลิงก์ถูกต้องไหม' })
  }

  const resolvedUrlMatch = extractCoords(res.url)
  if (resolvedUrlMatch) return json({ ok: true, ...resolvedUrlMatch })

  // Fallback: some redirect targets only carry the coordinate in the
  // page body (an embedded script/meta tag), not the URL itself.
  const bodyText = await res.text().catch(() => '')
  const bodyMatch = extractCoords(bodyText)
  if (bodyMatch) return json({ ok: true, ...bodyMatch })

  return json({ ok: false, error: 'หาพิกัดจากลิงก์นี้ไม่พบ — กรุณากรอกพิกัดเอง หรือลองลิงก์แบบอื่น' })
})
