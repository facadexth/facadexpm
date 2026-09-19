// supabase/functions/line-webhook/index.ts
// Inbound LINE webhook -- receives every event for every tenant's LINE
// OA on one shared URL, routes by the webhook payload's own
// `destination` field (the bot's own internal LINE userId, from LINE's
// GET /v2/bot/info -- NOT the numeric Channel ID shown in LINE's
// console) against line_settings.bot_user_id. verify_jwt is OFF for
// this function (LINE itself calls it, unauthenticated by Supabase's
// own JWT check) -- this function's signature verification against
// line_settings.channel_secret IS the access control, same pattern
// sign-link already established for its own public/unauthenticated
// endpoint.
//
// Two parallel paths into the same three crew actions:
//   - typed keywords in the shared crew group -> immediate action
//   - the SAME trigger phrases in a 1:1 DM (typed manually, or tapped
//     from a Rich Menu button configured in LINE Official Account
//     Manager to send fixed text) -> two-step: set a pending action,
//     ask for detail, the worker's next DM is the action's body. The
//     Rich Menu itself is configured manually in the LINE console (this
//     bot is internal-only, so a plain bot-wide default menu is fine --
//     no per-user linking needed).
//
// Keyword sets are tuned to avoid real collisions found in review (bare
// "ปัญหา" matches "ไม่มีปัญหา" = "no problem"; bare "ลา" matches ตลาด/
// ปลา/ฉลาด):
//   "ปัญหา" minus negations -> line_issue_reports row
//   "อยากเบิก"/"ขอเบิก"      -> see note below, NOT a purchase_orders
//                                 row -- the schema can't support that
//                                 yet (see comment at that branch)
//   "ลากิจ"/"ลาป่วย"/"ขอลา"/"อยากลา" -> worker_assignments row (leave_personal)
// plus a bare linking code sent as a DM, Track B's one-time OWNER/ADMIN
// account-linking flow (Settings -> ทั่วไป issues the code).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyLineSignature, sendLineReply } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Bangkok has no DST -- a fixed +7h offset from UTC is always correct.
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

type ActionType = 'issue_report' | 'material_request' | 'leave'

function promptForAction(action: ActionType): string {
  if (action === 'issue_report') return '🚧 บอกรายละเอียดปัญหาได้เลยครับ'
  if (action === 'material_request') return '📦 บอกรายการของที่ต้องการเบิกได้เลยครับ'
  return '🏖️ บอกรายละเอียดวันที่ลาได้เลยครับ'
}

// Simple substring match, not NLP, tuned against real collisions found
// in review: a bare "ปัญหา" also matches "ไม่มีปัญหา"/"ไม่ปัญหา" ("no
// problem"), and a bare "ลา" matches ordinary words like ตลาด/ปลา/ฉลาด
// with zero relation to leave. Each set is chosen so no phrase is a
// substring of another branch's phrase, keeping the ปัญหา -> เบิก -> ลา
// routing order unambiguous. Shared by both the group path (matches ->
// immediate action) and the DM path (matches -> two-step ask-for-detail).
function matchAction(text: string): ActionType | null {
  const isIssueReport = text.includes('ปัญหา') && !text.includes('ไม่มีปัญหา') && !text.includes('ไม่ปัญหา')
  if (isIssueReport) return 'issue_report'
  const isMaterialRequest = ['อยากเบิก', 'ขอเบิก'].some((kw) => text.includes(kw))
  if (isMaterialRequest) return 'material_request'
  const isLeaveRequest = ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'].some((kw) => text.includes(kw))
  if (isLeaveRequest) return 'leave'
  return null
}

