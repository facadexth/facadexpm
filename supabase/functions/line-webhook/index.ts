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
// Eight crew actions total, two entry points:
//   - Typed keywords in the shared crew group -> immediate action.
//     Scoped to the original three (แจ้งปัญหา/ขอเบิกของ/ขอลา) only --
//     เช็คอิน/เช็คเอาท์/รูปภาพหน้างาน/งานเสร็จ/งานวันนี้ are 1:1-DM-only.
//   - The SAME trigger phrases (or a Rich Menu button tap, configured
//     manually in LINE Official Account Manager to send fixed text) in
//     a 1:1 DM -> two-step for the "needs a detail" actions (ask ->
//     next message is the body). เช็คอิน/เช็คเอาท์ are ALSO two-step now:
//     ask the worker to share their LINE location (native picker, not
//     typed text) -> next message is a `location`-type event -> validate
//     against the assigned site's geofence. See the perform_worker_
//     checkin_by_id/perform_worker_checkout_by_id note below.
//
// "งานวันนี้" (today's work) is the main Rich Menu entry point, NOT a
// data-writing action of its own -- replaces the earlier flat 6-button
// menu (which assumed a worker already knew which of 6 disconnected
// actions to use) with a status summary + LINE Quick Reply chips for
// only what's relevant right now (not checked in yet -> shows เช็คอิน;
// already checked in -> shows เช็คเอาท์; has an open task -> shows
// งานเสร็จ; always shows แจ้งปัญหา/รูปภาพหน้างาน). Tapping a chip sends
// that exact phrase back as text, which flows into the SAME
// matchDMAction() routing below, unchanged -- this menu is purely a
// smarter front door onto existing actions, not a new code path per
// action. ขอเบิกของ/ขอลา stay as their own separate Rich Menu buttons
// (not "today's work" -- can happen any day, not tied to today's site).
//
// รูปภาพหน้างาน and งานเสร็จ both accept MULTIPLE photos per session now
// (previously the first photo immediately closed the flow) -- each
// photo uploads and saves right away, a "เสร็จแล้ว" quick-reply chip
// appears after each one, and only tapping/typing "เสร็จแล้ว" (with at
// least 1 photo already sent) closes the pending action -- for งานเสร็จ,
// that's also the moment phase_tasks.status actually flips to 'done',
// not the first photo.
//
// Keyword sets are tuned to avoid real collisions found in review (bare
// "ปัญหา" matches "ไม่มีปัญหา" = "no problem"; bare "ลา" matches ตลาด/
// ปลา/ฉลาด):
//   "ปัญหา" minus negations -> line_issue_reports row
//   "อยากเบิก"/"ขอเบิก"/"เบิกของ" -> see note below, NOT a purchase_orders
//                                 row -- the schema can't support that
//                                 yet (see comment at that branch)
//   "ลากิจ"/"ลาป่วย"/"ขอลา"/"อยากลา" -> worker_assignments row (leave_personal)
//   "เช็คอิน"/"เช็คเอาท์"   -> two-step: worker shares LINE location ->
//                                 perform_worker_checkin_by_id/
//                                 perform_worker_checkout_by_id (the SAME
//                                 geofenced RPCs, worker_checkins table,
//                                 and app_settings.checkin_radius_m the
//                                 web app's own check-in card already
//                                 uses -- site resolved from today's own
//                                 worker_assignments, exactly as before).
//                                 Rejects outside the configured radius
//                                 with the distance in the reply.
//   "รูปภาพ"                -> line_site_photos rows (multi-photo, see above)
//   "งานเสร็จ"/"เสร็จงาน"   -> closes a real Kanban card (phase_tasks
//                                 .status = 'done'), resolved from
//                                 phase_task_workers. If the worker has
//                                 more than one open task, asks which
//                                 one via LINE Quick Reply buttons (tap
//                                 the task name -- built for low-literacy
//                                 crew, no typing required), then asks
//                                 for completion photo(s).
//   "งานวันนี้"              -> handleTodaysJobMenu, see above
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
const APP_URL = 'https://pm.facadex.co.th'

