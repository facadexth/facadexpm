// supabase/functions/line-webhook/index.ts
// Inbound LINE webhook -- receives every event for every tenant's LINE
// OA on one shared URL, routes by the webhook payload's own
// `destination` field (the bot's own internal LINE userId, from LINE's
// GET /v2/bot/info -- NOT the numeric Channel ID shown in LINE's
// console) against line_settings.bot_user_id. verify_jwt is OFF for
// this function (LINE itself calls it, unauthenticated by Supabase's
// own JWT check) --
// this function's signature verification against line_settings.
// channel_secret IS the access control, same pattern sign-link already
// established for its own public/unauthenticated endpoint.
//
// Three inbound triggers from the crew group (see
// docs/superpowers/specs/2026-09-19-line-notifications-design.md).
// Keyword sets are tuned to avoid real collisions found in review (bare
// "ปัญหา" matches "ไม่มีปัญหา" = "no problem"; bare "ลา" matches ตลาด/
// ปลา/ฉลาด) -- see the keyword-set comment further down for the exact
// phrase lists:
//   "ปัญหา" minus negations -> line_issue_reports row
//   "อยากเบิก"/"ขอเบิก"      -> see note below, NOT a purchase_orders
//                                 row -- the schema can't support that
//                                 yet (see comment at that branch)
//   "ลากิจ"/"ลาป่วย"/"ขอลา"/"อยากลา" -> worker_assignments row (leave_personal)
// plus a bare linking code sent as a DM, which is Track B's one-time
// OWNER/ADMIN account-linking flow (Task 6 issues the code).
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
// This runs on Deno Deploy (UTC clock), and a "ลา" message has no date
// in it at all, so "today" has to mean today in Bangkok, not UTC (which
// would be wrong for part of the evening/night in Thailand).
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
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

  // destination is the bot's own internal LINE userId (U + 32 hex chars,
  // from LINE's GET /v2/bot/info) -- NOT the numeric Channel ID shown in
  // LINE's console Basic Settings. Those are two different LINE
  // identifiers; channel_id stays for the Settings UI, bot_user_id is the
  // one this lookup actually needs (see
  // supabase/migrations/2026-09-19-05-line-settings-bot-user-id.sql).
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

    // A bare linking code, sent as a DM (no groupId) -- Track B's
    // one-time OWNER/ADMIN linking flow (see Task 6).
    if (!sourceGroupId) {
      const { data: pending } = await admin.from('user_roles').select('id').eq('tenant_id', settings.tenant_id).eq('line_link_code', text.trim()).maybeSingle()
      if (pending) {
        const { error } = await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pending.id)
        if (error) {
          console.error('user_roles line-link update failed', error)
          await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(settings.channel_access_token, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้ว')
        }
      }
      continue
    }

    // A message from the crew group -- only act on it if it's actually
    // that tenant's configured crew group.
    if (sourceGroupId !== settings.crew_group_id) continue

    const { data: worker } = await admin.from('workers').select('id, name').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
    if (!worker) {
      // First message from someone we don't recognize -- capture, don't
      // silently drop (Task 7 gives an admin a way to resolve this).
      const { error: unlinkedError } = await admin.from('line_unlinked_senders').upsert(
        { tenant_id: settings.tenant_id, line_user_id: lineUserId, display_name: event.source?.userId ?? null },
        { onConflict: 'tenant_id,line_user_id', ignoreDuplicates: true }
      )
      // No reply is sent on this branch either way (the sender isn't a
      // recognized worker, so there's nothing useful to tell them) -- but
      // a write failure here must not vanish silently, since it's the
      // only record an admin would ever get of this sender.
      if (unlinkedError) console.error('line_unlinked_senders upsert failed', unlinkedError)
      continue
    }

    // Keyword-based triggers -- simple substring match, not NLP, tuned
    // against real collisions found in review: a bare "ปัญหา" also
    // matches "ไม่มีปัญหา"/"ไม่ปัญหา" ("no problem" -- the opposite of a
    // report), and a bare "ลา" matches ordinary words like ตลาด/ปลา/ฉลาด
    // with zero relation to leave. Each keyword set below is chosen so
    // no phrase is a substring of another branch's phrase, keeping the
    // ปัญหา -> เบิก -> ลา routing order unambiguous.
    const isIssueReport = text.includes('ปัญหา') && !text.includes('ไม่มีปัญหา') && !text.includes('ไม่ปัญหา')
    const isMaterialRequest = ['อยากเบิก', 'ขอเบิก'].some((kw) => text.includes(kw))
    const isLeaveRequest = ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'].some((kw) => text.includes(kw))

    if (isIssueReport) {
      const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: text })
      if (error) {
        console.error('line_issue_reports insert failed', error)
        await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
      } else {
        await sendLineReply(settings.channel_access_token, event.replyToken, '📩 รับแจ้งปัญหาแล้ว แอดมินจะติดตามให้')
      }
    } else if (isMaterialRequest) {
      // NOT a purchase_orders insert -- confirmed against the live schema
      // (2026-09-19): purchase_orders_status_check only allows
      // ('ordered','received','cancelled'), there is no 'draft' value,
      // and site_id/supplier_id/category_id are all NOT NULL FKs
      // (RESTRICT) that a bare crew text message has no way to supply.
      // Inserting with status='ordered' would create a real, financially
      // live PO from unverified chat text -- worse than not capturing it
      // at all. line_settings also carries no default site/supplier/
      // category to fall back on. So this reuses line_issue_reports (the
      // one free-text capture table available that doesn't require those
      // FKs) with a tag prefix, same "don't silently drop" principle as
      // line_unlinked_senders above -- the admin still sees the request
      // and manually creates the real PO. A true draft-PO flow needs a
      // schema follow-up (either a 'draft' status + nullable FKs on
      // purchase_orders, or a dedicated line_material_requests table)
      // before this can write directly into purchase_orders.
      const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: `[ขอเบิกของ] ${text}` })
      if (error) {
        console.error('line_issue_reports insert failed (material request)', error)
        await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
      } else {
        await sendLineReply(settings.channel_access_token, event.replyToken, '📦 รับคำขอเบิกของแล้ว แอดมินจะตรวจสอบและออกใบสั่งซื้อให้')
      }
    } else if (isLeaveRequest) {
      // A worker_assignments row (leave_personal), the same shape
      // CellEditPopup.jsx builds for a leave save (src/pages/assign/
      // CellEditPopup.jsx:81-85): { worker_id, date, shift, type,
      // site_id: null, notes }. tenant_id must be set explicitly here --
      // its DB default is current_tenant_id(), which resolves off the
      // caller's JWT claims and would be NULL under this function's
      // service-role client. shift/date aren't in the message at all, so
      // this defaults to today (Bangkok) / 'morning' as a same-day
      // heads-up; the admin reviews and can extend it to the afternoon
      // shift too in the Assign UI. A plain insert (not upsert) so this
      // can never silently overwrite an already-scheduled real shift --
      // if one exists for today, the worker_id/date/shift unique
      // constraint rejects it and the crew is told to contact an admin
      // instead of quietly losing the existing assignment.
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
        await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ วันนี้มีคิวงานอยู่แล้ว กรุณาติดต่อแอดมินโดยตรง')
      } else {
        await sendLineReply(settings.channel_access_token, event.replyToken, '🏖️ รับคำขอลาแล้ว แอดมินจะตรวจสอบให้')
      }
    }
  }

  return json({ ok: true })
})
