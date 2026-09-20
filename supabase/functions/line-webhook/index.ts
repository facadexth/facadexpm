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
// Six crew actions total, two entry points:
//   - Typed keywords in the shared crew group -> immediate action.
//     Scoped to the original three (แจ้งปัญหา/ขอเบิกของ/ขอลา) only --
//     เช็คอิน/เช็คเอาท์/รูปภาพหน้างาน are 1:1-DM-only (see below).
//   - The SAME trigger phrases (or a Rich Menu button tap, configured
//     manually in LINE Official Account Manager to send fixed text) in
//     a 1:1 DM -> two-step for the "needs a detail" actions (ask ->
//     next message is the body), one-tap for เช็คอิน/เช็คเอาท์ (no detail
//     needed, resolved from today's own assignment instead).
//
// Keyword sets are tuned to avoid real collisions found in review (bare
// "ปัญหา" matches "ไม่มีปัญหา" = "no problem"; bare "ลา" matches ตลาด/
// ปลา/ฉลาด):
//   "ปัญหา" minus negations -> line_issue_reports row
//   "อยากเบิก"/"ขอเบิก"/"เบิกของ" -> see note below, NOT a purchase_orders
//                                 row -- the schema can't support that
//                                 yet (see comment at that branch)
//   "ลากิจ"/"ลาป่วย"/"ขอลา"/"อยากลา" -> worker_assignments row (leave_personal)
//   "เช็คอิน"/"เช็คเอาท์"   -> line_checkins row (site resolved from
//                                 today's own worker_assignments)
//   "รูปภาพ"                -> line_site_photos row (two-step: ask for
//                                 the photo, next DM must be an image)
// plus a bare linking code sent as a DM -- either an OWNER/ADMIN's
// (user_roles.line_link_code, Settings -> ทั่วไป issues it) or a
// worker's own (workers.line_link_code, the PRIMARY way a worker gets
// recognized -- not dependent on ever having posted in the crew group,
// since group membership is unreliable: people come and go).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyLineSignature, sendLineReply, sendLinePush } from '../_shared/line.ts'

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
function bangkokTimeString(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16)
}

type GroupActionType = 'issue_report' | 'material_request' | 'leave'
type ActionType = GroupActionType | 'check_in' | 'check_out' | 'site_photo'

// LINE bots have no way to remove someone from a group chat -- there's
// no "kick member" API for Official Accounts. So an offboarded worker
// (workers.status = 'inactive') can still technically sit in the crew
// group. This can't auto-fix that, but it can (a) refuse to act on
// anything they send -- checked/reports/leave from a departed worker
// never reach a live table -- and (b) tell an OWNER so a human removes
// them from the group. Rate-limited to once per 24h per worker via
// line_offboarding_alerted_at, so their continued presence doesn't
// re-fire this on every message.
async function alertOwnersOfInactiveWorker(
  worker: { id: string; name: string; line_offboarding_alerted_at: string | null },
  settings: { tenant_id: string; channel_access_token: string },
) {
  if (worker.line_offboarding_alerted_at) {
    const hoursSince = (Date.now() - new Date(worker.line_offboarding_alerted_at).getTime()) / (60 * 60 * 1000)
    if (hoursSince < 24) return
  }
  const { data: owners } = await admin
    .from('user_roles')
    .select('line_user_id')
    .eq('tenant_id', settings.tenant_id)
    .eq('role', 'OWNER')
    .not('line_user_id', 'is', null)
  for (const owner of owners ?? []) {
    await sendLinePush(settings.channel_access_token, owner.line_user_id as string, `⚠️ ${worker.name} (พ้นสภาพพนักงานแล้ว) ยังคงส่งข้อความในระบบ LINE อยู่ กรุณาลบออกจากกลุ่มทีมงานด้วยครับ`)
  }
  const { error } = await admin.from('workers').update({ line_offboarding_alerted_at: new Date().toISOString() }).eq('id', worker.id)
  if (error) console.error('workers.line_offboarding_alerted_at update failed', error)
}