// Issues a one-time /f/<token> link (see field-form Edge Function +
// src/FieldFormPage.jsx) for เบิกของ/ขอลา -- replaces the old free-text
// insert (material_request couldn't satisfy purchase_orders' NOT NULL
// site_id/supplier_id/category_id; leave wrote straight into
// worker_assignments with no approval step at all). 30 minutes is enough
// to switch from LINE to the browser and back without leaving a stale
// link usable for days.
async function issueFieldFormLink(tenantId: string, workerId: string, actionType: 'material_request' | 'leave'): Promise<string | null> {
  const token = crypto.randomUUID().replace(/-/g, '')
  const { error } = await admin.from('line_deep_link_tokens').insert({
    tenant_id: tenantId, worker_id: workerId, action_type: actionType, token,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  })
  if (error) { console.error('issueFieldFormLink insert failed', error); return null }
  return `${APP_URL}/f/${token}`
}

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
// LINE quick-reply labels cap at 20 chars -- the message `text` sent on
// tap can stay full-length (used for the exact-match lookup below), so
// truncating only the visible label loses no matching precision.
function truncateLabel(s: string, max = 20): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

type GroupActionType = 'issue_report' | 'material_request' | 'leave'
type DMOnlyActionType = 'check_in' | 'check_out' | 'site_photo' | 'job_done_start' | 'today_job'
type ActionType = GroupActionType | DMOnlyActionType
type PendingActionType = GroupActionType | 'site_photo' | 'job_done_pick' | 'job_done' | 'check_in_location' | 'check_out_location'

// LINE bots have no way to remove someone from a group chat -- there's
// no "kick member" API for Official Accounts. So an offboarded worker
// (workers.status = 'inactive') can still technically sit in the crew
// group. This can't auto-fix that, but it can (a) refuse to act on
// anything they send -- checked/reports/leave from a departed worker
// never reach a live table -- and (b) tell an OWNER so a human removes
// them from the group. Rate-limited to once per 24h per worker via
// line_offboarding_alerted_at, so their continued presence doesn't
// re-fire this on every message. (A proactive version of this same
// alert also fires immediately on status change -- see
// supabase/functions/line-worker-offboarded and migration
// 2026-09-23-03 -- this reactive one is a fallback in case that
// somehow doesn't fire, not the primary path anymore.)
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

function promptForAction(action: GroupActionType | 'site_photo'): string {
  if (action === 'issue_report') return '🚧 รับทราบครับ ช่วยบอกรายละเอียดปัญหาที่พบด้วยครับ'
  if (action === 'material_request') return '📦 รับทราบครับ ช่วยบอกรายการของที่ต้องการเบิกด้วยครับ'
  if (action === 'site_photo') return '📷 ส่งรูปหน้างานมาได้เลยครับ (ส่งได้หลายรูป พอครบแล้วกด "เสร็จแล้ว")'
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

// Used by the 1:1 DM path -- all eight actions. เช็คอิน/เช็คเอาท์/
// รูปภาพ/งานเสร็จ/งานวันนี้ don't collide with any existing phrase or
// each other (checked: "งานวันนี้" doesn't contain "งานเสร็จ").
function matchDMAction(text: string): ActionType | null {
  const base = matchGroupAction(text)
  if (base) return base
  if (text.includes('เช็คอิน')) return 'check_in'
  if (text.includes('เช็คเอาท์')) return 'check_out'
  if (text.includes('รูปภาพ')) return 'site_photo'
  if (text.includes('งานเสร็จ') || text.includes('เสร็จงาน')) return 'job_done_start'
  if (text.includes('งานวันนี้')) return 'today_job'
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

// Resolves the worker's OWN currently-open Kanban tasks (not yet
// 'done'), via phase_task_workers. Used by งานเสร็จ's actual closing
// action -- a worker can only mark done what's assigned to THEM, for
// accountability. Ordered by sort_order so the list matches the order
// tasks appear on the real board.
async function resolveOpenTasksForWorker(workerId: string, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await admin
    .from('phase_task_workers')
    .select('task_id, phase_tasks!inner(id, name, status, tenant_id, sort_order)')
    .eq('worker_id', workerId)
    .eq('phase_tasks.tenant_id', tenantId)
    .neq('phase_tasks.status', 'done')
    .order('sort_order', { referencedTable: 'phase_tasks' })
  return (data ?? []).map((row: any) => ({ id: row.phase_tasks.id as string, name: row.phase_tasks.name as string }))
}

// All open Kanban cards for the SITE, not just this worker's own --
// team visibility for "what's happening today," per the user's own
// framing of the daily workflow ("all worker look at the board seeing
// todays work across the board"). Shown in งานวันนี้'s summary;
// deliberately distinct from resolveOpenTasksForWorker above, which
// stays the source of truth for the actual งานเสร็จ closing action.
async function resolveOpenTasksForSite(siteId: string, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await admin
    .from('phase_tasks')
    .select('id, name')
    .eq('site_id', siteId)
    .eq('tenant_id', tenantId)
    .neq('status', 'done')
    .order('sort_order')
  return data ?? []
}

async function fetchLineImageContent(accessToken: string, messageId: string): Promise<Uint8Array | null> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}

// Step 1 of 2 for both actions: resolve today's site, stash it on the
// pending row (site_id -- the location message that answers this is a
// separate webhook event with no other way to carry which site it's
// being checked against), and ask the worker to share their LINE
// location via the native picker. No coordinates exist yet -- nothing
// to validate until step 2 arrives.
async function handleCheckInStart(worker: { id: string }, settings: { tenant_id: string; channel_access_token: string }, replyToken: string) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const { error } = await admin.from('line_pending_actions').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'check_in_location', site_id: site.id, expires_at: expiresAt, photo_count: 0 },
    { onConflict: 'worker_id' }
  )
  if (error) console.error('line_pending_actions check_in_location upsert failed', error)
  await sendLineReply(settings.channel_access_token, replyToken, `📍 กดปุ่มด้านล่างเพื่อแชร์ตำแหน่งและเช็คอินที่ ${site.name}`, [{ label: 'แชร์ตำแหน่ง', location: true }])
}

