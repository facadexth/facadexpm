// supabase/functions/line-admin-chat-send/index.ts
// Platform-owner actions on a LINE admin-chat session: reply, end, delete.
// verify_jwt is ON (gateway check), but that only proves "some valid
// project JWT" -- the anon key is one. The REAL access control is the
// platform_admins membership check below, run before anything else.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { endChatAndPush, getChatMode, recordAdminText } from '../_shared/line-admin-chat.ts'
import { logSafeError } from '../_shared/line-admin-chat-logic.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user?.email) return json({ error: 'Unauthorized' }, 401)
  const { data: pa } = await admin.from('platform_admins').select('user_email').eq('user_email', user.email).maybeSingle()
  if (!pa) return json({ error: 'Forbidden' }, 403)

  let body: { action?: string; lineUserId?: string; text?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const { action, lineUserId, text } = body
  if (!lineUserId) return json({ error: 'lineUserId required' }, 400)

  if (action === 'reply') {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return json({ error: 'text required' }, 400)
    if ((await getChatMode(admin, lineUserId)) !== 'chat_with_admin') return json({ error: 'Session is not open' }, 409)
    const push = await sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, trimmed)
    if (!push.ok) return json({ error: `LINE push failed (${push.status})` }, 502)
    await recordAdminText(admin, lineUserId, trimmed)
    return json({ ok: true })
  }

  if (action === 'end') {
    await endChatAndPush(admin, LINE_CHANNEL_ACCESS_TOKEN, lineUserId)
    return json({ ok: true })
  }

  if (action === 'delete') {
    // Remove stored photos first, then the messages (the session row stays; it holds no content).
    const { data: files } = await admin.storage.from('line-admin-chat').list(lineUserId)
    if (files?.length) {
      const { error } = await admin.storage.from('line-admin-chat').remove(files.map((f) => `${lineUserId}/${f.name}`))
      if (error) { logSafeError('line-admin-chat remove failed', error); return json({ error: 'Could not delete photos' }, 500) }
    }
    const { error } = await admin.from('line_admin_messages').delete().eq('line_user_id', lineUserId)
    if (error) { logSafeError('line_admin_messages delete failed', error); return json({ error: 'Could not delete messages' }, 500) }
    return json({ ok: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