// The one place every code path resolves "is this LINE sender a real,
// current worker" -- looks up by line_user_id regardless of status so
// an inactive match can be distinguished from a genuine stranger (the
// group path needs that distinction: a genuine stranger gets captured
// into line_unlinked_senders for an admin to resolve, but a known,
// already-alerted inactive worker must NOT be -- there's nothing to
// "resolve", we already know exactly who they are).
async function resolveWorker(
  lineUserId: string,
  settings: { tenant_id: string; channel_access_token: string },
): Promise<{ worker: { id: string; name: string } | null; foundButInactive: boolean }> {
  const { data: worker } = await admin
    .from('workers')
    .select('id, name, status, line_offboarding_alerted_at')
    .eq('line_user_id', lineUserId)
    .eq('tenant_id', settings.tenant_id)
    .maybeSingle()
  if (!worker) return { worker: null, foundButInactive: false }
  if (worker.status !== 'active') {
    await alertOwnersOfInactiveWorker(worker, settings)
    return { worker: null, foundButInactive: true }
  }
  return { worker: { id: worker.id, name: worker.name }, foundButInactive: false }
}

function promptForAction(action: ActionType): string {
  if (action === 'issue_report') return '🚧 รับทราบครับ ช่วยบอกรายละเอียดปัญหาที่พบด้วยครับ'
  if (action === 'material_request') return '📦 รับทราบครับ ช่วยบอกรายการของที่ต้องการเบิกด้วยครับ'
  if (action === 'site_photo') return '📷 ส่งรูปหน้างานมาได้เลยครับ'
  return '🏖️ รับทราบครับ ช่วยบอกรายละเอียดวันที่ลาด้วยครับ'
}

// Simple substring match, not NLP, tuned against real collisions found
// in review: a bare "ปัญหา" also matches "ไม่มีปัญหา"/"ไม่ปัญหา" ("no
// problem"), and a bare "ลา" matches ordinary words like ตลาด/ปลา/ฉลาด
// with zero relation to leave. Each set is chosen so no phrase is a
// substring of another branch's phrase. Used by the crew GROUP path --
// scoped to the original three actions only.
function matchGroupAction(text: string): GroupActionType | null {
  const isIssueReport = text.includes('ปัญหา') && !text.includes('ไม่มีปัญหา') && !text.includes('ไม่ปัญหา')
  if (isIssueReport) return 'issue_report'
  const isMaterialRequest = ['อยากเบิก', 'ขอเบิก', 'เบิกของ'].some((kw) => text.includes(kw))
  if (isMaterialRequest) return 'material_request'
  const isLeaveRequest = ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'].some((kw) => text.includes(kw))
  if (isLeaveRequest) return 'leave'
  return null
}

// Used by the 1:1 DM path -- all six actions. เช็คอิน/เช็คเอาท์/รูปภาพ
// don't collide with any existing phrase or each other.
function matchDMAction(text: string): ActionType | null {
  const base = matchGroupAction(text)
  if (base) return base
  if (text.includes('เช็คอิน')) return 'check_in'
  if (text.includes('เช็คเอาท์')) return 'check_out'
  if (text.includes('รูปภาพ')) return 'site_photo'
  return null
}

// Resolves "which site" for เช็คอิน/เช็คเอาท์/รูปภาพหน้างาน from the
// worker's own real site work assigned for today -- explicit user
// choice over asking each time. Same "real site work" filter Task 4's
// review already established (site/factory/subcontract, matching
// SITE_TYPES + DayView.jsx's own grouping). If a worker has more than
// one site assigned today, this just takes one -- a genuine edge case,
// not worth a disambiguation prompt for how rarely it happens.
async function resolveTodaysSite(workerId: string, tenantId: string): Promise<{ id: string; name: string } | null> {
  const { data: assignment } = await admin
    .from('worker_assignments')
    .select('site_id')
    .eq('worker_id', workerId)
    .eq('tenant_id', tenantId)
    .eq('date', bangkokToday())
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
    .limit(1)
    .maybeSingle()
  if (!assignment?.site_id) return null
  const { data: site } = await admin.from('sites').select('id, name').eq('id', assignment.site_id).maybeSingle()
  return site ?? null
}

async function fetchLineImageContent(accessToken: string, messageId: string): Promise<Uint8Array | null> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}