async function handleCheckOutStart(worker: { id: string }, settings: { tenant_id: string; channel_access_token: string }, replyToken: string) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const { error } = await admin.from('line_pending_actions').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'check_out_location', site_id: site.id, expires_at: expiresAt, photo_count: 0 },
    { onConflict: 'worker_id' }
  )
  if (error) console.error('line_pending_actions check_out_location upsert failed', error)
  await sendLineReply(settings.channel_access_token, replyToken, `📍 กดปุ่มด้านล่างเพื่อแชร์ตำแหน่งและเช็คเอาท์ที่ ${site.name}`, [{ label: 'แชร์ตำแหน่ง', location: true }])
}

// Step 2 of 2: a `location` message arrived while check_in_location was
// pending. Calls perform_worker_checkin_by_id -- the SAME geofence/
// validation logic as the web app's own check-in card (see migration
// 2026-09-23-05), just keyed by worker id instead of auth.email() since
// the webhook runs as service_role with no worker's own session. On
// success, appends the worker's own open Kanban cards to the reply (the
// artifact comment thread's explicit ask); on an out-of-range rejection
// the pending row is left in place so sharing location again (no need
// to re-tap เช็คอิน) can succeed once they're closer.
async function handleCheckInLocation(
  worker: { id: string },
  site: { id: string; name: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  lat: number,
  lng: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc('perform_worker_checkin_by_id', { p_worker_id: worker.id, p_site_id: site.id, p_lat: lat, p_lng: lng })
  const result = data?.[0] as { success: boolean; distance_m: number | null; radius_m: number | null; message: string } | undefined
  if (error || !result) {
    console.error('perform_worker_checkin_by_id failed', error)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return true
  }
  if (!result.success) {
    await sendLineReply(settings.channel_access_token, replyToken, `📍 ${result.message}`, [{ label: 'แชร์ตำแหน่ง', location: true }])
    return false
  }
  const myTasks = await resolveOpenTasksForWorker(worker.id, settings.tenant_id)
  const lines = [`✅ ${result.message} ที่ ${site.name} เวลา ${bangkokTimeString()} น.`]
  if (myTasks.length) {
    lines.push('', '🔧 งานของคุณวันนี้:')
    lines.push(...myTasks.map((t) => `• ${t.name}`))
  }
  await sendLineReply(settings.channel_access_token, replyToken, lines.join('\n'))
  return true
}

async function handleCheckOutLocation(
  worker: { id: string },
  site: { id: string; name: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  lat: number,
  lng: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc('perform_worker_checkout_by_id', { p_worker_id: worker.id, p_site_id: site.id, p_lat: lat, p_lng: lng })
  const result = data?.[0] as { success: boolean; distance_m: number | null; radius_m: number | null; message: string } | undefined
  if (error || !result) {
    console.error('perform_worker_checkout_by_id failed', error)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return true
  }
  if (!result.success) {
    await sendLineReply(settings.channel_access_token, replyToken, `📍 ${result.message}`, [{ label: 'แชร์ตำแหน่ง', location: true }])
    return false
  }
  await sendLineReply(settings.channel_access_token, replyToken, `🏁 ${result.message} ที่ ${site.name} เวลา ${bangkokTimeString()} น. วันนี้ทำงานหนักแล้ว พักผ่อนด้วยนะครับ`)
  return true
}

// The new single entry point -- resolves today's status and shows only
// the tap-options relevant right now, instead of the earlier flat
// 6-button menu that assumed a worker already knew which action to
// use. Reuses every existing helper/handler as-is: the quick-reply
// labels below are the SAME trigger phrases matchDMAction already
// listens for, so tapping one flows straight into the existing action,
// completely unchanged.
async function handleTodaysJobMenu(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const [checkinResult, siteTasks, myTasks] = await Promise.all([
    admin.from('worker_checkins').select('checkin_at, checkout_at').eq('worker_id', worker.id).eq('site_id', site.id).eq('date', bangkokToday()).maybeSingle(),
    resolveOpenTasksForSite(site.id, settings.tenant_id),
    resolveOpenTasksForWorker(worker.id, settings.tenant_id),
  ])
  const checkin = checkinResult.data

  const lines = [`📍 วันนี้: ${site.name}`]
  if (siteTasks.length) {
    lines.push('', '🔧 งานที่ต้องทำวันนี้ (ทั้งทีม):')
    lines.push(...siteTasks.map((t) => `• ${t.name}`))
  }

  const options: string[] = []
  if (!checkin?.checkin_at) options.push('เช็คอิน')
  else if (!checkin?.checkout_at) options.push('เช็คเอาท์')
  if (myTasks.length) options.push('งานเสร็จ')
  options.push('แจ้งปัญหา', 'รูปภาพหน้างาน')

  await sendLineReply(settings.channel_access_token, replyToken, lines.join('\n'), options.map((o) => ({ label: truncateLabel(o), text: o })))
}

// รูปภาพหน้างาน accepts MULTIPLE photos per session -- each one uploads
// and saves immediately (no data loss if the session later expires),
// the pending action stays open for more, and a "เสร็จแล้ว" quick-reply
// chip after each photo lets the worker signal when they're done
// instead of the bot guessing how many were expected.
async function handleSitePhotoAdd(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  messageId: string,
  pendingId: string,
  priorCount: number,
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
    return
  }
  const newCount = priorCount + 1
  const { error: countError } = await admin.from('line_pending_actions').update({ photo_count: newCount }).eq('id', pendingId)
  if (countError) console.error('line_pending_actions photo_count update failed', countError)
  await sendLineReply(settings.channel_access_token, replyToken, `📷 รับรูปแล้ว (${newCount} รูป) ส่งเพิ่มได้อีก หรือกด "เสร็จแล้ว" ถ้าส่งครบ`, [{ label: 'เสร็จแล้ว', text: 'เสร็จแล้ว' }])
}

// Returns true if the pending action should now be closed (caller
// deletes the row), false if it must stay open (nothing was sent yet).
async function handleSitePhotoFinish(
  settings: { channel_access_token: string },
  replyToken: string,
  photoCount: number,
): Promise<boolean> {
  if (photoCount === 0) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ยังไม่ได้ส่งรูปเลยครับ ส่งรูปหน้างานก่อน แล้วค่อยกด "เสร็จแล้ว"')
    return false
  }
  await sendLineReply(settings.channel_access_token, replyToken, `✅ บันทึกรูปภาพหน้างานแล้ว ${photoCount} รูป เรียบร้อยครับ`)
  return true
}

