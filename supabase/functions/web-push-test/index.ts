// "Send me a test notification": delivers a test Web Push to the CALLER's own registered
// devices only (never to anyone else), so a person can check this device really receives them.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendWebPushToUser } from '../_shared/web-push.ts'
import { testPush } from '../_shared/web-push-messages.ts'

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
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Unauthorized' }, 401)
  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user?.email) return json({ error: 'Unauthorized' }, 401)

  const { data: role } = await admin.from('user_roles').select('tenant_id, role').eq('user_email', user.email).maybeSingle()
  if (!role || !['OWNER', 'ADMIN'].includes(role.role as string)) return json({ error: 'Forbidden' }, 403)

  const result = await sendWebPushToUser(admin, role.tenant_id as string, user.email, testPush())
  return json({ ok: true, ...result })
})