async function handleCheckIn(worker: { id: string }, settings: { tenant_id: string; channel_access_token: string }, replyToken: string) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const { error } = await admin.from('line_checkins').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site.id, date: bangkokToday(), check_in_at: new Date().toISOString() },
    { onConflict: 'worker_id,date' }
  )
  if (error) {
    console.error('line_checkins check-in upsert failed', error)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
  } else {
    await sendLineReply(settings.channel_access_token, replyToken, `✅ เช็คอินแล้ว ที่ ${site.name} เวลา ${bangkokTimeString()} น.`)
  }
}

async function handleCheckOut(worker: { id: string }, settings: { tenant_id: string; channel_access_token: string }, replyToken: string) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const { error } = await admin.from('line_checkins').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site.id, date: bangkokToday(), check_out_at: new Date().toISOString() },
    { onConflict: 'worker_id,date' }
  )
  if (error) {
    console.error('line_checkins check-out upsert failed', error)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
  } else {
    await sendLineReply(settings.channel_access_token, replyToken, `🏁 เช็คเอาท์แล้ว ที่ ${site.name} เวลา ${bangkokTimeString()} น. วันนี้ทำงานหนักแล้ว พักผ่อนด้วยนะครับ`)
  }
}

async function handleSitePhoto(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  messageId: string,
) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const content = await fetchLineImageContent(settings.channel_access_token, messageId)
  if (!content) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ดึงรูปภาพไม่สำเร็จ กรุณาลองส่งใหม่')
    return
  }
  const photoPath = `${settings.tenant_id}/${site.id}/${Date.now()}-${worker.id}.jpg`
  const { error: uploadError } = await admin.storage.from('line-site-photos').upload(photoPath, content, { contentType: 'image/jpeg' })
  if (uploadError) {
    console.error('line-site-photos upload failed', uploadError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่')
    return
  }
  const { error: insertError } = await admin.from('line_site_photos').insert({
    tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site.id, date: bangkokToday(), photo_path: photoPath,
  })
  if (insertError) {
    console.error('line_site_photos insert failed', insertError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
  } else {
    await sendLineReply(settings.channel_access_token, replyToken, `📷 รับรูปภาพแล้ว บันทึกเข้า ${site.name} เรียบร้อยครับ`)
  }
}

// The three "detail-needed" action bodies -- shared by the group's
// immediate-action path and the DM's two-step (pending-action-
// consumption) path.
async function handleAction(
  action: GroupActionType,
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
      await sendLineReply(settings.channel_access_token, replyToken, '📩 รับแจ้งปัญหาแล้วครับ แอดมินจะติดตามให้')
    }
  } else if (action === 'material_request') {
    // NOT a purchase_orders insert -- confirmed against the live schema
    // (2026-09-19): purchase_orders_status_check only allows
    // ('ordered','received','cancelled'), there is no 'draft' value, and
    // site_id/supplier_id/category_id are all NOT NULL FKs (RESTRICT)
    // that a bare crew text message has no way to supply. See Task 3's
    // original comment for the full rationale -- unchanged here. This
    // branch is a planned candidate to become a link-based flow instead
    // (opens an authenticated web form) -- design in progress.
    const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: `[ขอเบิกของ] ${text}` })
    if (error) {
      console.error('line_issue_reports insert failed (material request)', error)
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '📦 รับคำขอเบิกของแล้วครับ แอดมินจะตรวจสอบและออกใบสั่งซื้อให้')
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
    // overwrite an already-scheduled real shift. Also a planned
    // candidate for a link-based flow (real date-range picker) -- not
    // yet built.
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
      await sendLineReply(settings.channel_access_token, replyToken, '🏖️ รับคำขอลาแล้วครับ แอดมินจะตรวจสอบให้')
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
    if (event.type !== 'message') continue
    const msgType = event.message?.type
    if (msgType !== 'text' && msgType !== 'image') continue
    const text: string | undefined = msgType === 'text' ? event.message.text : undefined
    const messageId: string = event.message.id
    const lineUserId: string | undefined = event.source?.userId
    const sourceGroupId: string | undefined = event.source?.groupId
    if (!lineUserId) continue

    if (!sourceGroupId) {
      // DM -- either (a) a bare linking code (OWNER/ADMIN via user_roles,
      // or a WORKER via workers -- this is now the PRIMARY way a worker
      // gets recognized, not dependent on crew-group membership at all),
      // or (b) a worker's crew action: a Rich Menu button tap (fixed
      // text, configured manually in LINE Official Account Manager) or
      // manually-typed trigger phrase, or the image reply to a pending
      // รูปภาพหน้างาน prompt. Linking-code match is checked first since
      // it's a narrower, more specific match.
      if (msgType === 'text' && text) {
        const trimmed = text.trim()
        const { data: pendingRoleCode } = await admin.from('user_roles').select('id').eq('tenant_id', settings.tenant_id).eq('line_link_code', trimmed).maybeSingle()
        if (pendingRoleCode) {
          const { error } = await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingRoleCode.id)
          if (error) {
            console.error('user_roles line-link update failed', error)
            await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
          } else {
            await sendLineReply(settings.channel_access_token, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้วครับ')
          }
          continue
        }
        const { data: pendingWorkerCode } = await admin.from('workers').select('id').eq('tenant_id', settings.tenant_id).eq('line_link_code', trimmed).maybeSingle()
        if (pendingWorkerCode) {
          const { error } = await admin.from('workers').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingWorkerCode.id)
          if (error) {
            console.error('workers line-link update failed', error)
            await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
          } else {
            await sendLineReply(settings.channel_access_token, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้วครับ')
          }
          continue
        }
      }

      const { worker } = await resolveWorker(lineUserId, settings)
      if (!worker) continue // unrecognized (or inactive -- already alerted) DM sender

      const { data: pending } = await admin.from('line_pending_actions').select('*').eq('worker_id', worker.id).gt('expires_at', new Date().toISOString()).maybeSingle()
      if (pending) {
        const pendingAction = pending.action as ActionType
        if (pendingAction === 'site_photo') {
          if (msgType === 'image') {
            const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
            if (deleteError) console.error('line_pending_actions delete failed', deleteError)
            await handleSitePhoto(worker, settings, event.replyToken, messageId)
          }
          // Still waiting for a photo -- a stray text message while this
          // pending action is open is silently ignored, prompt stays live.
        } else if (msgType === 'text' && text) {
          const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
          if (deleteError) console.error('line_pending_actions delete failed', deleteError)
          await handleAction(pendingAction as GroupActionType, worker, text, settings, event.replyToken)
        }
        continue
      }

      if (msgType === 'text' && text) {
        const action = matchDMAction(text)
        if (action === 'check_in') {
          await handleCheckIn(worker, settings, event.replyToken)
        } else if (action === 'check_out') {
          await handleCheckOut(worker, settings, event.replyToken)
        } else if (action) {
          // issue_report / material_request / leave / site_photo --
          // two-step: ask for detail, consume the next matching message.
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
      continue
    }

    // A message from the crew group -- only act on it if it's actually
    // that tenant's configured crew group, and only text (photos/checkin
    // are 1:1-DM-only, matching the Rich Menu's own DM-only scope).
    if (msgType !== 'text' || !text) continue
    if (sourceGroupId !== settings.crew_group_id) continue

    const { worker, foundButInactive } = await resolveWorker(lineUserId, settings)
    if (!worker) {
      // A genuine stranger gets captured for an admin to resolve -- an
      // inactive worker does NOT (already alerted above; there's
      // nothing to "resolve", we already know exactly who they are).
      if (!foundButInactive) {
        const { error: unlinkedError } = await admin.from('line_unlinked_senders').upsert(
          { tenant_id: settings.tenant_id, line_user_id: lineUserId, display_name: event.source?.userId ?? null },
          { onConflict: 'tenant_id,line_user_id', ignoreDuplicates: true }
        )
        if (unlinkedError) console.error('line_unlinked_senders upsert failed', unlinkedError)
      }
      continue
    }

    const action = matchGroupAction(text)
    if (action) await handleAction(action, worker, text, settings, event.replyToken)
  }

  return json({ ok: true })
})
