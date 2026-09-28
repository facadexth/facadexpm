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
// Eleven crew actions total, two entry points:
//   - Typed keywords in the shared crew group -> immediate action.
//     Write actions scoped to the original three (แจ้งปัญหา/ขอเบิกของ/
//     ขอลา) only -- เช็คอิน/เช็คเอาท์/รูปภาพหน้างาน/งานเสร็จ stay
//     1:1-DM-only (needs a linked worker's own identity/location/photo).
//     But งานวันนี้/งานวันพรุ่งนี้/งานอาทิตย์นี้/งานอาทิตย์หน้า -- the 4
//     read-only status queries -- work in BOTH: in a DM they answer for
//     the asking worker only (handleTodaysJobMenu/handleSingleDayQuery/
//     handleWeekQuery); in the crew GROUP they answer for the WHOLE TEAM
//     instead (matchGroupInfoAction/handleGroupInfoQuery, same
//     grouped-by-site shape as the automated daily-assignments push) --
//     "in group chat, i want it to be whole team work" was the explicit
//     ask, since a personal answer posted into a shared group would be
//     answering the wrong question for everyone else reading it.
//   - The SAME trigger phrases (or a Rich Menu button tap, configured
//     manually in LINE Official Account Manager to send fixed text) in
//     a 1:1 DM -> two-step for the "needs a detail" actions (ask ->
//     next message is the body). เช็คอิน/เช็คเอาท์ instead issue a
//     one-time /f/<token> link (2026-09-28, same field-form pattern as
//     ขอเบิกของ/ขอลา below) whose destination page reads the browser's
//     real GPS -- NOT LINE's own location-share picker, which lets the
//     sender drag the pin to any point before sending (confirmed
//     exploitable live). See issueFieldFormLink's own comment.
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
//   "เช็คอิน"/"เช็คเอาท์"   -> issues a /f/<token> link (field-form Edge
//                                 Function); that page reads the phone
//                                 browser's GPS and calls
//                                 perform_worker_checkin_by_id/
//                                 perform_worker_checkout_by_id (the SAME
//                                 geofenced RPCs, worker_checkins table,
//                                 and app_settings.checkin_radius_m the
//                                 web app's own check-in card already
//                                 uses -- site resolved from today's own
//                                 worker_assignments, exactly as before).
//                                 Rejects outside the configured radius
//                                 with the distance shown on the page.
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
//   "งานวันพรุ่งนี้"          -> handleSingleDayQuery: read-only, site +
//                                 team's open tasks at that site for
//                                 tomorrow, no action chips (nothing
//                                 about a future day is actionable yet)
//   "งานอาทิตย์นี้"/"งานอาทิตย์หน้า" -> handleWeekQuery: read-only, one
//                                 line per day (Mon-Sun, matching this
//                                 app's own week convention) showing
//                                 which site that day, no task detail
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
// src/FieldFormPage.jsx) for เบิกของ/ขอลา/เช็คอิน/เช็คเอาท์ -- replaces the
// old free-text insert (material_request couldn't satisfy
// purchase_orders' NOT NULL site_id/supplier_id/category_id; leave
// wrote straight into worker_assignments with no approval step at
// all), and for เช็คอิน/เช็คเอาท์ replaces LINE's own native
// location-share picker (2026-09-28 -- see field-form/index.ts's top
// comment for why: that picker lets the sender drag the pin anywhere
// before sending, confirmed exploitable live). 30 minutes is enough to
// switch from LINE to the browser and back without leaving a stale
// link usable for days.
async function issueFieldFormLink(tenantId: string, workerId: string, actionType: 'material_request' | 'leave' | 'check_in' | 'check_out'): Promise<string | null> {
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
// LINE quick-reply labels cap at 20 chars -- the message `text` sent on
// tap can stay full-length (used for the exact-match lookup below), so
// truncating only the visible label loses no matching precision.
function truncateLabel(s: string, max = 20): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

type GroupActionType = 'issue_report' | 'material_request' | 'leave'
type DMOnlyActionType = 'check_in' | 'check_out' | 'site_photo' | 'job_done_start' | 'today_job' | 'tomorrow_job' | 'this_week_job' | 'next_week_job'
type ActionType = GroupActionType | DMOnlyActionType
type PendingActionType = GroupActionType | 'site_photo' | 'job_done_pick' | 'job_done'

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

// Used by the 1:1 DM path -- all eleven actions. เช็คอิน/เช็คเอาท์/
// รูปภาพ/งานเสร็จ/งานวันนี้/งานวันพรุ่งนี้/งานอาทิตย์นี้/งานอาทิตย์หน้า don't
// collide with any existing phrase or each other -- checked pairwise as
// substrings (e.g. "งานวันนี้" is NOT a substring of "งานวันพรุ่งนี้": the
// literal 9-char sequence ง-า-น-ว-ั-น-น-ี-้ never appears inside
// ง-า-น-ว-ั-น-พ-ร-ุ-่-ง-น-ี-้). Order doesn't matter for correctness given
// that, but the newer, longer phrases are still checked first.
// The 4 schedule-query phrases below are OWNER-configurable (enable/
// disable + rename, rename supports multiple comma-separated synonyms)
// via line_command_settings -- see 2026-09-27-06-line-command-settings.sql
// + 2026-09-28-02-line-command-settings-all-11.sql (widened to cover
// enable/disable for all 11 commands, per explicit user ask). The
// definitions below are a hand-ported copy of
// src/lib/lineCommandSettings.js (same "port the pure logic" pattern
// as formatDailyAssignmentsPushMessage -- Deno can't import Vite-
// bundled files). Collision-safety between phrases is enforced at SAVE
// time (CommunicationCenter.jsx's validateCustomPhrase, same ported
// source), not here -- these functions just resolve/match whatever is
// currently configured. NOTE: neither matchDMAction nor
// matchGroupInfoAction check `enabled` internally anymore -- they
// report ANY match regardless of enabled state, and every call site
// does the enabled-check + "feature disabled" reply uniformly instead
// (see DISABLED_MESSAGE below), so a disabled command gets an explicit
// reply rather than silently doing nothing.
const SCHEDULE_COMMAND_DEFAULTS: Record<string, string> = {
  today_job: 'งานวันนี้',
  tomorrow_job: 'งานวันพรุ่งนี้',
  this_week_job: 'งานอาทิตย์นี้',
  next_week_job: 'งานอาทิตย์หน้า',
}
type CommandSettingsRow = { command_key: string; enabled: boolean; custom_phrase: string | null }
type CommandSettingsByKey = Record<string, CommandSettingsRow>
function splitPhrases(raw: string | null | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}
function resolveEffectivePhrases(commandKey: string, settingsByKey: CommandSettingsByKey): string[] {
  const row = settingsByKey[commandKey]
  const custom = splitPhrases(row?.custom_phrase)
  return custom.length ? custom : [SCHEDULE_COMMAND_DEFAULTS[commandKey]]
}
function resolveEnabled(commandKey: string, settingsByKey: CommandSettingsByKey): boolean {
  const row = settingsByKey[commandKey]
  return row ? row.enabled !== false : true
}
const SCHEDULE_COMMAND_ORDER = ['tomorrow_job', 'this_week_job', 'next_week_job', 'today_job'] as const
const DISABLED_MESSAGE = '⚠️ ฟีเจอร์นี้ปิดอยู่ขณะนี้ กรุณาติดต่อแอดมินโดยตรงครับ'

function matchDMAction(text: string, commandSettings: CommandSettingsByKey): ActionType | null {
  const base = matchGroupAction(text)
  if (base) return base
  if (text.includes('เช็คอิน')) return 'check_in'
  if (text.includes('เช็คเอาท์')) return 'check_out'
  if (text.includes('รูปภาพ')) return 'site_photo'
  if (text.includes('งานเสร็จ') || text.includes('เสร็จงาน')) return 'job_done_start'
  for (const key of SCHEDULE_COMMAND_ORDER) {
    if (resolveEffectivePhrases(key, commandSettings).some((p) => text.includes(p))) return key
  }
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

const DOW_TH_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
// dateISO + N days, still in Bangkok terms (no DST to worry about).
function bangkokDateISO(fromISO: string, daysOffset: number): string {
  const d = new Date(`${fromISO}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + daysOffset)
  return d.toISOString().slice(0, 10)
}
function formatDateTH(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`)
  const dow = DOW_TH_SHORT[d.getUTCDay()]
  return `${dow} ${dateISO.slice(8, 10)}/${dateISO.slice(5, 7)}`
}
// Monday-Sunday, matching this app's own week convention (date-fns
// startOfWeek/endOfWeek with weekStartsOn: 1 -- see
// src/pages/assign/useAssignRange.js). weekOffset 0 = the week
// containing today, 1 = next week.
function bangkokWeekDates(weekOffset: number): string[] {
  const today = bangkokToday()
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  const mondayOffset = (dow === 0 ? -6 : 1 - dow) + weekOffset * 7
  const monday = bangkokDateISO(today, mondayOffset)
  return Array.from({ length: 7 }, (_, i) => bangkokDateISO(monday, i))
}

// Resolves a worker's real-site-work assignment for EACH of several
// dates in one query (งานวันพรุ่งนี้/งานอาทิตย์นี้/งานอาทิตย์หน้า) --
// same "real site work" filter as resolveTodaysSite, just batched
// across a date range instead of pinned to today. A date with more
// than one site assignment just takes the first, same simplification
// resolveTodaysSite already makes.
async function resolveSitesForDates(workerId: string, tenantId: string, dates: string[]): Promise<Map<string, { id: string; name: string }>> {
  const { data } = await admin
    .from('worker_assignments')
    .select('date, site_id, sites(id, name)')
    .eq('worker_id', workerId)
    .eq('tenant_id', tenantId)
    .in('date', dates)
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
  const bySite = new Map<string, { id: string; name: string }>()
  for (const r of data ?? []) {
    const date = r.date as string
    const site = r.sites as { id: string; name: string } | null
    if (site && !bySite.has(date)) bySite.set(date, site)
  }
  return bySite
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

// เช็คอิน/เช็คเอาท์ (rebuilt 2026-09-28 -- see issueFieldFormLink's own
// comment for why): issues the same kind of one-time /f/<token> link
// เบิกของ/ขอลา already use, whose destination page reads the phone
// browser's real GPS instead of LINE's own drag-a-pin location picker.
// The actual geofence check now happens in field-form/index.ts's
// submit handler (same perform_worker_checkin_by_id/checkout RPCs,
// unchanged) once the worker's browser reports its position -- this
// function's only job is resolving today's site and sending the link.
async function handleCheckInStart(worker: { id: string }, settings: { tenant_id: string; channel_access_token: string }, replyToken: string) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const link = await issueFieldFormLink(settings.tenant_id, worker.id, 'check_in')
  if (!link) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
  } else {
    await sendLineReply(settings.channel_access_token, replyToken, `📍 กดลิงก์นี้เพื่อเช็คอินที่ ${site.name} ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\n${link}`)
  }
}

async function handleCheckOutStart(worker: { id: string }, settings: { tenant_id: string; channel_access_token: string }, replyToken: string) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const link = await issueFieldFormLink(settings.tenant_id, worker.id, 'check_out')
  if (!link) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
  } else {
    await sendLineReply(settings.channel_access_token, replyToken, `📍 กดลิงก์นี้เพื่อเช็คเอาท์ที่ ${site.name} ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\n${link}`)
  }
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