// Starts the งานเสร็จ flow -- resolves the worker's OWN open tasks and
// either goes straight to asking for a photo (one task, the common
// case) or asks which one via quick-reply chips (multiple tasks -- tap
// the name, no typing, per the low-literacy-crew constraint).
async function handleJobDoneStart(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
) {
  const tasks = await resolveOpenTasksForWorker(worker.id, settings.tenant_id)
  if (tasks.length === 0) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายให้คุณตอนนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  if (tasks.length === 1) {
    const { error } = await admin.from('line_pending_actions').upsert(
      { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'job_done', task_id: tasks[0].id, expires_at: expiresAt, photo_count: 0 },
      { onConflict: 'worker_id' }
    )
    if (error) console.error('line_pending_actions upsert failed (job_done, single task)', error)
    await sendLineReply(settings.channel_access_token, replyToken, `📷 "${tasks[0].name}" เสร็จแล้วใช่ไหมครับ ส่งรูปงานเสร็จมาได้เลย (ส่งได้หลายรูป พอครบแล้วกด "เสร็จแล้ว")`)
    return
  }
  const { error } = await admin.from('line_pending_actions').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'job_done_pick', task_id: null, expires_at: expiresAt, photo_count: 0 },
    { onConflict: 'worker_id' }
  )
  if (error) console.error('line_pending_actions upsert failed (job_done_pick)', error)
  await sendLineReply(
    settings.channel_access_token,
    replyToken,
    'งานไหนเสร็จครับ? กดเลือกจากรายการด้านล่างได้เลย',
    tasks.map((t) => ({ label: truncateLabel(t.name), text: t.name })),
  )
}

