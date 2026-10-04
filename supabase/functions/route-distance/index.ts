// route-distance: driving distance (km, one way) and time (minutes) between two points,
// via OpenRouteService. ADMIN/OWNER only. The key (ORS_API_KEY) is shared by all companies,
// so each company is capped per day (consume_route_call). Time has no live traffic.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

const validPoint = (p: any) =>
  p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Unauthorized' }, 401)
  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user?.email) return json({ error: 'Unauthorized' }, 401)
  const { data: role } = await admin.from('user_roles').select('tenant_id, role').eq('user_email', user.email).maybeSingle()
  if (!role || !['OWNER', 'ADMIN'].includes(role.role as string)) return json({ error: 'Forbidden' }, 403)

  const key = Deno.env.get('ORS_API_KEY')?.trim()
  if (!key) return json({ ok: false, error: 'not_configured' })

  const body = await req.json().catch(() => null)
  if (!validPoint(body?.from) || !validPoint(body?.to)) return json({ ok: false, error: 'invalid_points' }, 400)

  const { data: allowed, error: capError } = await admin.rpc('consume_route_call', { p_tenant: role.tenant_id })
  if (capError) return json({ ok: false, error: 'quota_check_failed' }, 500)
  if (!allowed) return json({ ok: false, error: 'daily_limit' })

  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[body.from.lng, body.from.lat], [body.to.lng, body.to.lat]], instructions: false, geometry: false }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.error('route-distance ORS status', res.status)
      return json({ ok: false, error: res.status === 404 ? 'no_route' : `routing_${res.status}` })
    }
    const data = await res.json()
    const s = data?.routes?.[0]?.summary
    if (!s || !Number.isFinite(s.distance) || !Number.isFinite(s.duration)) return json({ ok: false, error: 'no_route' })
    return json({ ok: true, km: Math.round(s.distance / 100) / 10, minutes: Math.round(s.duration / 60) })
  } catch (e) {
    console.error('route-distance failed', (e as Error).message)
    return json({ ok: false, error: 'routing_unavailable' })
  }
})