// งานวันพรุ่งนี้ -- same shape as handleTodaysJobMenu's info half (site +
// team's open tasks at that site) but for a single future date, and
// with no quick-reply action chips: เช็คอิน/เช็คเอาท์/งานเสร็จ only make
// sense for TODAY, not a day that hasn't happened yet.
async function handleSingleDayQuery(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  dateISO: string,
  dayLabel: string,
) {
  const sites = await resolveSitesForDates(worker.id, settings.tenant_id, [dateISO])
  const site = sites.get(dateISO)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, `📅 ${dayLabel}: ไม่มีงานที่มอบหมาย`)
    return
  }
  const tasks = await resolveOpenTasksForSite(site.id, settings.tenant_id)
  const lines = [`📅 ${dayLabel}: ${site.name}`]
  if (tasks.length) {
    lines.push('', '🔧 งานที่ต้องทำ (ทั้งทีม):')
    lines.push(...tasks.map((t) => `• ${t.name}`))
  }
  await sendLineReply(settings.channel_access_token, replyToken, lines.join('\n'))
}

// งานอาทิตย์นี้/งานอาทิตย์หน้า -- one line per day, no task detail (7 days
// of task lists would be too much for a chat message). "— ว่าง —" marks
// a day with no real site work assigned yet, same wording DayView.jsx
// and the "คัดลอกสำหรับ LINE" export already use for an empty shift.
async function handleWeekQuery(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  dates: string[],
  weekLabel: string,
) {
  const sites = await resolveSitesForDates(worker.id, settings.tenant_id, dates)
  const lines = [`📅 ${weekLabel}:`]
  for (const dateISO of dates) {
    const site = sites.get(dateISO)
    lines.push(`${formatDateTH(dateISO)} — ${site ? site.name : '— ว่าง —'}`)
  }
  await sendLineReply(settings.channel_access_token, replyToken, lines.join('\n'))
}

