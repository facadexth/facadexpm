// _shared/line-command-match.ts -- which crew command a LINE text means.
//
// Moved out of line-webhook/index.ts (2026-10-18) so vitest can test the routing
// (src/lib/lineCommandMatch.test.js). Pure: no Deno / jsr / npm imports. The
// webhook's behaviour for every phrase that existed before is unchanged; the one
// addition is the salary-advance family (เบิกเงิน / ยอดเบิก / ยื่นคำขอ / สถานะคำขอ),
// which the DM matcher checks BEFORE the material-request match, because
// "ขอเบิก" (material request) is a substring of "ขอเบิกเงิน" (money).
//
// Hand-ported copy of the matching half of src/lib/lineCommandSettings.js (Deno
// cannot import Vite-bundled files). Collision safety between phrases is enforced
// at SAVE time in the app (validateCustomPhrase), not here.
import { TIME_CLOCK_PHRASE, SCHEDULE_MENU_PHRASE } from './schedule-menu.ts'
import { ADVANCE_PHRASES, matchAdvanceAction } from './advance-logic.ts'
import { CANCEL_CHIP } from './cancel.ts'

export type GroupActionType = 'issue_report' | 'material_request' | 'leave'
export type AdvanceActionType = 'advance_request' | 'advance_status' | 'request_menu' | 'request_status' | 'payslip_request'
export type DMOnlyActionType =
  | 'check_in' | 'check_out' | 'site_photo' | 'job_done_start' | 'today_job' | 'tomorrow_job'
  | 'this_week_job' | 'next_week_job' | 'time_clock' | 'schedule_menu' | AdvanceActionType
export type ActionType = GroupActionType | DMOnlyActionType
export type GroupInfoAction = 'today_job' | 'tomorrow_job' | 'this_week_job' | 'next_week_job'

export const SCHEDULE_COMMAND_DEFAULTS: Record<string, string> = {
  today_job: 'งานวันนี้',
  tomorrow_job: 'งานวันพรุ่งนี้',
  this_week_job: 'งานอาทิตย์นี้',
  next_week_job: 'งานอาทิตย์หน้า',
}
export const SCHEDULE_COMMAND_ORDER = ['tomorrow_job', 'this_week_job', 'next_week_job', 'today_job'] as const

// DM-only, renamable, on/off per DM. Never run in a group (see groupAdvanceHint).
export const ADVANCE_COMMAND_KEYS: AdvanceActionType[] = ['advance_request', 'advance_status', 'request_menu', 'request_status', 'payslip_request']

export type CommandSettingsRow = { command_key: string; enabled_dm: boolean; enabled_group: boolean; custom_phrase: string | null }
export type CommandSettingsByKey = Record<string, CommandSettingsRow>

export function splitPhrases(raw: string | null | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}

// The custom list if the owner set one, otherwise the default (schedule or advance).
export function resolveEffectivePhrases(commandKey: string, settingsByKey: CommandSettingsByKey): string[] {
  const row = settingsByKey?.[commandKey]
  const custom = splitPhrases(row?.custom_phrase)
  if (custom.length) return custom
  if (SCHEDULE_COMMAND_DEFAULTS[commandKey]) return [SCHEDULE_COMMAND_DEFAULTS[commandKey]]
  return [...(ADVANCE_PHRASES[commandKey] ?? [])]
}

// context: 'dm' | 'group' -- a missing row means enabled in both.
export function resolveEnabled(commandKey: string, settingsByKey: CommandSettingsByKey, context: 'dm' | 'group'): boolean {
  const row = settingsByKey?.[commandKey]
  const field = context === 'group' ? 'enabled_group' : 'enabled_dm'
  return row ? row[field] !== false : true
}

// { advance_request: [...], ... } with the company's phrases, for matchAdvanceAction.
export function advancePhrasesFromSettings(settingsByKey: CommandSettingsByKey): Record<string, string[]> {
  return Object.fromEntries(ADVANCE_COMMAND_KEYS.map((k) => [k, resolveEffectivePhrases(k, settingsByKey)]))
}

// Simple substring match, tuned against real collisions found in review: a bare
// "ปัญหา" also matches "ไม่มีปัญหา"/"ไม่ปัญหา" ("no problem"), and a bare "ลา"
// matches ordinary words like ตลาด/ปลา/ฉลาด. Used by the crew GROUP path.
export function isIssueReportText(text: string): boolean {
  return text.includes('ปัญหา') && !text.includes('ไม่มีปัญหา') && !text.includes('ไม่ปัญหา')
}

export function matchGroupAction(text: string): GroupActionType | null {
  if (isIssueReportText(text)) return 'issue_report'
  const isMaterialRequest = ['อยากเบิก', 'ขอเบิก', 'เบิกของ'].some((kw) => text.includes(kw))
  if (isMaterialRequest) return 'material_request'
  const isLeaveRequest = ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'].some((kw) => text.includes(kw))
  if (isLeaveRequest) return 'leave'
  return null
}

