// supabase/functions/line-admin-chat-expire/index.ts
// Scheduled (see 2026-10-02-05-line-admin-chat-expire-cron.sql). Ends any
// chat_with_admin session idle longer than line_admin_chat_config.idle_hours
// so a forgotten session cannot keep recording indefinitely, and tells
// the user their data is no longer being recorded. Auth: x-cron-secret
// via public.verify_cron_secret(), same as the line-push-* functions.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { endChatAndPush } from '../_shared/line-admin-chat.ts'
import { isSessionExpired, logSafeError } from '../_shared/line-admin-chat-logic.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  const provided = req.headers.get('x-cron-secret')
  if (!provided) return json({ error: 'Unauthorized' }, 401)
  const { data: ok, error: rpcError } = await admin.rpc('verify_cron_secret', { provided })
  if (rpcError) { logSafeError('verify_cron_secret RPC failed', rpcError); return json({ error: 'Unauthorized' }, 401) }
  if (ok !== true) return json({ error: 'Unauthorized' }, 401)

  const { data: config } = await admin.from('line_admin_chat_config').select('idle_hours').eq('id', true).maybeSingle()
  const idleHours = config?.idle_hours ?? 24

  const { data: open, error } = await admin.from('line_chat_sessions').select('line_user_id, last_activity_at').eq('mode', 'chat_with_admin')
  if (error) { logSafeError('open sessions query failed', error); return json({ error: 'query failed' }, 500) }

  const now = Date.now()
  let ended = 0
  for (const s of open ?? []) {
    if (!isSessionExpired(new Date(s.last_activity_at).getTime(), idleHours, now)) continue
    if (await endChatAndPush(admin, LINE_CHANNEL_ACCESS_TOKEN, s.line_user_id)) ended++
  }
  return json({ ok: true, ended })
})