// Team-wide version of the same 4 read-only queries, for the crew
// GROUP (not DM): "in group chat, i want it to be whole team work"
// -- reuses the exact same grouped-by-site shape as the automated
// daily-assignments push (line-push-daily-assignments), just callable
// on demand for any day/week instead of only firing once at 18:00 for
// tomorrow. Doesn't require a linked worker -- these are read-only, and
// the crew group itself is already the access boundary (checked by the
// caller before this ever runs).
type TeamSiteGroup = { siteName: string; siteNumber?: string; morning: string[]; evening: string[] }
async function resolveTeamSitesForDate(tenantId: string, dateISO: string): Promise<TeamSiteGroup[]> {
  const { data } = await admin
    .from('worker_assignments')
    .select('site_id, shift, type, workers(name, nickname), sites(name, site_number)')
    .eq('tenant_id', tenantId)
    .eq('date', dateISO)
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
  const bySite = new Map<string, TeamSiteGroup>()
  for (const r of data ?? []) {
    const worker = r.workers as { name?: string; nickname?: string } | null
    const site = r.sites as { name?: string; site_number?: string } | null
    const workerName = worker?.nickname || worker?.name || 'ไม่ทราบชื่อ'
    const siteId = r.site_id as string
    const group = bySite.get(siteId) ?? { siteName: site?.name || '-', siteNumber: site?.site_number, morning: [], evening: [] }
    if (r.shift === 'evening') group.evening.push(workerName)
    else group.morning.push(workerName)
    bySite.set(siteId, group)
  }
  return [...bySite.values()]
}
function formatTeamDayMessage(dayLabel: string, siteGroups: TeamSiteGroup[]): string {
  if (!siteGroups.length) return `📋 ${dayLabel}: ไม่มีงานที่มอบหมาย`
  const lines = [`📋 ${dayLabel}:`]
  siteGroups.forEach((g) => {
    lines.push('')
    lines.push(`🏗️ ${g.siteNumber ? `${g.siteNumber} ` : ''}${g.siteName}`.trim())
    if (g.morning.length) lines.push(`🌅 เช้า: ${g.morning.join(', ')}`)
    if (g.evening.length) lines.push(`🌆 บ่าย: ${g.evening.join(', ')}`)
  })
  return lines.join('\n')
}
// Week view stays compact (site names only, no per-worker breakdown) --
// 7 days x every worker x every site would run well past a readable
// chat message length.
async function resolveTeamSiteNamesForDates(tenantId: string, dates: string[]): Promise<Map<string, string[]>> {
  const { data } = await admin
    .from('worker_assignments')
    .select('date, site_id, sites(name)')
    .eq('tenant_id', tenantId)
    .in('date', dates)
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
  const byDate = new Map<string, Set<string>>()
  for (const r of data ?? []) {
    const date = r.date as string
    const site = r.sites as { name?: string } | null
    if (!site?.name) continue
    if (!byDate.has(date)) byDate.set(date, new Set())
    byDate.get(date)!.add(site.name)
  }
  const result = new Map<string, string[]>()
  for (const [date, names] of byDate) result.set(date, [...names])
  return result
}
function formatTeamWeekMessage(weekLabel: string, dates: string[], siteNamesByDate: Map<string, string[]>): string {
  const lines = [`📅 ${weekLabel}:`]
  for (const dateISO of dates) {
    const names = siteNamesByDate.get(dateISO)
    lines.push(`${formatDateTH(dateISO)} — ${names && names.length ? names.join(', ') : '— ว่าง —'}`)
  }
  return lines.join('\n')
}

