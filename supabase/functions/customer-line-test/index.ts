// customer-line-test: owner-only check of the tenant's own customer LINE OA (token valid + LINE can reach our webhook).
// Deploys WITH JWT verification on (the default): the Settings page calls it with the owner's JWT.
// Never log or return the channel secret or access token.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ ok: false, error: 'Unauthorized' }, 401)
  const { data: { user }, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !user?.email) return json({ ok: false, error: 'Unauthorized' }, 401)
  const { data: role } = await admin.from('user_roles').select('tenant_id, role').eq('user_email', user.email).maybeSingle()
  if (!role || role.role !== 'OWNER') return json({ ok: false, error: 'forbidden' }, 403)
  const tenantId = role.tenant_id as string

  const { data: channel } = await admin.from('customer_line_channels')
    .select('webhook_key').eq('tenant_id', tenantId).maybeSingle()
  if (!channel?.webhook_key) return json({ ok: false, error: 'not_configured' })
  const { data: credsData, error: credsError } = await admin.rpc('customer_line_creds_by_tenant', { p_tenant: tenantId })
  const creds = Array.isArray(credsData) ? credsData[0] : credsData
  if (credsError || !creds?.access_token) return json({ ok: false, error: 'not_configured' })
  const accessToken = creds.access_token as string

  // Network failure / timeout = LINE unreachable; a non-ok answer = the token is wrong.
  let infoRes: Response
  try {
    infoRes = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    console.error('customer-line-test bot/info unreachable', (e as Error).name)
    return json({ ok: false, error: 'line_unreachable' })
  }
  if (!infoRes.ok) return json({ ok: false, error: 'bad_token' })
  const info = await infoRes.json().catch(() => ({}))
  const basicId = typeof info?.basicId === 'string' ? info.basicId.replace(/^@/, '') : null
  const displayName = typeof info?.displayName === 'string' ? info.displayName : null

  // The token is proven good above; a failure from here on is about the webhook, not the token.
  // No `endpoint` in the body: LINE then tests the URL actually saved in LINE Developers, which is
  // what customers' messages will hit. (Building the URL from SUPABASE_URL gave LINE an address it
  // could not reach: statusCode 0.)
  let webhook: { success: boolean; statusCode?: number; reason?: string }
  try {
    const testRes = await fetch('https://api.line.me/v2/bot/channel/webhook/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    })
    if (testRes.ok) {
      const t = await testRes.json().catch(() => ({}))
      webhook = { success: t?.success === true, statusCode: typeof t?.statusCode === 'number' ? t.statusCode : undefined, reason: typeof t?.reason === 'string' ? t.reason : undefined }
    } else {
      webhook = { success: false, statusCode: testRes.status, reason: 'line_test_request_failed' }
    }
  } catch (e) {
    console.error('customer-line-test webhook test unreachable', (e as Error).name)
    webhook = { success: false, reason: 'webhook_test_unreachable' }
  }

  // A failed test clears verified_at so the Settings badge stops saying "connected".
  const update: Record<string, unknown> = {
    basic_id: basicId,
    display_name: displayName,
    verified_at: webhook.success ? new Date().toISOString() : null,
  }
  const { error: saveError } = await admin.from('customer_line_channels').update(update).eq('tenant_id', tenantId)
  if (saveError) console.error('customer-line-test save failed', saveError.code)

  return json({ ok: webhook.success, basicId, displayName, webhook })
})
