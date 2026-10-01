// supabase/functions/line-test-group/index.ts
// Answers "is this Crew Group ID actually correct?" for
// CommunicationCenter.jsx's connection form -- calls LINE's own "Get
// group chat summary" API (GET /v2/bot/group/{groupId}/summary), which
// only succeeds while the bot is currently a member of that exact
// group and returns the group's real display name. Read-only: no
// message is sent, no push quota is spent, unlike a real test push
// would cost. Tests whatever group_id is currently TYPED in the form,
// not just the already-saved value, so an OWNER can check a candidate
// ID before saving it.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization' }, 401)

  let body: { group_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const groupId = (body.group_id || '').trim()
  if (!groupId) return json({ error: 'group_id required' }, 400)

  // Bound to the caller's own JWT -- same pattern as
  // extract-po-document/omise-create-charge. This table (line_settings,
  // channel_access_token) is OWNER-only, same sensitivity tier as
  // line_command_settings, so gate on is_owner() specifically, not the
  // looser is_admin_or_owner() other LINE-adjacent functions use.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: isOwner, error: ownerCheckError } = await userClient.rpc('is_owner')
  if (ownerCheckError || !isOwner) return json({ error: 'Unauthorized' }, 403)

  const { data: tenantId, error: tenantError } = await userClient.rpc('current_tenant_id')
  if (tenantError || !tenantId) return json({ error: 'Unauthorized' }, 403)

  const res = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  })
  if (!res.ok) {
    return json({ ok: false, error: 'บอทไม่ได้อยู่ในกลุ่มนี้ หรือ Group ID ไม่ถูกต้อง' })
  }
  const data = await res.json()
  return json({ ok: true, groupName: data.groupName as string })
})
