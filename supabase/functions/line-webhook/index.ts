// supabase/functions/line-webhook/index.ts
// Inbound LINE webhook -- receives every event for every tenant on one
// shared platform LINE OA (see
// docs/superpowers/specs/2026-10-01-shared-line-bot-design.md). Every
// tenant now connects to the SAME bot, so the payload's `destination`
// field (the bot's own internal LINE userId) is a constant and can no
// longer identify which tenant sent an event -- signature verification
// is checked once per request against the shared LINE_CHANNEL_SECRET,
// then EACH event resolves its own tenant individually (from
// line_settings.crew_group_id for a group message, or
// workers/user_roles.line_user_id for a DM) before being handled.
// verify_jwt is OFF for this function (LINE itself calls it,
// unauthenticated by Supabase's own JWT check) -- signature
// verification IS the access control, same pattern sign-link already
// established for its own public/unauthenticated endpoint.
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
import { verifyLineSignature, sendLineReply, sendLinePush, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET } from '../_shared/line.ts'
import { withPushBudget } from '../_shared/push-budget.ts'
import { todayMenuOptions } from '../_shared/today-menu.ts'
import { CANCEL_PHRASE, CANCEL_CHIP, CANCEL_REPLY, isCancel } from '../_shared/cancel.ts'
import { isMenuButtonText, pendingWaitMinutes } from '../_shared/pending-flow.ts'
import { siteMapLink } from '../_shared/site-map-link.ts'
import { formatWeekMessage, type WeekDay, type WeekSite } from '../_shared/week-message.ts'
import { TIME_CLOCK_PHRASE, SCHEDULE_MENU_PHRASE, SCHEDULE_MENU_PROMPT, TIME_CLOCK_DONE_MESSAGE, timeClockStep, scheduleMenuChips } from '../_shared/schedule-menu.ts'
import { jobDonePrompt, jobDoneConfirmation, JOB_DONE_CONFIRM_CHIP } from '../_shared/job-done-messages.ts'
import { isPushEnabled } from '../_shared/push-settings.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import {
  routeDmEvent, isStartPhrase, logSafeError, ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_NOTICE, ADMIN_CHAT_ACK_NOTICE,
  ADMIN_CHAT_NOT_ALLOWED_NOTICE, ADMIN_CHAT_END_QUICK_REPLY,
} from '../_shared/line-admin-chat-logic.ts'
import { getChatMode, canStartAdminChat, claimAckForSession, startChatSession, endChatSession, recordUserText, recordUserImage } from '../_shared/line-admin-chat.ts'
import { APP_URL } from '../_shared/app-url.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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
  if (error) { logSafeError('issueFieldFormLink insert failed', error); return null }
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
type DMOnlyActionType = 'check_in' | 'check_out' | 'site_photo' | 'job_done_start' | 'today_job' | 'tomorrow_job' | 'this_week_job' | 'next_week_job' | 'time_clock' | 'schedule_menu'
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
  if (!(await isPushEnabled(admin, settings.tenant_id, 'line_push_offboarding'))) return
  const { data: owners } = await admin
    .from('user_roles')
    .select('line_user_id')
    .eq('tenant_id', settings.tenant_id)
    .eq('role', 'OWNER')
    .not('line_user_id', 'is', null)
  for (const owner of owners ?? []) {
    await withPushBudget(admin, settings.tenant_id, () => sendLinePush(settings.channel_access_token, owner.line_user_id as string, `⚠️ ${worker.name} (พ้นสภาพพนักงานแล้ว) ยังคงส่งข้อความในระบบ LINE อยู่ กรุณาลบออกจากกลุ่มทีมงานด้วยครับ`))
  }
  const { error } = await admin.from('workers').update({ line_offboarding_alerted_at: new Date().toISOString() }).eq('id', worker.id)
  if (error) logSafeError('workers.line_offboarding_alerted_at update failed', error)
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
type CommandSettingsRow = { command_key: string; enabled_dm: boolean; enabled_group: boolean; custom_phrase: string | null }
type CommandSettingsByKey = Record<string, CommandSettingsRow>
function splitPhrases(raw: string | null | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}
function resolveEffectivePhrases(commandKey: string, settingsByKey: CommandSettingsByKey): string[] {
  const row = settingsByKey[commandKey]
  const custom = splitPhrases(row?.custom_phrase)
  return custom.length ? custom : [SCHEDULE_COMMAND_DEFAULTS[commandKey]]
}
// context: 'dm' | 'group' -- each command is independently toggleable per
// chat context (2026-09-29). A missing row still means "enabled" in both.
function resolveEnabled(commandKey: string, settingsByKey: CommandSettingsByKey, context: 'dm' | 'group'): boolean {
  const row = settingsByKey[commandKey]
  const field = context === 'group' ? 'enabled_group' : 'enabled_dm'
  return row ? row[field] !== false : true
}
const SCHEDULE_COMMAND_ORDER = ['tomorrow_job', 'this_week_job', 'next_week_job', 'today_job'] as const
const DISABLED_MESSAGE = '⚠️ ฟีเจอร์นี้ปิดอยู่ขณะนี้ กรุณาติดต่อแอดมินโดยตรงครับ'