// The 1:1 DM path -- every command. Matches regardless of enabled state; the caller
// does the enabled check and the "feature disabled" reply.
export function matchDMAction(text: string, commandSettings: CommandSettingsByKey): ActionType | null {
  // The two Rich Menu buttons that need a decision first. Checked before everything
  // else: the combined phrase contains both เช็คอิน and เช็คเอาท์ and would otherwise
  // be read as a plain check-in.
  if (text.includes(TIME_CLOCK_PHRASE)) return 'time_clock'
  if (text.includes(SCHEDULE_MENU_PHRASE)) return 'schedule_menu'
  // A problem report wins first ("แจ้งปัญหา เบิกเงินไม่ได้" is a report), exactly as
  // matchGroupAction would decide it. Then money before material: "ขอเบิกเงิน"
  // contains the material keyword "ขอเบิก". matchAdvanceAction always keeps the
  // built-in เบิกเงิน / ยอดเบิก on top of any rename (money guard).
  if (isIssueReportText(text)) return 'issue_report'
  const advance = matchAdvanceAction(text, advancePhrasesFromSettings(commandSettings)) as AdvanceActionType | null
  if (advance) return advance
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

export function matchGroupInfoAction(text: string, commandSettings: CommandSettingsByKey): GroupInfoAction | null {
  for (const key of SCHEDULE_COMMAND_ORDER) {
    if (resolveEffectivePhrases(key, commandSettings).some((p) => text.includes(p))) return key as GroupInfoAction
  }
  return null
}

// ---- Salary advance replies -------------------------------------------------

export const ADVANCE_NOT_ALLOWED_MESSAGE = 'ยังขอเบิกเงินผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ'
export const ADVANCE_DM_ONLY_MESSAGE = 'ขอเบิกเงินทางแชตส่วนตัวกับบอทนะครับ'
export const REQUEST_MENU_PROMPT = 'เลือกคำขอที่ต้องการครับ'
export const advanceLinkMessage = (link: string) => `💸 กดลิงก์นี้เพื่อกรอกขอเบิกเงินครับ (ใช้ได้ 30 นาที)\n${link}`

// In a group the money commands never run (money is private). Returns what the
// group path does with this text BEFORE matchGroupAction:
//   'hint'   -- reply ADVANCE_DM_ONLY_MESSAGE once and stop (เบิกเงิน / ยอดเบิก in a
//               short message), so "ขอเบิกเงิน" can never open a material form in a group;
//   'ignore' -- stop silently: ยื่นคำขอ / สถานะคำขอ (personal DM menus), or a longer
//               message that merely mentions เบิกเงิน (ordinary chatter);
//   null     -- not an advance phrase (or a problem report), carry on as before.
export const GROUP_HINT_MAX_CHARS = 30
export function groupAdvanceHint(text: string, commandSettings: CommandSettingsByKey): 'hint' | 'ignore' | null {
  if (isIssueReportText(text)) return null // matchGroupAction files it as a problem report
  const a = matchAdvanceAction(text, advancePhrasesFromSettings(commandSettings))
  if (a === 'advance_request' || a === 'advance_status') return text.trim().length <= GROUP_HINT_MAX_CHARS ? 'hint' : 'ignore'
  if (a === 'request_menu' || a === 'request_status') return 'ignore'
  return null
}

// Quick-reply chips for "ยื่นคำขอ". Each chip sends the phrase the bot already
// listens for, so a tap runs the same flow as typing it. A command the company
// turned off in DM, or เบิกเงิน without the payroll module, is left out. Returns []
// when nothing is left (the caller then sends the disabled reply).
export function requestMenuChips(o: {
  leaveOn: boolean
  materialOn: boolean
  advanceOn: boolean
  advancePhrase?: string | null
  payslipOn?: boolean
  payslipPhrase?: string | null
}): Array<{ label: string; text: string }> {
  const chips: Array<{ label: string; text: string }> = []
  if (o.leaveOn) chips.push({ label: '🏖️ ขอลา', text: 'ขอลา' })
  if (o.materialOn) chips.push({ label: '📦 เบิกของ', text: 'ขอเบิกของ' })
  if (o.advanceOn && o.advancePhrase) chips.push({ label: '💸 เบิกเงิน', text: o.advancePhrase })
  if (o.payslipOn && o.payslipPhrase) chips.push({ label: '🧾 ขอสลิปเงินเดือน', text: o.payslipPhrase === 'ขอสลิป' ? 'ขอสลิปเงินเดือน' : o.payslipPhrase })
  if (!chips.length) return []
  return [...chips, CANCEL_CHIP]
}

// Thai-style number for the status replies: 12,500 / 1,250.5
export const formatBaht = (n: number) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })

// Which advances the LINE status reply lists. Open ones (รออนุมัติ / อนุมัติแล้ว) always;
// closed ones (ไม่อนุมัติ / ผ่อนครบแล้ว) only if requested in the last `recentDays`, so a
// long history does not flood the chat. At most `maxItems` lines, in the order given
// (the caller passes newest first). `outstanding` / `pendingOther` stay computed over
// every advance.
export function advanceItemsForReply<S extends { items: Array<{ id: string; status: string }> }>(
  summary: S,
  requestedAtById: Record<string, string | null | undefined>,
  now = Date.now(),
  maxItems = 15,
  recentDays = 90,
): S {
  const cutoff = now - recentDays * 24 * 3600 * 1000
  const items = summary.items.filter((it) => {
    if (it.status === 'pending' || it.status === 'approved') return true
    const at = requestedAtById[it.id]
    return !!at && new Date(at).getTime() >= cutoff
  })
  return { ...summary, items: items.slice(0, maxItems) }
}