// Consumes the tapped quick-reply reply to "which task" -- re-resolves
// the same candidate list (rather than storing it) and matches by
// exact name, since a tapped quick-reply chip sends its full `text`
// back verbatim. A non-matching reply (someone typed instead of
// tapping) is silently ignored -- the prompt stays live until they
// tap or it expires, same "stray message ignored" pattern used
// elsewhere in this file.
async function handleJobDonePick(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  text: string,
) {
  const tasks = await resolveOpenTasksForWorker(worker.id, settings.tenant_id)
  const picked = tasks.find((t) => t.name === text.trim())
  if (!picked) return // ignored -- prompt (and its quick-reply chips) stays live
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const { error } = await admin.from('line_pending_actions').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'job_done', task_id: picked.id, expires_at: expiresAt, photo_count: 0 },
    { onConflict: 'worker_id' }
  )
  if (error) console.error('line_pending_actions upsert failed (job_done, after pick)', error)
  await sendLineReply(settings.channel_access_token, replyToken, `📷 "${picked.name}" เสร็จแล้วใช่ไหมครับ ส่งรูปงานเสร็จมาได้เลย (ส่งได้หลายรูป พอครบแล้วกด "เสร็จแล้ว")`)
}

// งานเสร็จ also accepts MULTIPLE completion photos per session -- each
// uploads and saves immediately (tagged with task_id, unlike a general
// รูปภาพหน้างาน photo), but phase_tasks.status only flips to 'done' once
// "เสร็จแล้ว" is confirmed (handleJobDonePhotoFinish below), not on the
// first photo.
async function handleJobDonePhotoAdd(
  worker: { id: string },
  taskId: string,
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  messageId: string,
  pendingId: string,
  priorCount: number,
) {
  const { data: task } = await admin.from('phase_tasks').select('id, name, site_id').eq('id', taskId).maybeSingle()
  if (!task) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานนี้แล้ว อาจถูกลบหรือแก้ไข กรุณาติดต่อแอดมิน')
    return
  }
  const content = await fetchLineImageContent(settings.channel_access_token, messageId)
  if (!content) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ดึงรูปภาพไม่สำเร็จ กรุณาลองส่งใหม่')
    return
  }
  const photoPath = `${settings.tenant_id}/${task.site_id}/${Date.now()}-${worker.id}-done.jpg`
  const { error: uploadError } = await admin.storage.from('line-site-photos').upload(photoPath, content, { contentType: 'image/jpeg' })
  if (uploadError) {
    console.error('line-site-photos upload failed (job done)', uploadError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่')
    return
  }
  const { error: photoInsertError } = await admin.from('line_site_photos').insert({
    tenant_id: settings.tenant_id, worker_id: worker.id, site_id: task.site_id, task_id: task.id, date: bangkokToday(), photo_path: photoPath,
  })
  if (photoInsertError) {
    console.error('line_site_photos insert failed (job done)', photoInsertError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return
  }
  const newCount = priorCount + 1
  const { error: countError } = await admin.from('line_pending_actions').update({ photo_count: newCount }).eq('id', pendingId)
  if (countError) console.error('line_pending_actions photo_count update failed', countError)
  await sendLineReply(settings.channel_access_token, replyToken, `📷 "${task.name}" รับรูปแล้ว (${newCount} รูป) ส่งเพิ่มได้อีก หรือกด "เสร็จแล้ว" ถ้าส่งครบ`, [{ label: 'เสร็จแล้ว', text: 'เสร็จแล้ว' }])
}

// Closes the real Kanban card -- flips phase_tasks.status to 'done',
// the exact same status value and column the web Kanban board
// (PhaseKanbanBoard.jsx) already reads, so this shows up there
// immediately, same as if an admin had dragged the card themselves.
// Returns true if the pending action should now be closed, false if it
// must stay open (nothing was sent yet, or the status update failed
// and should be retryable without losing the photos already uploaded).
async function handleJobDonePhotoFinish(
  taskId: string,
  settings: { channel_access_token: string },
  replyToken: string,
  photoCount: number,
): Promise<boolean> {
  if (photoCount === 0) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ยังไม่ได้ส่งรูปเลยครับ ส่งรูปงานเสร็จก่อน แล้วค่อยกด "เสร็จแล้ว"')
    return false
  }
  const { data: task } = await admin.from('phase_tasks').select('id, name').eq('id', taskId).maybeSingle()
  if (!task) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานนี้แล้ว อาจถูกลบหรือแก้ไข กรุณาติดต่อแอดมิน')
    return true // nothing more this pending action can do -- let it close
  }
  const { error: statusError } = await admin.from('phase_tasks').update({ status: 'done' }).eq('id', task.id)
  if (statusError) {
    console.error('phase_tasks status update failed', statusError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return false // let them retry "เสร็จแล้ว" -- already-uploaded photos are safe either way
  }
  await sendLineReply(settings.channel_access_token, replyToken, `✅ บันทึกงานเสร็จแล้ว "${task.name}" (${photoCount} รูป) อัปเดตบอร์ดเรียบร้อยครับ`)
  return true
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
    // A real structured request (material_requests, 'pending') via a
    // one-time web form -- NOT a purchase_orders insert. purchase_orders'
    // site_id/supplier_id/category_id are all NOT NULL FKs a bare crew
    // text message (or this worker, from the field) has no way to supply;
    // an ADMIN turns an approved request into a real PO once those are
    // known. See field-form Edge Function + src/FieldFormPage.jsx.
    const link = await issueFieldFormLink(settings.tenant_id, worker.id, 'material_request')
    if (!link) {
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, `📦 กดลิงก์นี้เพื่อบอกรายการของที่ต้องการเบิกครับ (ใช้ได้ 30 นาที)\n${link}`)
    }
  } else {
    // Same one-time-link pattern for leave -- a leave_requests row
    // ('pending'), never written straight to worker_assignments anymore.
    // An ADMIN/OWNER approving it in HR.jsx is what creates the real
    // schedule day(s); a worker's own LINE message was never enough
    // authority for that on its own.
    const link = await issueFieldFormLink(settings.tenant_id, worker.id, 'leave')
    if (!link) {
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, `🏖️ กดลิงก์นี้เพื่อกรอกวันที่ลาครับ (ใช้ได้ 30 นาที)\n${link}`)
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
    if (msgType !== 'text' && msgType !== 'image' && msgType !== 'location') continue
    const text: string | undefined = msgType === 'text' ? event.message.text : undefined
    const messageId: string = event.message.id
    const lat: number | undefined = msgType === 'location' ? event.message.latitude : undefined
    const lng: number | undefined = msgType === 'location' ? event.message.longitude : undefined
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
      // รูปภาพหน้างาน/งานเสร็จ prompt. Linking-code match is checked
      // first since it's a narrower, more specific match.
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
        const pendingAction = pending.action as PendingActionType
        const priorCount = (pending.photo_count as number | null) ?? 0
        if (pendingAction === 'site_photo') {
          if (msgType === 'image') {
            await handleSitePhotoAdd(worker, settings, event.replyToken, messageId, pending.id, priorCount)
            // Pending row stays open -- more photos or "เสร็จแล้ว" can follow.
          } else if (msgType === 'text' && text?.trim() === 'เสร็จแล้ว') {
            const shouldClose = await handleSitePhotoFinish(settings, event.replyToken, priorCount)
            if (shouldClose) {
              const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
              if (deleteError) console.error('line_pending_actions delete failed', deleteError)
            }
          }
          // Any other stray text while accumulating photos is silently ignored.
        } else if (pendingAction === 'job_done_pick') {
          if (msgType === 'text' && text) await handleJobDonePick(worker, settings, event.replyToken, text)
          // An image while still picking which task is silently ignored.
        } else if (pendingAction === 'job_done') {
          if (msgType === 'image') {
            await handleJobDonePhotoAdd(worker, pending.task_id as string, settings, event.replyToken, messageId, pending.id, priorCount)
            // Pending row stays open -- more photos or "เสร็จแล้ว" can follow.
          } else if (msgType === 'text' && text?.trim() === 'เสร็จแล้ว') {
            const shouldClose = await handleJobDonePhotoFinish(pending.task_id as string, settings, event.replyToken, priorCount)
            if (shouldClose) {
              const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
              if (deleteError) console.error('line_pending_actions delete failed', deleteError)
            }
          }
          // Any other stray text while accumulating photos is silently ignored.
        } else if (pendingAction === 'check_in_location' || pendingAction === 'check_out_location') {
          if (msgType === 'location' && lat !== undefined && lng !== undefined && pending.site_id) {
            const { data: site } = await admin.from('sites').select('id, name').eq('id', pending.site_id).maybeSingle()
            if (!site) {
              await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
              await admin.from('line_pending_actions').delete().eq('id', pending.id)
            } else {
              const shouldClose = pendingAction === 'check_in_location'
                ? await handleCheckInLocation(worker, site, settings, event.replyToken, lat, lng)
                : await handleCheckOutLocation(worker, site, settings, event.replyToken, lat, lng)
              if (shouldClose) {
                const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
                if (deleteError) console.error('line_pending_actions delete failed', deleteError)
              }
            }
          } else if (msgType === 'text') {
            await sendLineReply(settings.channel_access_token, event.replyToken, '📍 กรุณากดปุ่ม "แชร์ตำแหน่ง" เพื่อส่งตำแหน่งของคุณ', [{ label: 'แชร์ตำแหน่ง', location: true }])
          }
          // A stray image while awaiting location is silently ignored.
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
          await handleCheckInStart(worker, settings, event.replyToken)
        } else if (action === 'check_out') {
          await handleCheckOutStart(worker, settings, event.replyToken)
        } else if (action === 'job_done_start') {
          await handleJobDoneStart(worker, settings, event.replyToken)
        } else if (action === 'today_job') {
          await handleTodaysJobMenu(worker, settings, event.replyToken)
        } else if (action) {
          // issue_report / material_request / leave / site_photo --
          // two-step: ask for detail, consume the next matching message.
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
          const { error } = await admin.from('line_pending_actions').upsert(
            { tenant_id: settings.tenant_id, worker_id: worker.id, action, expires_at: expiresAt, photo_count: 0 },
            { onConflict: 'worker_id' }
          )
          if (error) console.error('line_pending_actions upsert failed', error)
          await sendLineReply(settings.channel_access_token, event.replyToken, promptForAction(action as GroupActionType | 'site_photo'))
        }
        // No match and no pending action -- unrecognized DM text from a
        // linked worker, silently ignored.
      }
      continue
    }

    // A message from the crew group -- only act on it if it's actually
    // that tenant's configured crew group, and only text (photos/checkin/
    // job-done/today's-work menu are 1:1-DM-only, matching the Rich
    // Menu's own DM-only scope).
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