// The three action bodies -- shared by the group's immediate-action path
// and the DM's two-step (pending-action-consumption) path.
async function handleAction(
  action: ActionType,
  worker: { id: string; name: string },
  text: string,
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
) {
  if (action === 'issue_report') {
    const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: text })
    if (error) {
      console.error('line_issue_reports insert failed', error)
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '📩 รับแจ้งปัญหาแล้ว แอดมินจะติดตามให้')
    }
  } else if (action === 'material_request') {
    // NOT a purchase_orders insert -- confirmed against the live schema
    // (2026-09-19): purchase_orders_status_check only allows
    // ('ordered','received','cancelled'), there is no 'draft' value, and
    // site_id/supplier_id/category_id are all NOT NULL FKs (RESTRICT)
    // that a bare crew text message has no way to supply. See Task 3's
    // original comment for the full rationale -- unchanged here.
    const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: `[ขอเบิกของ] ${text}` })
    if (error) {
      console.error('line_issue_reports insert failed (material request)', error)
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '📦 รับคำขอเบิกของแล้ว แอดมินจะตรวจสอบและออกใบสั่งซื้อให้')
    }
  } else {
    // A worker_assignments row (leave_personal), the same shape
    // CellEditPopup.jsx builds for a leave save (src/pages/assign/
    // CellEditPopup.jsx:81-85): { worker_id, date, shift, type,
    // site_id: null, notes }. tenant_id must be set explicitly here --
    // its DB default is current_tenant_id(), which resolves off the
    // caller's JWT claims and would be NULL under this function's
    // service-role client. shift/date aren't in the message at all, so
    // this defaults to today (Bangkok) / 'morning' as a same-day
    // heads-up. A plain insert (not upsert) so this can never silently
    // overwrite an already-scheduled real shift.
    const { error } = await admin.from('worker_assignments').insert({
      tenant_id: settings.tenant_id,
      worker_id: worker.id,
      date: bangkokToday(),
      shift: 'morning',
      type: 'leave_personal',
      site_id: null,
      notes: text,
    })
    if (error) {
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ วันนี้มีคิวงานอยู่แล้ว กรุณาติดต่อแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '🏖️ รับคำขอลาแล้ว แอดมินจะตรวจสอบให้')
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const rawBody = await req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const destination = payload.destination as string | undefined
  if (!destination) return json({ error: 'destination required' }, 400)

  const { data: settings } = await admin.from('line_settings').select('*').eq('bot_user_id', destination).maybeSingle()
  if (!settings) return json({ error: 'unknown channel' }, 404)

  const signatureOk = await verifyLineSignature(settings.channel_secret, rawBody, req.headers.get('x-line-signature'))
  if (!signatureOk) return json({ error: 'invalid signature' }, 401)

  const events = (payload.events as Array<Record<string, any>>) ?? []
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue
    const text: string = event.message.text
    const lineUserId: string | undefined = event.source?.userId
    const sourceGroupId: string | undefined = event.source?.groupId
    if (!lineUserId) continue

    if (!sourceGroupId) {
      // DM -- either (a) an OWNER/ADMIN's bare linking code (Track B),
      // or (b) a worker's crew action: a Rich Menu button tap (which
      // sends fixed text, configured manually in LINE Official Account
      // Manager) or manually-typed trigger phrase -- both indistinguishable
      // once they arrive as text, and both get the same two-step
      // treatment. Linking-code match is checked first since it's a
      // narrower, more specific match.
      const { data: pendingCode } = await admin.from('user_roles').select('id').eq('tenant_id', settings.tenant_id).eq('line_link_code', text.trim()).maybeSingle()
      if (pendingCode) {
        const { error } = await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingCode.id)
        if (error) {
          console.error('user_roles line-link update failed', error)
          await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(settings.channel_access_token, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้ว')
        }
        continue
      }

      const { data: worker } = await admin.from('workers').select('id, name').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
      if (worker) {
        const { data: pending } = await admin.from('line_pending_actions').select('*').eq('worker_id', worker.id).gt('expires_at', new Date().toISOString()).maybeSingle()
        if (pending) {
          const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
          if (deleteError) console.error('line_pending_actions delete failed', deleteError)
          await handleAction(pending.action as ActionType, worker, text, settings, event.replyToken)
        } else {
          const action = matchAction(text)
          if (action) {
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
            const { error } = await admin.from('line_pending_actions').upsert(
              { tenant_id: settings.tenant_id, worker_id: worker.id, action, expires_at: expiresAt },
              { onConflict: 'worker_id' }
            )
            if (error) console.error('line_pending_actions upsert failed', error)
            await sendLineReply(settings.channel_access_token, event.replyToken, promptForAction(action))
          }
          // No match and no pending action -- unrecognized DM text from a
          // linked worker, silently ignored.
        }
      }
      continue
    }

    // A message from the crew group -- only act on it if it's actually
    // that tenant's configured crew group.
    if (sourceGroupId !== settings.crew_group_id) continue

    const { data: worker } = await admin.from('workers').select('id, name').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
    if (!worker) {
      const { error: unlinkedError } = await admin.from('line_unlinked_senders').upsert(
        { tenant_id: settings.tenant_id, line_user_id: lineUserId, display_name: event.source?.userId ?? null },
        { onConflict: 'tenant_id,line_user_id', ignoreDuplicates: true }
      )
      if (unlinkedError) console.error('line_unlinked_senders upsert failed', unlinkedError)
      continue
    }

    const action = matchAction(text)
    if (action) await handleAction(action, worker, text, settings, event.replyToken)
  }

  return json({ ok: true })
})
