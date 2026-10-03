// supabase/functions/_shared/line-admin-chat.ts
// DB access for LINE hybrid privacy mode. Every function takes the
// service-role client so callers (line-webhook, the send/expire
// functions) share one implementation. Decision logic lives in
// ./line-admin-chat-logic.ts (pure, unit-tested).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush } from './line.ts'
import { ADMIN_CHAT_END_NOTICE, ADMIN_CHAT_WARN_NOTICE, ADMIN_CHAT_END_QUICK_REPLY, logSafeError, type ChatMode } from './line-admin-chat-logic.ts'

const DUPLICATE_KEY = '23505'

export async function getChatMode(admin: SupabaseClient, lineUserId: string): Promise<ChatMode> {
  const { data, error } = await admin.from('line_chat_sessions').select('mode').eq('line_user_id', lineUserId).maybeSingle()
  if (error) {
    // Fail closed: if we cannot tell, nothing gets recorded.
    logSafeError('line_chat_sessions mode lookup failed', error)
    return 'secure_bot'
  }
  return data?.mode === 'chat_with_admin' ? 'chat_with_admin' : 'secure_bot'
}

export async function startChatSession(admin: SupabaseClient, lineUserId: string, tenantId: string | null): Promise<void> {
  const nowIso = new Date().toISOString()
  const { error } = await admin.from('line_chat_sessions').upsert(
    { line_user_id: lineUserId, tenant_id: tenantId, mode: 'chat_with_admin', started_at: nowIso, last_activity_at: nowIso, ack_sent_at: null, warned_at: null },
    { onConflict: 'line_user_id' },
  )
  if (error) logSafeError('line_chat_sessions start upsert failed', error)
}

export async function endChatSession(admin: SupabaseClient, lineUserId: string): Promise<boolean> {
  const { data, error } = await admin.from('line_chat_sessions')
    .update({ mode: 'secure_bot' })
    .eq('line_user_id', lineUserId)
    .eq('mode', 'chat_with_admin')
    .select('line_user_id')
  if (error) {
    logSafeError('line_chat_sessions end update failed', error)
    return false
  }
  return (data?.length ?? 0) > 0
}

export async function endChatAndPush(admin: SupabaseClient, accessToken: string, lineUserId: string): Promise<boolean> {
  const ended = await endChatSession(admin, lineUserId)
  if (ended) await sendLinePush(accessToken, lineUserId, ADMIN_CHAT_END_NOTICE)
  return ended
}

async function touchSession(admin: SupabaseClient, lineUserId: string): Promise<void> {
  const { error } = await admin.from('line_chat_sessions').update({ last_activity_at: new Date().toISOString(), warned_at: null }).eq('line_user_id', lineUserId)
  if (error) logSafeError('line_chat_sessions touch failed', error)
}

export async function recordUserText(admin: SupabaseClient, lineUserId: string, messageId: string, text: string): Promise<void> {
  const { error } = await admin.from('line_admin_messages').insert({ line_user_id: lineUserId, direction: 'user', body: text, line_event_id: messageId })
  if (error && error.code !== DUPLICATE_KEY) { logSafeError('line_admin_messages text insert failed', error); return }
  await touchSession(admin, lineUserId)
}

export async function recordUserImage(admin: SupabaseClient, lineUserId: string, messageId: string, content: Uint8Array | ArrayBuffer): Promise<void> {
  const path = `${lineUserId}/${messageId}.jpg`
  const { error: uploadError } = await admin.storage.from('line-admin-chat').upload(path, content, { contentType: 'image/jpeg', upsert: true })
  if (uploadError) { logSafeError('line-admin-chat upload failed', uploadError); return }
  const { error } = await admin.from('line_admin_messages').insert({ line_user_id: lineUserId, direction: 'user', storage_path: path, line_event_id: messageId })
  if (error && error.code !== DUPLICATE_KEY) { logSafeError('line_admin_messages image insert failed', error); return }
  await touchSession(admin, lineUserId)
}

export async function recordAdminText(admin: SupabaseClient, lineUserId: string, text: string): Promise<void> {
  const { error } = await admin.from('line_admin_messages').insert({ line_user_id: lineUserId, direction: 'admin', body: text })
  if (error) { logSafeError('line_admin_messages admin insert failed', error); return }
  await touchSession(admin, lineUserId)
}

// Only OWNER/ADMIN accounts (rows in user_roles linked to this LINE user) may open a
// chat with the platform admin. A worker's questions belong with their own company.
export async function canStartAdminChat(admin: SupabaseClient, lineUserId: string): Promise<boolean> {
  const { data, error } = await admin.from('user_roles').select('role').eq('line_user_id', lineUserId).in('role', ['OWNER', 'ADMIN']).limit(1)
  if (error) { logSafeError('user_roles chat-permission lookup failed', error); return false }  // fail closed
  return (data?.length ?? 0) > 0
}

// True exactly once per session: the first caller flips ack_sent_at from NULL and
// should send the "sent to admin" reply; later calls get false. Atomic, so a
// redelivered event cannot produce a second acknowledgement.
export async function claimAckForSession(admin: SupabaseClient, lineUserId: string): Promise<boolean> {
  const { data, error } = await admin.from('line_chat_sessions')
    .update({ ack_sent_at: new Date().toISOString() })
    .eq('line_user_id', lineUserId)
    .eq('mode', 'chat_with_admin')
    .is('ack_sent_at', null)
    .select('line_user_id')
  if (error) { logSafeError('line_chat_sessions ack claim failed', error); return false }
  return (data?.length ?? 0) > 0
}

// Marks the session as warned and sends the heads-up in one step; the marker is set
// first so a slow push can never be sent twice by overlapping cron runs.
export async function warnSessionBeforeExpiry(admin: SupabaseClient, accessToken: string, lineUserId: string): Promise<boolean> {
  const { data, error } = await admin.from('line_chat_sessions')
    .update({ warned_at: new Date().toISOString() })
    .eq('line_user_id', lineUserId)
    .eq('mode', 'chat_with_admin')
    .is('warned_at', null)
    .select('line_user_id')
  if (error) { logSafeError('line_chat_sessions warn mark failed', error); return false }
  if ((data?.length ?? 0) === 0) return false
  await sendLinePush(accessToken, lineUserId, ADMIN_CHAT_WARN_NOTICE, ADMIN_CHAT_END_QUICK_REPLY)
  return true
}