type GroupInfoAction = 'today_job' | 'tomorrow_job' | 'this_week_job' | 'next_week_job'
function matchGroupInfoAction(text: string, commandSettings: CommandSettingsByKey): GroupInfoAction | null {
  for (const key of SCHEDULE_COMMAND_ORDER) {
    if (resolveEffectivePhrases(key, commandSettings).some((p) => text.includes(p))) return key as GroupInfoAction
  }
  return null
}
async function handleGroupInfoQuery(
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  action: GroupInfoAction,
) {
  if (action === 'today_job' || action === 'tomorrow_job') {
    const dateISO = action === 'today_job' ? bangkokToday() : bangkokDateISO(bangkokToday(), 1)
    const label = action === 'today_job' ? `วันนี้ (${formatDateTH(dateISO)})` : `พรุ่งนี้ (${formatDateTH(dateISO)})`
    const groups = await resolveTeamSitesForDate(settings.tenant_id, dateISO)
    await sendLineReply(settings.channel_access_token, replyToken, formatTeamDayMessage(label, groups))
    return
  }
  const dates = bangkokWeekDates(action === 'this_week_job' ? 0 : 1)
  const label = (action === 'this_week_job' ? 'งานอาทิตย์นี้' : 'งานอาทิตย์หน้า') + ` (${formatDateTH(dates[0])} - ${formatDateTH(dates[6])})`
  const siteNamesByDate = await resolveTeamSiteNamesForDates(settings.tenant_id, dates)
  await sendLineReply(settings.channel_access_token, replyToken, formatTeamWeekMessage(label, dates, siteNamesByDate))
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
    // resolveTodaysSite, not a caller-supplied site -- same "which site
    // is this worker actually on today" resolution เช็คอิน/เช็คเอาท์/
    // รูปภาพหน้างาน already use. Previously omitted entirely, so every
    // issue report's site_id sat NULL forever -- a real gap found while
    // building the report viewer, since there'd be nothing to show in a
    // "site" column otherwise.
    const site = await resolveTodaysSite(worker.id, settings.tenant_id)
    const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site?.id ?? null, message: text })
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

  const { data: commandSettingsRows } = await admin.from('line_command_settings').select('command_key, enabled, custom_phrase').eq('tenant_id', settings.tenant_id)
  const commandSettingsByKey: CommandSettingsByKey = Object.fromEntries((commandSettingsRows ?? []).map((r: any) => [r.command_key, r]))

  const events = (payload.events as Array<Record<string, any>>) ?? []
  for (const event of events) {
    if (event.type !== 'message') continue
    const msgType = event.message?.type
    // 'location' messages no longer have a handler -- เช็คอิน/เช็คเอาท์
    // moved off LINE's native location-share picker onto the /f/<token>
    // browser-GPS flow (2026-09-28, see issueFieldFormLink's comment).
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
        } else if (msgType === 'text' && text) {
          const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
          if (deleteError) console.error('line_pending_actions delete failed', deleteError)
          await handleAction(pendingAction as GroupActionType, worker, text, settings, event.replyToken)
        }
        continue
      }

      if (msgType === 'text' && text) {
        const action = matchDMAction(text, commandSettingsByKey)
        if (action && !resolveEnabled(action, commandSettingsByKey)) {
          await sendLineReply(settings.channel_access_token, event.replyToken, DISABLED_MESSAGE)
        } else if (action === 'check_in') {
          await handleCheckInStart(worker, settings, event.replyToken)
        } else if (action === 'check_out') {
          await handleCheckOutStart(worker, settings, event.replyToken)
        } else if (action === 'job_done_start') {
          await handleJobDoneStart(worker, settings, event.replyToken)
        } else if (action === 'today_job') {
          await handleTodaysJobMenu(worker, settings, event.replyToken)
        } else if (action === 'tomorrow_job') {
          const dateISO = bangkokDateISO(bangkokToday(), 1)
          await handleSingleDayQuery(worker, settings, event.replyToken, dateISO, `พรุ่งนี้ (${formatDateTH(dateISO)})`)
        } else if (action === 'this_week_job') {
          const dates = bangkokWeekDates(0)
          await handleWeekQuery(worker, settings, event.replyToken, dates, `งานอาทิตย์นี้ (${formatDateTH(dates[0])} - ${formatDateTH(dates[6])})`)
        } else if (action === 'next_week_job') {
          const dates = bangkokWeekDates(1)
          await handleWeekQuery(worker, settings, event.replyToken, dates, `งานอาทิตย์หน้า (${formatDateTH(dates[0])} - ${formatDateTH(dates[6])})`)
        } else if (action === 'material_request' || action === 'leave') {
          // Neither needs typed detail anymore -- handleAction just
          // issues the one-time field-form link (see the 2026-09-20
          // migration off free-text capture). Act on the very first
          // matching message, same as the group path already does.
          // Previously this fell into the generic two-step branch below,
          // which left only a bare "รับทราบครับ..." prompt on tap 1 and
          // didn't send the actual link until a second, unrelated
          // message -- a real bug, not by design.
          await handleAction(action, worker, text, settings, event.replyToken)
        } else if (action) {
          // issue_report / site_photo -- genuinely two-step: ask for
          // detail, consume the next matching message.
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
    if (sourceGroupId !== settings.crew_group_id) {
      // Not the configured crew group -- capture it so an admin can
      // find and promote it from Communication Center instead of the
      // group's ID silently going nowhere (see
      // 2026-09-27-04-line-unrecognized-groups.sql for why this exists:
      // the UI's own "จับได้จากข้อความจริงในกลุ่ม" placeholder implied this
      // capture already happened, and it never did).
      const { error: groupError } = await admin.from('line_unrecognized_groups').upsert(
        { tenant_id: settings.tenant_id, group_id: sourceGroupId, sample_text: text.slice(0, 200), sample_sender: lineUserId, last_seen_at: new Date().toISOString() },
        { onConflict: 'tenant_id,group_id' }
      )
      if (groupError) console.error('line_unrecognized_groups upsert failed', groupError)
      continue
    }

    // Read-only team-wide status queries (งานวันนี้/งานวันพรุ่งนี้/
    // งานอาทิตย์นี้/งานอาทิตย์หน้า) work for anyone in the real crew group,
    // no linked-worker check needed -- unlike the 3 write actions below,
    // these can't create or change anything.
    const infoAction = matchGroupInfoAction(text, commandSettingsByKey)
    if (infoAction) {
      if (!resolveEnabled(infoAction, commandSettingsByKey)) {
        await sendLineReply(settings.channel_access_token, event.replyToken, DISABLED_MESSAGE)
      } else {
        await handleGroupInfoQuery(settings, event.replyToken, infoAction)
      }
      continue
    }

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
    if (action) {
      if (!resolveEnabled(action, commandSettingsByKey)) {
        await sendLineReply(settings.channel_access_token, event.replyToken, DISABLED_MESSAGE)
      } else {
        await handleAction(action, worker, text, settings, event.replyToken)
      }
    }
  }

  return json({ ok: true })
})
