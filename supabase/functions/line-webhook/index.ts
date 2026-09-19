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
// Two parallel paths into the same three crew actions (see
// docs/superpowers/specs/2026-09-19-line-notifications-design.md and
// this plan's Task 8): typed keywords in the shared crew group
// (original design), and Rich Menu buttons in a 1:1 DM with the bot
// (Task 8 addition -- LINE Rich Menus cannot render inside a group
// chat, so this had to be a second path, not a replacement). Both
// funnel into the same handleAction() below.
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
import { verifyLineSignature, sendLineReply, linkRichMenuToUser } from '../_shared/line.ts'

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

// This tenant's real LINE OA is ALSO used for sales/customer info -- the
// crew Rich Menu is NEVER set as the bot's default for everyone (that
// would put crew buttons in front of real customers). Instead it's
// linked per-user, lazily, the first time a recognized worker is seen
// in a 1:1 DM (the only context Rich Menus render in at all). Idempotent
// on LINE's side either way, but line_rich_menu_linked_at avoids the
// repeat API call on every subsequent message from an already-linked worker.
async function ensureCrewRichMenuLinked(
  worker: { id: string; line_user_id: string | null; line_rich_menu_linked_at: string | null },
  settings: { channel_access_token: string; crew_rich_menu_id: string | null },
) {
  if (!settings.crew_rich_menu_id || worker.line_rich_menu_linked_at || !worker.line_user_id) return
  const { ok } = await linkRichMenuToUser(settings.channel_access_token, worker.line_user_id, settings.crew_rich_menu_id)
  if (ok) {
    const { error } = await admin.from('workers').update({ line_rich_menu_linked_at: new Date().toISOString() }).eq('id', worker.id)
    if (error) console.error('workers.line_rich_menu_linked_at update failed', error)
  } else {
    console.error('linkRichMenuToUser failed for worker', worker.id)
  }
}

type ActionType = 'issue_report' | 'material_request' | 'leave'

function promptForAction(action: ActionType): string {
  if (action === 'issue_report') return '🚧 บอกรายละเอียดปัญหาได้เลยครับ'
  if (action === 'material_request') return '📦 บอกรายการของที่ต้องการเบิกได้เลยครับ'
  return '🏖️ บอกรายละเอียดวันที่ลาได้เลยครับ'
}

// Shared by both the group-keyword path and the DM Rich-Menu path --
// exactly the three action bodies Task 3 originally wrote inline,
// unchanged in behavior, just callable from two call sites now.
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
    const lineUserId: string | undefined = event.source?.userId
    const sourceGroupId: string | undefined = event.source?.groupId
    if (!lineUserId) continue

    // Rich Menu button tap -- only ever fires from a 1:1 DM (LINE
    // doesn't render Rich Menus inside groups, so this branch can't be
    // reached from a group event in practice, but the code doesn't need
    // to assume that -- it just resolves the worker and proceeds).
    if (event.type === 'postback') {
      const action = new URLSearchParams(event.postback?.data ?? '').get('action') as ActionType | null
      if (action !== 'issue_report' && action !== 'material_request' && action !== 'leave') continue
      const { data: worker } = await admin.from('workers').select('id, name, line_user_id, line_rich_menu_linked_at').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
      if (!worker) continue // a Rich Menu tap from someone not a recognized worker -- nothing useful to do without a group context to capture them the way line_unlinked_senders does
      await ensureCrewRichMenuLinked(worker, settings)
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      const { error } = await admin.from('line_pending_actions').upsert(
        { tenant_id: settings.tenant_id, worker_id: worker.id, action, expires_at: expiresAt },
        { onConflict: 'worker_id' }
      )
      if (error) console.error('line_pending_actions upsert failed', error)
      await sendLineReply(settings.channel_access_token, event.replyToken, promptForAction(action))
      continue
    }

    if (event.type !== 'message' || event.message?.type !== 'text') continue
    const text: string = event.message.text

    if (!sourceGroupId) {
      // DM -- either (a) an OWNER/ADMIN's bare linking code (existing
      // Track B flow, unchanged), or (b) a worker's reply to a pending
      // Rich Menu action (Task 8 addition). Linking-code match is
      // checked first since it's a narrower, more specific match.
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

      const { data: worker } = await admin.from('workers').select('id, name, line_user_id, line_rich_menu_linked_at').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
      if (worker) {
        await ensureCrewRichMenuLinked(worker, settings)
        const { data: pending } = await admin.from('line_pending_actions').select('*').eq('worker_id', worker.id).gt('expires_at', new Date().toISOString()).maybeSingle()
        if (pending) {
          const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
          if (deleteError) console.error('line_pending_actions delete failed', deleteError)
          await handleAction(pending.action as ActionType, worker, text, settings, event.replyToken)
        }
        // A linked worker DMing the bot with no pending action (e.g. they
        // never tapped a Rich Menu button first) is out of scope for v1 --
        // silently ignored. Free typing of keywords only works in the
        // crew group, matching the original design; DM-only keyword
        // typing was not asked for and is not built here.
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

    // Keyword-based triggers -- simple substring match, not NLP, tuned
    // against real collisions found in review: a bare "ปัญหา" also
    // matches "ไม่มีปัญหา"/"ไม่ปัญหา" ("no problem"), and a bare "ลา"
    // matches ordinary words like ตลาด/ปลา/ฉลาด with zero relation to
    // leave. Each set is chosen so no phrase is a substring of another
    // branch's phrase, keeping the ปัญหา -> เบิก -> ลา routing order
    // unambiguous.
    const isIssueReport = text.includes('ปัญหา') && !text.includes('ไม่มีปัญหา') && !text.includes('ไม่ปัญหา')
    const isMaterialRequest = ['อยากเบิก', 'ขอเบิก'].some((kw) => text.includes(kw))
    const isLeaveRequest = ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'].some((kw) => text.includes(kw))

    if (isIssueReport) await handleAction('issue_report', worker, text, settings, event.replyToken)
    else if (isMaterialRequest) await handleAction('material_request', worker, text, settings, event.replyToken)
    else if (isLeaveRequest) await handleAction('leave', worker, text, settings, event.replyToken)
  }

  return json({ ok: true })
})