function matchDMAction(text: string, commandSettings: CommandSettingsByKey): ActionType | null {
  // The two Rich Menu buttons that need a decision first. Checked before everything
  // else: the combined phrase contains both เช็คอิน and เช็คเอาท์ and would otherwise
  // be read as a plain check-in.
  if (text.includes(TIME_CLOCK_PHRASE)) return 'time_clock'
  if (text.includes(SCHEDULE_MENU_PHRASE)) return 'schedule_menu'
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
async function resolveTodaysSite(workerId: string, tenantId: string): Promise<{ id: string; name: string; map_url?: string | null; lat?: number | null; lng?: number | null } | null> {
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
  const { data: site } = await admin.from('sites').select('id, name, map_url, lat, lng').eq('id', assignment.site_id).maybeSingle()
  return site ?? null
}

// A tenant's designated fallback site for group-photo auto-filing, when
// the sender has no real site assignment for today -- see spec'd
// 2026-10-01-06-sites-default-flag-and-signup-seed.sql. Explicit
// is_default flag, not a name match: now that every tenant shares one
// platform LINE bot, a hardcoded name/UUID would only ever be correct
// for one specific tenant.
async function resolveFallbackSite(tenantId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await admin.from('sites').select('id, name').eq('tenant_id', tenantId).eq('is_default', true).maybeSingle()
  return data ?? null
}

// Any image a known, linked worker drops in the crew group auto-files
// to their real site assignment for today (or the tenant's default
// site if they have none assigned) -- no "รูปภาพ" trigger phrase
// needed, unlike the DM flow (handleSitePhotoAdd), which still requires
// one. Deliberately silent on failure (a busy group shouldn't get an
// error reply for every transient LINE API hiccup or a tenant with no
// default site configured yet) -- only the success reply is visible,
// giving feedback that the implicit behavior actually worked. Reuses
// the exact same storage bucket/path convention and line_site_photos
// insert shape as handleSitePhotoAdd, just without that flow's
// line_pending_actions photo-count tracking (no "เสร็จแล้ว" step here --
// every image still files individually and immediately).
//
// Reply batching (flagged live 2026-10-01: a 10-photo multi-select send
// from camera roll buried the group in 10 separate confirmations).
// LINE typically delivers a multi-select send as several image events
// in ONE webhook payload -- isLastInBatch/batchCount (computed by the
// caller from that single payload's events, see the pre-scan right
// before the main event loop) lets every photo in that payload still
// file individually and immediately, but only the LAST one of a
// worker's batch within THIS payload actually replies, with the real
// count baked in. For the rarer case where LINE splits one human burst
// across two back-to-back payloads, a short debounce check (was this
// worker's immediately-prior photo saved within BURST_WINDOW_SECONDS?)
// suppresses the second payload's reply too, erring toward fewer
// messages over an exact count when a burst spans a payload boundary.
const BURST_WINDOW_SECONDS = 8

async function handleGroupPhotoAutoFile(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  messageId: string,
  isLastInBatch: boolean,
  batchCount: number,
  // true when the photo came in a 1:1 chat. A busy group stays silent when a photo
  // cannot be filed, but one person sending a photo to the bot must be told it did
  // not go in, or they believe it was saved.
  directChat = false,
) {
  const tellFailure = async (text: string) => {
    if (directChat) await sendLineReply(settings.channel_access_token, replyToken, text)
  }
  const site = (await resolveTodaysSite(worker.id, settings.tenant_id)) ?? (await resolveFallbackSite(settings.tenant_id))
  if (!site) {
    await tellFailure('⚠️ ยังไม่ได้บันทึกรูปครับ ไม่พบงานที่มอบหมายวันนี้ กรุณาแจ้งแอดมิน')
    return
  }

  const content = await fetchLineImageContent(settings.channel_access_token, messageId)
  if (!content) {
    await tellFailure('⚠️ ดึงรูปภาพไม่สำเร็จ กรุณาลองส่งใหม่')
    return
  }

  const photoPath = `${settings.tenant_id}/${site.id}/${Date.now()}-${worker.id}.jpg`
  const { error: uploadError } = await admin.storage.from('line-site-photos').upload(photoPath, content, { contentType: 'image/jpeg' })
  if (uploadError) {
    logSafeError('group photo upload failed', uploadError)
    await tellFailure('⚠️ อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่')
    return
  }
  const { error: insertError } = await admin.from('line_site_photos').insert({
    tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site.id, date: bangkokToday(), photo_path: photoPath,
  })
  if (insertError) {
    logSafeError('group photo line_site_photos insert failed', insertError)
    await tellFailure('⚠️ ระบบขัดข้อง บันทึกรูปไม่สำเร็จ กรุณาแจ้งแอดมินโดยตรง')
    return
  }
  if (!isLastInBatch) return // more of this worker's batch still coming later in this same payload

  // Cross-payload debounce: the row just inserted above is always the
  // most recent, so the SECOND-most-recent (range(1,1)) is this
  // worker's previous photo, if any.
  const { data: priorPhotos } = await admin.from('line_site_photos')
    .select('created_at')
    .eq('worker_id', worker.id)
    .order('created_at', { ascending: false })
    .range(1, 1)
  const priorAt = priorPhotos?.[0]?.created_at ? new Date(priorPhotos[0].created_at as string).getTime() : null
  if (priorAt && Date.now() - priorAt < BURST_WINDOW_SECONDS * 1000) return // continuing a burst that already got its reply

  const countLabel = batchCount > 1 ? ` ${batchCount} รูป` : ''
  await sendLineReply(settings.channel_access_token, replyToken, `📷 บันทึกรูปแล้ว${countLabel} — ${site.name}`)
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
type SiteWithMap = { id: string; name: string; map_url?: string | null; lat?: number | null; lng?: number | null }
async function resolveSitesForDates(workerId: string, tenantId: string, dates: string[]): Promise<Map<string, SiteWithMap>> {
  const { data } = await admin
    .from('worker_assignments')
    .select('date, site_id, sites(id, name, map_url, lat, lng)')
    .eq('worker_id', workerId)
    .eq('tenant_id', tenantId)
    .in('date', dates)
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
  const bySite = new Map<string, SiteWithMap>()
  for (const r of data ?? []) {
    const date = r.date as string
    const site = r.sites as SiteWithMap | null
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

// ⛑️ วันนี้ ไซท์นี้ใครเป็นหัวหน้าทีม (แยกเช้า/บ่าย) -- ตั้งค่าจาก Assign
// Wizard (worker_assignments.is_team_leader, 2026-09-28 migration).
// Used by handleTodaysJobMenu's summary. `dateISO` generic (not always
// "today") so the daily-assignments push (which runs for TOMORROW) can
// reuse the same shape.
async function resolveTeamLeadersForSite(
  siteId: string, tenantId: string, dateISO: string,
): Promise<{ morning: string | null; evening: string | null }> {
  const { data } = await admin
    .from('worker_assignments')
    .select('shift, workers(name, nickname)')
    .eq('site_id', siteId).eq('tenant_id', tenantId).eq('date', dateISO).eq('is_team_leader', true)
  const result: { morning: string | null; evening: string | null } = { morning: null, evening: null }
  for (const r of data ?? []) {
    const w = r.workers as { name?: string; nickname?: string } | null
    const name = w?.nickname || w?.name || null
    if (r.shift === 'morning') result.morning = name
    else if (r.shift === 'evening') result.evening = name
  }
  return result
}

// True if this worker holds 🅒 team-leader status for ANY shift they're
// assigned today at this site -- drives งานเสร็จ's team-wide authority
// below (handleJobDoneStart): a leader can close out teammates' cards,
// not just their own, since they're accountable for the whole crew that
// day. Scoped per (site,date,shift) per the 2026-09-28 migration, but a
// worker only ever has one shift at one site per day in practice, so
// "any shift" here is just "are they marked leader at all today."
async function isTeamLeaderToday(workerId: string, siteId: string, tenantId: string): Promise<boolean> {
  const { data } = await admin
    .from('worker_assignments')
    .select('id')
    .eq('worker_id', workerId).eq('site_id', siteId).eq('tenant_id', tenantId)
    .eq('date', bangkokToday()).eq('is_team_leader', true)
    .limit(1).maybeSingle()
  return !!data
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

// The Rich Menu's single "เช็คอิน/เช็คเอาท์" button: look at the worker's day and send
// the matching link -- check-in until they have checked in, then check-out, then a
// short "done" note. Respects the company's on/off setting for whichever of the two
// commands it ends up running.
async function handleTimeClock(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
  commandSettings: CommandSettingsByKey,
) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  let hasCheckedIn = false
  let hasCheckedOut = false
  if (site) {
    const { data: row } = await admin.from('worker_checkins').select('checkin_at, checkout_at').eq('worker_id', worker.id).eq('site_id', site.id).eq('date', bangkokToday()).maybeSingle()
    hasCheckedIn = !!row?.checkin_at
    hasCheckedOut = !!row?.checkout_at
  }
  const step = timeClockStep({ hasSite: !!site, hasCheckedIn, hasCheckedOut })
  if (step === 'no_site') {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
  } else if (step === 'done') {
    await sendLineReply(settings.channel_access_token, replyToken, TIME_CLOCK_DONE_MESSAGE)
  } else if (!resolveEnabled(step, commandSettings, 'dm')) {
    await sendLineReply(settings.channel_access_token, replyToken, DISABLED_MESSAGE)
  } else if (step === 'check_in') {
    await handleCheckInStart(worker, settings, replyToken)
  } else {
    await handleCheckOutStart(worker, settings, replyToken)
  }
}

// The Rich Menu's "ตารางงาน" button: offer the four schedule views as tappable chips
// (each chip sends the exact phrase the bot already understands for that view).
async function handleScheduleMenu(
  settings: { channel_access_token: string },
  replyToken: string,
  commandSettings: CommandSettingsByKey,
) {
  const chips = scheduleMenuChips(
    (['today_job', 'tomorrow_job', 'this_week_job', 'next_week_job'] as const).map((key) => ({
      phrase: resolveEffectivePhrases(key, commandSettings)[0],
      enabled: resolveEnabled(key, commandSettings, 'dm'),
    })),
  )
  if (chips.length === 0) {
    await sendLineReply(settings.channel_access_token, replyToken, DISABLED_MESSAGE)
    return
  }
  await sendLineReply(settings.channel_access_token, replyToken, SCHEDULE_MENU_PROMPT, [...chips, CANCEL_PHRASE].map((p) => ({ label: truncateLabel(p), text: p })))
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
  // The phrase that runs tomorrow's schedule for this company (they may have renamed it),
  // or null if that command is off in direct chat -- decides the last chip.
  tomorrowPhrase: string | null,
) {
  const site = await resolveTodaysSite(worker.id, settings.tenant_id)
  if (!site) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานที่มอบหมายวันนี้ กรุณาติดต่อแอดมิน')
    return
  }
  const [checkinResult, siteTasks, myTasks, leaders] = await Promise.all([
    admin.from('worker_checkins').select('checkin_at, checkout_at').eq('worker_id', worker.id).eq('site_id', site.id).eq('date', bangkokToday()).maybeSingle(),
    resolveOpenTasksForSite(site.id, settings.tenant_id),
    resolveOpenTasksForWorker(worker.id, settings.tenant_id),
    resolveTeamLeadersForSite(site.id, settings.tenant_id, bangkokToday()),
  ])
  const checkin = checkinResult.data

  const lines = [`📍 วันนี้: ${site.name}`]
  const todayMap = siteMapLink(site)
  if (todayMap) lines.push(`🗺️ ${todayMap}`)
  if (leaders.morning || leaders.evening) {
    const parts: string[] = []
    if (leaders.morning) parts.push(`เช้า ${leaders.morning}`)
    if (leaders.evening) parts.push(`บ่าย ${leaders.evening}`)
    lines.push(`⛑️ หัวหน้าทีม: ${parts.join(' · ')}`)
  }
  if (siteTasks.length) {
    lines.push('', '🔧 งานที่ต้องทำวันนี้ (ทั้งทีม):')
    lines.push(...siteTasks.map((t) => `• ${t.name}`))
  }

  const options = todayMenuOptions({
    hasCheckedIn: !!checkin?.checkin_at,
    hasCheckedOut: !!checkin?.checkout_at,
    hasOpenTasks: myTasks.length > 0,
    tomorrowPhrase,
  })

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
  const dayMap = siteMapLink(site)
  if (dayMap) lines.push(`🗺️ ${dayMap}`)
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
  const days: WeekDay[] = dates.map((dateISO) => {
    const site = sites.get(dateISO)
    return { dateLabel: formatDateTH(dateISO), sites: site ? [{ siteName: site.name, mapUrl: siteMapLink(site), morning: [], evening: [] }] : [] }
  })
  await sendLineReply(settings.channel_access_token, replyToken, formatWeekMessage(weekLabel, days, false))
}

// Team-wide version of the same 4 read-only queries, for the crew
// GROUP (not DM): "in group chat, i want it to be whole team work"
// -- reuses the exact same grouped-by-site shape as the automated
// daily-assignments push (line-push-daily-assignments), just callable
// on demand for any day/week instead of only firing once at 18:00 for
// tomorrow. Doesn't require a linked worker -- these are read-only, and
// the crew group itself is already the access boundary (checked by the
// caller before this ever runs).
type TeamSiteGroup = { siteName: string; siteNumber?: string; mapUrl?: string | null; morning: string[]; evening: string[] }
async function resolveTeamSitesForDate(tenantId: string, dateISO: string): Promise<TeamSiteGroup[]> {
  const { data } = await admin
    .from('worker_assignments')
    .select('site_id, shift, type, workers(name, nickname), sites(name, site_number, map_url, lat, lng)')
    .eq('tenant_id', tenantId)
    .eq('date', dateISO)
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
  const bySite = new Map<string, TeamSiteGroup>()
  for (const r of data ?? []) {
    const worker = r.workers as { name?: string; nickname?: string } | null
    const site = r.sites as { name?: string; site_number?: string; map_url?: string | null; lat?: number | null; lng?: number | null } | null
    const workerName = worker?.nickname || worker?.name || 'ไม่ทราบชื่อ'
    const siteId = r.site_id as string
    const group = bySite.get(siteId) ?? { siteName: site?.name || '-', siteNumber: site?.site_number, mapUrl: siteMapLink(site), morning: [], evening: [] }
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
    if (g.mapUrl) lines.push(`🗺️ ${g.mapUrl}`)
    if (g.morning.length) lines.push(`🌅 เช้า: ${g.morning.join(', ')}`)
    if (g.evening.length) lines.push(`🌆 บ่าย: ${g.evening.join(', ')}`)
  })
  return lines.join('\n')
}
// Week view: every day, each site with its workers split by shift (formatWeekMessage
// keeps it under LINE's text limit).
async function resolveTeamWeek(tenantId: string, dates: string[]): Promise<WeekDay[]> {
  const { data } = await admin
    .from('worker_assignments')
    .select('date, site_id, shift, workers(name, nickname), sites(name, site_number, map_url, lat, lng)')
    .eq('tenant_id', tenantId)
    .in('date', dates)
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
  const byDate = new Map<string, Map<string, WeekSite>>()
  for (const r of data ?? []) {
    const worker = r.workers as { name?: string; nickname?: string } | null
    const site = r.sites as { name?: string; site_number?: string; map_url?: string | null; lat?: number | null; lng?: number | null } | null
    if (!site?.name) continue
    const date = r.date as string
    const siteId = r.site_id as string
    const sitesOfDay = byDate.get(date) ?? new Map<string, WeekSite>()
    const entry = sitesOfDay.get(siteId) ?? { siteName: site.name, siteNumber: site.site_number, mapUrl: siteMapLink(site), morning: [], evening: [] }
    const workerName = worker?.nickname || worker?.name || 'ไม่ทราบชื่อ'
    if (r.shift === 'evening') entry.evening.push(workerName)
    else entry.morning.push(workerName)
    sitesOfDay.set(siteId, entry)
    byDate.set(date, sitesOfDay)
  }
  return dates.map((d) => ({ dateLabel: formatDateTH(d), sites: [...(byDate.get(d)?.values() ?? [])] }))
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
  const days = await resolveTeamWeek(settings.tenant_id, dates)
  await sendLineReply(settings.channel_access_token, replyToken, formatWeekMessage(label, days))
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
    logSafeError('line-site-photos upload failed', uploadError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่')
    return
  }
  const { error: insertError } = await admin.from('line_site_photos').insert({
    tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site.id, date: bangkokToday(), photo_path: photoPath,
  })
  if (insertError) {
    logSafeError('line_site_photos insert failed', insertError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return
  }
  const newCount = priorCount + 1
  const { error: countError } = await admin.from('line_pending_actions').update({ photo_count: newCount }).eq('id', pendingId)
  if (countError) logSafeError('line_pending_actions photo_count update failed', countError)
  await sendLineReply(settings.channel_access_token, replyToken, `📷 รับรูปแล้ว (${newCount} รูป) ส่งเพิ่มได้อีก หรือกด "เสร็จแล้ว" ถ้าส่งครบ`, [JOB_DONE_CONFIRM_CHIP, CANCEL_CHIP])
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

// งานเสร็จ's candidate task list -- normally just the worker's OWN open
// tasks (accountability: you close what's assigned to you). But a
// worker holding 🅒 team-leader status today (Assign Wizard, see
// isTeamLeaderToday) gets the SAME team-wide list handleTodaysJobMenu
// already shows -- every open card at their site, not just their own --
// explicit ask: leader gets "permission to finish the job for the
// team." Shared by handleJobDoneStart and handleJobDonePick so the
// prompt and its re-resolved candidate list never disagree.
async function resolveJobDoneCandidates(workerId: string, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const site = await resolveTodaysSite(workerId, tenantId)
  if (site && await isTeamLeaderToday(workerId, site.id, tenantId)) {
    return resolveOpenTasksForSite(site.id, tenantId)
  }
  return resolveOpenTasksForWorker(workerId, tenantId)
}

// Starts the งานเสร็จ flow -- resolves the worker's open tasks (team-
// wide if they're today's leader, see resolveJobDoneCandidates) and
// either goes straight to asking for a photo (one task, the common
// case) or asks which one via quick-reply chips (multiple tasks -- tap
// the name, no typing, per the low-literacy-crew constraint).
async function handleJobDoneStart(
  worker: { id: string },
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
) {
  const tasks = await resolveJobDoneCandidates(worker.id, settings.tenant_id)
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
    if (error) logSafeError('line_pending_actions upsert failed (job_done, single task)', error)
    await sendLineReply(settings.channel_access_token, replyToken, jobDonePrompt(tasks[0].name), [JOB_DONE_CONFIRM_CHIP, CANCEL_CHIP])
    return
  }
  const { error } = await admin.from('line_pending_actions').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'job_done_pick', task_id: null, expires_at: expiresAt, photo_count: 0 },
    { onConflict: 'worker_id' }
  )
  if (error) logSafeError('line_pending_actions upsert failed (job_done_pick)', error)
  await sendLineReply(
    settings.channel_access_token,
    replyToken,
    'งานไหนเสร็จครับ? กดเลือกจากรายการด้านล่างได้เลย',
    [...tasks.map((t) => ({ label: truncateLabel(t.name), text: t.name })), CANCEL_CHIP],
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
): Promise<boolean> {
  const tasks = await resolveJobDoneCandidates(worker.id, settings.tenant_id)
  const picked = tasks.find((t) => t.name === text.trim())
  if (!picked) return false // caller decides what to do with a non-match
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const { error } = await admin.from('line_pending_actions').upsert(
    { tenant_id: settings.tenant_id, worker_id: worker.id, action: 'job_done', task_id: picked.id, expires_at: expiresAt, photo_count: 0 },
    { onConflict: 'worker_id' }
  )
  if (error) logSafeError('line_pending_actions upsert failed (job_done, after pick)', error)
  await sendLineReply(settings.channel_access_token, replyToken, jobDonePrompt(picked.name), [JOB_DONE_CONFIRM_CHIP, CANCEL_CHIP])
  return true
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
    logSafeError('line-site-photos upload failed (job done)', uploadError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่')
    return
  }
  const { error: photoInsertError } = await admin.from('line_site_photos').insert({
    tenant_id: settings.tenant_id, worker_id: worker.id, site_id: task.site_id, task_id: task.id, date: bangkokToday(), photo_path: photoPath,
  })
  if (photoInsertError) {
    logSafeError('line_site_photos insert failed (job done)', photoInsertError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return
  }
  const newCount = priorCount + 1
  const { error: countError } = await admin.from('line_pending_actions').update({ photo_count: newCount }).eq('id', pendingId)
  if (countError) logSafeError('line_pending_actions photo_count update failed', countError)
  await sendLineReply(settings.channel_access_token, replyToken, `📷 "${task.name}" รับรูปแล้ว (${newCount} รูป) ส่งเพิ่มได้อีก หรือกด "เสร็จแล้ว" ถ้าส่งครบ`, [JOB_DONE_CONFIRM_CHIP, CANCEL_CHIP])
}

// Closes the real Kanban card -- flips phase_tasks.status to 'done',
// the exact same status value and column the web Kanban board
// (PhaseKanbanBoard.jsx) already reads, so this shows up there
// immediately, same as if an admin had dragged the card themselves.
// Returns true if the pending action should now be closed, false if it
// must stay open (the status update failed
// and should be retryable without losing the photos already uploaded).
async function handleJobDonePhotoFinish(
  taskId: string,
  settings: { channel_access_token: string },
  replyToken: string,
  photoCount: number,
): Promise<boolean> {
  // No photo is required (photoCount may be 0): the photos are often already in the
  // crew group, and sending them twice only makes duplicates.
  const { data: task } = await admin.from('phase_tasks').select('id, name').eq('id', taskId).maybeSingle()
  if (!task) {
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ไม่พบงานนี้แล้ว อาจถูกลบหรือแก้ไข กรุณาติดต่อแอดมิน')
    return true // nothing more this pending action can do -- let it close
  }
  const { error: statusError } = await admin.from('phase_tasks').update({ status: 'done' }).eq('id', task.id)
  if (statusError) {
    logSafeError('phase_tasks status update failed', statusError)
    await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    return false // let them retry "เสร็จแล้ว" -- already-uploaded photos are safe either way
  }
  await sendLineReply(settings.channel_access_token, replyToken, jobDoneConfirmation(task.name, photoCount))
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
    const { data: report, error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, site_id: site?.id ?? null, message: text }).select('id').single()
    if (error) {
      logSafeError('line_issue_reports insert failed', error)
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      // A card on the site's Kanban board; never blocks the report itself.
      const { error: cardError } = await admin.rpc('create_issue_card', { p_report_id: report.id })
      if (cardError) logSafeError('create_issue_card failed', cardError)
      try {
        if (await isPushEnabled(admin, settings.tenant_id, 'web_push_issue_report')) {
        const [{ sendWebPushToTenantAdmins }, { issueReportPush }] = await Promise.all([import('../_shared/web-push.ts'), import('../_shared/web-push-messages.ts')])
        await sendWebPushToTenantAdmins(admin, settings.tenant_id, issueReportPush(worker.name, text))
        }
      } catch (e) { console.error('web push failed', (e as Error).message) }
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

  // destination is now the same constant bot_user_id for every tenant --
  // it identifies OUR bot, not which tenant sent this. Signature
  // verification moves to the one global channel_secret; tenant
  // resolution moves inside the per-event loop below (see
  // docs/superpowers/specs/2026-10-01-shared-line-bot-design.md §4).
  const signatureOk = await verifyLineSignature(LINE_CHANNEL_SECRET, rawBody, req.headers.get('x-line-signature'))
  if (!signatureOk) return json({ error: 'invalid signature' }, 401)

  // Per-tenant line_command_settings now loaded lazily per resolved
  // tenant, cached here so a request with several events from the same
  // tenant (common -- LINE batches events) only queries once.
  const commandSettingsCache = new Map<string, CommandSettingsByKey>()
  async function loadCommandSettings(tenantId: string): Promise<CommandSettingsByKey> {
    const cached = commandSettingsCache.get(tenantId)
    if (cached) return cached
    const { data: rows } = await admin.from('line_command_settings').select('command_key, enabled_dm, enabled_group, custom_phrase').eq('tenant_id', tenantId)
    const byKey: CommandSettingsByKey = Object.fromEntries((rows ?? []).map((r: any) => [r.command_key, r]))
    commandSettingsCache.set(tenantId, byKey)
    return byKey
  }

  const events = (payload.events as Array<Record<string, any>>) ?? []

  // Pre-scan for handleGroupPhotoAutoFile's reply-batching (see its own
  // comment): how many image events does THIS payload hold per sender,
  // so the per-event loop below can tell which one is the last of a
  // worker's batch and reply with an accurate count instead of once per
  // photo.
  const imageEventsPerSender = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'message' && e.message?.type === 'image' && e.source?.userId) {
      imageEventsPerSender.set(e.source.userId, (imageEventsPerSender.get(e.source.userId) ?? 0) + 1)
    }
  }
  const imageEventsSeenPerSender = new Map<string, number>()

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

    // Resolve the tenant for THIS event specifically -- see spec §4.
    // DM code-check happens first (a typed 6-digit code IS the
    // identification for a never-before-seen sender, so it must be
    // checked before concluding "unrecognized").
    let tenantId: string | null = null

    if (!sourceGroupId && msgType === 'text' && text) {
      // Codes are generated uppercase-only (CommunicationCenter.jsx's
      // generateLinkCode) -- normalize what was typed so a lowercase
      // retype still matches.
      const trimmed = text.trim().toUpperCase()
      // No tenant filter here -- unlike today's per-tenant version,
      // we don't know the tenant yet, that's what this lookup resolves.
      // Collision across two different tenants' simultaneously-valid
      // codes is practically impossible (30^6 combinations, same
      // assumption the pre-existing per-tenant version already made).
      const { data: pendingRoleCode, error: roleCodeError } = await admin.from('user_roles').select('id, tenant_id').eq('line_link_code', trimmed).maybeSingle()
      if (roleCodeError) { logSafeError('user_roles line_link_code lookup failed', roleCodeError); continue }
      if (pendingRoleCode) {
        // Real gap closed 2026-10-01 (final-review finding #3): a code
        // match alone used to link the account regardless of whether
        // that tenant can even use the bot. Gate it the same as every
        // other tenant-scoped action below.
        if (!(await tenantHasModuleAccess(admin, pendingRoleCode.tenant_id as string, 'line_bot'))) { continue }
        const { error } = await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingRoleCode.id)
        if (error) {
          logSafeError('user_roles line-link update failed', error)
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้วครับ')
        }
        continue
      }
      const { data: pendingWorkerCode, error: workerCodeError } = await admin.from('workers').select('id, tenant_id').eq('line_link_code', trimmed).maybeSingle()
      if (workerCodeError) { logSafeError('workers line_link_code lookup failed', workerCodeError); continue }
      if (pendingWorkerCode) {
        if (!(await tenantHasModuleAccess(admin, pendingWorkerCode.tenant_id as string, 'line_bot'))) { continue }
        const { error } = await admin.from('workers').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingWorkerCode.id)
        if (error) {
          logSafeError('workers line-link update failed', error)
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้วครับ')
        }
        continue
      }
    }

    if (sourceGroupId) {
      const { data: match, error: matchError } = await admin.from('line_settings').select('tenant_id').eq('crew_group_id', sourceGroupId).maybeSingle()
      if (matchError) { logSafeError('line_settings crew_group_id lookup failed', matchError); continue }
      tenantId = (match?.tenant_id as string | undefined) ?? null
    } else {
      const { data: w, error: workerLookupError } = await admin.from('workers').select('tenant_id').eq('line_user_id', lineUserId).maybeSingle()
      if (workerLookupError) { logSafeError('workers line_user_id lookup failed', workerLookupError); continue }
      tenantId = (w?.tenant_id as string | undefined) ?? null
      if (!tenantId) {
        const { data: u, error: userLookupError } = await admin.from('user_roles').select('tenant_id').eq('line_user_id', lineUserId).maybeSingle()
        if (userLookupError) { logSafeError('user_roles line_user_id lookup failed', userLookupError); continue }
        tenantId = (u?.tenant_id as string | undefined) ?? null
      }
    }

    if (!tenantId) {
      if (sourceGroupId && msgType === 'text' && text) {
        // Group-claim code check (spec §5) -- a group with no owner yet
        // whose message matches SOME tenant's outstanding
        // group_link_code gets claimed for that tenant.
        const trimmed = text.trim().toUpperCase()
        const { data: claimant, error: claimantError } = await admin.from('line_settings').select('tenant_id').eq('group_link_code', trimmed).maybeSingle()
        if (claimantError) { logSafeError('line_settings group_link_code lookup failed', claimantError); continue }
        if (claimant) {
          if (!(await tenantHasModuleAccess(admin, claimant.tenant_id as string, 'line_bot'))) { continue }
          const { error } = await admin.from('line_settings').update({ crew_group_id: sourceGroupId, group_link_code: null }).eq('tenant_id', claimant.tenant_id)
          if (error) {
            logSafeError('line_settings group claim failed', error)
            await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '⚠️ ตั้งกลุ่มไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
          } else {
            await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '✅ ตั้งกลุ่มนี้เป็นกลุ่มทีมงานเรียบร้อยแล้ว')
          }
        }
        // No match at all -- not a claim code (or an expired/already-used
        // one), and no way to tell the difference without revealing
        // whether some other tenant's code once existed. Silently ignore,
        // same as any other unrecognized group text today.
      } else if (!sourceGroupId && msgType === 'text' && text) {
        // DM from a never-linked account -- see spec §6. Pure addition,
        // not a replacement: today this is a silent `continue` with no
        // reply at all.
        await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, 'ยังไม่พบบัญชีนี้ในระบบ — กรุณาติดต่อแอดมินของบริษัทคุณเพื่อขอรหัสเชื่อมต่อ 6 ตัว')
      }
      continue
    }

    const hasLineAccess = await tenantHasModuleAccess(admin, tenantId, 'line_bot')
    if (!hasLineAccess) continue

    const commandSettingsByKey = await loadCommandSettings(tenantId)
    const settings = { tenant_id: tenantId, channel_access_token: LINE_CHANNEL_ACCESS_TOKEN }

    // Hybrid privacy mode (docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
    // DM-only. In the default secure_bot mode this changes nothing and
    // stores nothing; chat_with_admin is entered only by the user's own
    // exact trigger phrase, and only then are messages/photos recorded.
    if (!sourceGroupId) {
      const mode = await getChatMode(admin, lineUserId)
      // Only look up the sender's role when they actually typed the start phrase.
      const canStartChat = mode === 'secure_bot' && msgType === 'text' && isStartPhrase(text)
        ? await canStartAdminChat(admin, lineUserId)
        : false
      const route = routeDmEvent({ mode, msgType, text, canStartChat })
      if (route === 'chat_not_allowed') {
        // A worker asked for the platform admin: point them to their own company instead. Nothing is recorded.
        await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_NOT_ALLOWED_NOTICE)
        continue
      }
      if (route === 'start_chat') {
        await startChatSession(admin, lineUserId, tenantId)
        await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_QUICK_REPLY)
        continue
      }
      if (route === 'end_chat') {
        await endChatSession(admin, lineUserId)
        await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_END_NOTICE)
        continue
      }
      if (route === 'record_text') {
        await recordUserText(admin, lineUserId, messageId, text!)
        // Acknowledge once per session (the first message), not every message.
        if (await claimAckForSession(admin, lineUserId)) {
          await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_ACK_NOTICE, ADMIN_CHAT_END_QUICK_REPLY)
        }
        continue
      }
      if (route === 'record_image') {
        const content = await fetchLineImageContent(settings.channel_access_token, messageId)
        if (content) await recordUserImage(admin, lineUserId, messageId, content)
        if (await claimAckForSession(admin, lineUserId)) {
          await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_ACK_NOTICE, ADMIN_CHAT_END_QUICK_REPLY)
        }
        continue
      }
      // 'normal_flow' falls through to the existing DM handling below, unchanged.
    }

    if (!sourceGroupId) {
      // DM -- either (a) a bare linking code (OWNER/ADMIN via user_roles,
      // or a WORKER via workers -- this is now the PRIMARY way a worker
      // gets recognized, not dependent on crew-group membership at all),
      // or (b) a worker's crew action: a Rich Menu button tap (fixed
      // text, configured manually in LINE Official Account Manager) or
      // manually-typed trigger phrase, or the image reply to a pending
      // รูปภาพหน้างาน/งานเสร็จ prompt. Linking-code match now happens
      // ABOVE, before tenant resolution (a code IS the identification
      // for a never-before-seen sender) -- by the time execution reaches
      // here, tenantId is already resolved, so a sender who still had an
      // outstanding code would already have matched there and `continue`d.
      const { worker } = await resolveWorker(lineUserId, settings)
      if (!worker) continue // unrecognized (or inactive -- already alerted) DM sender

      // "ยกเลิก" (the chip under every menu and prompt): drop whatever the bot was waiting
      // for from this worker -- an unfinished แจ้งปัญหา, งานเสร็จ or photo step -- and say
      // so. The short reply also makes LINE remove the tappable chips. Handled before the
      // pending-action logic below, which would otherwise swallow it as stray text.
      if (msgType === 'text' && isCancel(text)) {
        const { error: cancelError } = await admin.from('line_pending_actions').delete().eq('worker_id', worker.id)
        if (cancelError) logSafeError('line_pending_actions delete failed (cancel)', cancelError)
        await sendLineReply(settings.channel_access_token, event.replyToken, CANCEL_REPLY)
        continue
      }

      const { data: pending } = await admin.from('line_pending_actions').select('*').eq('worker_id', worker.id).gt('expires_at', new Date().toISOString()).maybeSingle()
      if (pending) {
        const pendingAction = pending.action as PendingActionType
        const priorCount = (pending.photo_count as number | null) ?? 0
        // A worker can deliberately tap a different, real command (Rich
        // Menu or typed) to get OUT of a stale site_photo/job_done_pick/
        // job_done wait-state instead of sending a photo or "เสร็จแล้ว" --
        // found live: a worker stuck mid-job_done tapped "งานวันนี้"
        // repeatedly and got total silence, because those 3 branches only
        // ever recognized their own expected input and silently dropped
        // everything else (deliberate for stray chat noise, but it also
        // ate real commands with zero feedback). When the text matches a
        // real command, let it interrupt: clear the stale row and fall
        // through to the normal dispatch block below instead of `continue`.
        const interruptCommand = msgType === 'text' && text ? matchDMAction(text, commandSettingsByKey) : null
        let interrupted = false
        if (pendingAction === 'site_photo') {
          if (msgType === 'image') {
            await handleSitePhotoAdd(worker, settings, event.replyToken, messageId, pending.id, priorCount)
            // Pending row stays open -- more photos or "เสร็จแล้ว" can follow.
          } else if (msgType === 'text' && text?.trim() === 'เสร็จแล้ว') {
            const shouldClose = await handleSitePhotoFinish(settings, event.replyToken, priorCount)
            if (shouldClose) {
              const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
              if (deleteError) logSafeError('line_pending_actions delete failed', deleteError)
            }
          } else if (interruptCommand) {
            const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
            if (deleteError) logSafeError('line_pending_actions delete failed', deleteError)
            interrupted = true
          }
          // Any other stray text while accumulating photos is still silently ignored.
        } else if (pendingAction === 'job_done_pick') {
          if (msgType === 'text' && text) {
            const picked = await handleJobDonePick(worker, settings, event.replyToken, text)
            if (!picked && interruptCommand) {
              const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
              if (deleteError) logSafeError('line_pending_actions delete failed', deleteError)
              interrupted = true
            }
          } else if (msgType === 'image') {
            // Used to be silently ignored -- the photo was lost with zero
            // feedback and the worker had no way to know it never saved
            // (found live: worker assigned to multiple cards, sent the
            // photo before tapping which task, nothing landed anywhere).
            // Re-send the same picker so they can tap then resend the
            // photo, no retyping "งานเสร็จ" needed.
            const tasks = await resolveJobDoneCandidates(worker.id, settings.tenant_id)
            await sendLineReply(
              settings.channel_access_token, event.replyToken,
              '⚠️ ยังไม่ได้บันทึกรูปนี้ครับ กรุณาเลือกงานที่เสร็จก่อน แล้วค่อยส่งรูปอีกครั้ง',
              [...tasks.map((t) => ({ label: truncateLabel(t.name), text: t.name })), CANCEL_CHIP],
            )
          }
        } else if (pendingAction === 'job_done') {
          if (msgType === 'image') {
            await handleJobDonePhotoAdd(worker, pending.task_id as string, settings, event.replyToken, messageId, pending.id, priorCount)
            // Pending row stays open -- more photos or "เสร็จแล้ว" can follow.
          } else if (msgType === 'text' && text?.trim() === 'เสร็จแล้ว') {
            const shouldClose = await handleJobDonePhotoFinish(pending.task_id as string, settings, event.replyToken, priorCount)
            if (shouldClose) {
              const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
              if (deleteError) logSafeError('line_pending_actions delete failed', deleteError)
            }
          } else if (interruptCommand) {
            const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
            if (deleteError) logSafeError('line_pending_actions delete failed', deleteError)
            interrupted = true
          }
          // Any other stray text while accumulating photos is still silently ignored.
        } else if (msgType === 'text' && text) {
          const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
          if (deleteError) logSafeError('line_pending_actions delete failed', deleteError)
          const schedulePhrases = SCHEDULE_COMMAND_ORDER.flatMap((key) => resolveEffectivePhrases(key, commandSettingsByKey))
          if (isMenuButtonText(text, schedulePhrases)) {
            // A menu button, not the report: stop waiting and run the button below.
            interrupted = true
          } else {
            await handleAction(pendingAction as GroupActionType, worker, text, settings, event.replyToken)
          }
        }
        if (!interrupted) continue
        // interrupted === true: fall through to the normal dispatch block
        // below, which re-resolves the same command from `text` and
        // handles it exactly as if there had been no pending action.
      }

      if (msgType === 'text' && text) {
        const action = matchDMAction(text, commandSettingsByKey)
        if (action && !resolveEnabled(action, commandSettingsByKey, 'dm')) {
          await sendLineReply(settings.channel_access_token, event.replyToken, DISABLED_MESSAGE)
        } else if (action === 'time_clock') {
          await handleTimeClock(worker, settings, event.replyToken, commandSettingsByKey)
        } else if (action === 'schedule_menu') {
          await handleScheduleMenu(settings, event.replyToken, commandSettingsByKey)
        } else if (action === 'check_in') {
          await handleCheckInStart(worker, settings, event.replyToken)
        } else if (action === 'check_out') {
          await handleCheckOutStart(worker, settings, event.replyToken)
        } else if (action === 'job_done_start') {
          await handleJobDoneStart(worker, settings, event.replyToken)
        } else if (action === 'today_job') {
          const tomorrowPhrase = resolveEnabled('tomorrow_job', commandSettingsByKey, 'dm')
            ? (resolveEffectivePhrases('tomorrow_job', commandSettingsByKey)[0] ?? null)
            : null
          await handleTodaysJobMenu(worker, settings, event.replyToken, tomorrowPhrase)
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
          const expiresAt = new Date(Date.now() + pendingWaitMinutes(action) * 60 * 1000).toISOString()
          const { error } = await admin.from('line_pending_actions').upsert(
            { tenant_id: settings.tenant_id, worker_id: worker.id, action, expires_at: expiresAt, photo_count: 0 },
            { onConflict: 'worker_id' }
          )
          if (error) logSafeError('line_pending_actions upsert failed', error)
          await sendLineReply(settings.channel_access_token, event.replyToken, promptForAction(action as GroupActionType | 'site_photo'), [CANCEL_CHIP])
        }
        // No match and no pending action -- unrecognized DM text from a
        // linked worker, silently ignored.
      } else if (msgType === 'image') {
        // A photo sent straight to the bot, with no รูปภาพหน้างาน/งานเสร็จ step open
        // (those are handled above and `continue` before reaching here): file it to
        // the worker's site for today, or the company's default site, exactly like a
        // photo dropped in the crew group -- no trigger phrase needed. Reached only
        // for a linked worker in the normal (secure_bot) mode: a photo sent during a
        // "chat with admin" session is recorded for the admin by the privacy block
        // above and never gets here.
        const batchCount = imageEventsPerSender.get(lineUserId) ?? 1
        const seenSoFar = (imageEventsSeenPerSender.get(lineUserId) ?? 0) + 1
        imageEventsSeenPerSender.set(lineUserId, seenSoFar)
        await handleGroupPhotoAutoFile(worker, settings, event.replyToken, messageId, seenSoFar === batchCount, batchCount, true)
      }
      continue
    }

    // A message from the crew group -- by this point tenantId was already
    // resolved from THIS group matching that tenant's crew_group_id (see
    // above), so there's nothing further to check there.

    // Group-photo auto-filing (see handleGroupPhotoAutoFile) -- the one
    // exception to "group handling is text-only" below. Only a known,
    // linked worker's image auto-files; resolveWorker returns null for
    // an admin/owner (they live in user_roles, not workers) or a
    // genuine stranger, so their photos are silently ignored here --
    // same scoping as every other worker-only crew action.
    if (msgType === 'image') {
      const { worker } = await resolveWorker(lineUserId, settings)
      if (worker) {
        const batchCount = imageEventsPerSender.get(lineUserId) ?? 1
        const seenSoFar = (imageEventsSeenPerSender.get(lineUserId) ?? 0) + 1
        imageEventsSeenPerSender.set(lineUserId, seenSoFar)
        await handleGroupPhotoAutoFile(worker, settings, event.replyToken, messageId, seenSoFar === batchCount, batchCount)
      }
      continue
    }

    // Everything else acted on here is text-only (checkin/job-done/
    // today's-work menu are 1:1-DM-only, matching the Rich Menu's own
    // DM-only scope).
    if (msgType !== 'text' || !text) continue

    // Read-only team-wide status queries (งานวันนี้/งานวันพรุ่งนี้/
    // งานอาทิตย์นี้/งานอาทิตย์หน้า) work for anyone in the real crew group,
    // no linked-worker check needed -- unlike the 3 write actions below,
    // these can't create or change anything.
    const infoAction = matchGroupInfoAction(text, commandSettingsByKey)
    if (infoAction) {
      if (!resolveEnabled(infoAction, commandSettingsByKey, 'group')) {
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
        if (unlinkedError) logSafeError('line_unlinked_senders upsert failed', unlinkedError)
      }
      continue
    }

    const action = matchGroupAction(text)
    if (action) {
      if (!resolveEnabled(action, commandSettingsByKey, 'group')) {
        await sendLineReply(settings.channel_access_token, event.replyToken, DISABLED_MESSAGE)
      } else {
        await handleAction(action, worker, text, settings, event.replyToken)
      }
    }
  }

  return json({ ok: true })
})
