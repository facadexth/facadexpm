// src/lib/lineCommandSettings.js
// Pure logic for the OWNER-configurable LINE bot commands
// (line_command_settings table) -- shared source of truth for
// CommunicationCenter.jsx's admin UI and line-webhook/index.ts's
// matching (the webhook is a Deno Edge Function and can't import this
// file directly, so its copy is ported in by hand, same pattern as
// formatDailyAssignmentsPushMessage/line-push-daily-assignments).
//
// Originally scoped to only the 4 read-only schedule commands (see
// git history for that narrower version) -- widened on 2026-09-28 per
// explicit user ask ("ทำให้มีเปิด-ปิดทุก feature เลยได้ไหม") to cover
// enable/disable for all 11 commands. Renaming (custom_phrase) stays
// scoped to the 4 schedule commands only -- the other 7's phrases are
// deeply tied to matchGroupAction/matchDMAction's hardcoded keyword
// logic (negation handling for แจ้งปัญหา, etc), not a simple swap.

export const SCHEDULE_COMMAND_KEYS = ['today_job', 'tomorrow_job', 'this_week_job', 'next_week_job']

export const SCHEDULE_COMMAND_DEFAULTS = {
  today_job: 'งานวันนี้',
  tomorrow_job: 'งานวันพรุ่งนี้',
  this_week_job: 'งานอาทิตย์นี้',
  next_week_job: 'งานอาทิตย์หน้า',
}

export const SCHEDULE_COMMAND_LABELS = {
  today_job: 'งานวันนี้',
  tomorrow_job: 'งานวันพรุ่งนี้',
  this_week_job: 'งานอาทิตย์นี้',
  next_week_job: 'งานอาทิตย์หน้า',
}

// The 7 write-action commands -- enable/disable only, phrases fixed in
// code (matchGroupAction/matchDMAction), shown here read-only so the
// UI/RESERVED_PHRASES have one source of truth instead of duplicating
// the literal keyword arrays in a second place.
export const FIXED_COMMAND_KEYS = ['issue_report', 'material_request', 'leave', 'check_in', 'check_out', 'site_photo', 'job_done_start']

export const FIXED_COMMAND_PHRASES = {
  issue_report: ['ปัญหา'],
  material_request: ['อยากเบิก', 'ขอเบิก', 'เบิกของ'],
  leave: ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'],
  check_in: ['เช็คอิน'],
  check_out: ['เช็คเอาท์'],
  site_photo: ['รูปภาพ'],
  job_done_start: ['งานเสร็จ', 'เสร็จงาน'],
}

export const FIXED_COMMAND_LABELS = {
  issue_report: 'แจ้งปัญหา',
  material_request: 'เบิกของ',
  leave: 'ขอลา',
  check_in: 'เช็คอิน',
  check_out: 'เช็คเอาท์',
  site_photo: 'รูปภาพหน้างาน',
  job_done_start: 'งานเสร็จ',
}

export const ALL_COMMAND_KEYS = [...SCHEDULE_COMMAND_KEYS, ...FIXED_COMMAND_KEYS]

// Every phrase (or phrase-fragment) matched elsewhere in line-webhook's
// matchGroupAction/matchDMAction -- a custom schedule phrase must not
// collide with any of these (substring either direction) or it could
// silently steal or break one of the other commands. The 3 extras
// aren't *trigger* phrases themselves: "ไม่มีปัญหา"/"ไม่ปัญหา" are the
// negation แจ้งปัญหา's own matcher excludes, and "เสร็จแล้ว" is the
// universal "done" quick-reply confirmation used across multiple
// two-step flows (site photos, งานเสร็จ) -- just as reserved.
export const RESERVED_PHRASES = [
  ...Object.values(FIXED_COMMAND_PHRASES).flat(),
  'ไม่มีปัญหา', 'ไม่ปัญหา', 'เสร็จแล้ว',
]

export function phrasesCollide(a, b) {
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

// Splits a raw custom_phrase DB value (comma-separated, e.g.
// "งานวันนี้,ดูงานวันนี้") into a trimmed, non-empty phrase list.
export function splitPhrases(raw) {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean)
}

// settingsByKey: { [command_key]: { enabled, custom_phrase } | undefined }
// A missing entry means "enabled, default phrase" (see migration comment).
// Returns the full list of phrases that trigger this schedule command --
// the custom list if set, otherwise just the single default.
export function resolveEffectivePhrases(commandKey, settingsByKey) {
  const row = settingsByKey?.[commandKey]
  const custom = splitPhrases(row?.custom_phrase)
  return custom.length ? custom : [SCHEDULE_COMMAND_DEFAULTS[commandKey]]
}

// Single-phrase convenience for display (first configured phrase, or
// the default) -- used where showing every synonym would be noisy.
export function resolveEffectivePhrase(commandKey, settingsByKey) {
  return resolveEffectivePhrases(commandKey, settingsByKey)[0]
}

// context: 'dm' | 'group' -- each command is independently toggleable per
// chat context (2026-09-29: "ทุก command ไลน์ ขอให้ทำ toggle เปิด-ปิด
// สำหรับ pm/กลุ่มไลน์"). A missing row still means "enabled" in both
// contexts, matching the original single-flag fallback.
export function resolveEnabled(commandKey, settingsByKey, context) {
  const row = settingsByKey?.[commandKey]
  const field = context === 'group' ? 'enabled_group' : 'enabled_dm'
  return row ? row[field] !== false : true
}

// Checks a candidate custom-phrase INPUT (raw, possibly comma-separated
// multiple phrases) for commandKey against every reserved phrase AND
// every OTHER schedule command's current effective phrases (never
// against itself, so re-saving the same phrase is fine). Returns
// { valid: true } or { valid: false, reason: string }.
export function validateCustomPhrase(candidateInput, commandKey, settingsByKey) {
  const candidates = splitPhrases(candidateInput)
  if (candidates.length === 0) return { valid: true } // blank = fall back to default, always fine

  for (const trimmed of candidates) {
    for (const reserved of RESERVED_PHRASES) {
      if (phrasesCollide(trimmed, reserved)) {
        return { valid: false, reason: `"${trimmed}" ชนกับคำสั่งเดิมในระบบ ("${reserved}") -- กรุณาใช้คำอื่น` }
      }
    }

    for (const otherKey of SCHEDULE_COMMAND_KEYS) {
      if (otherKey === commandKey) continue
      for (const otherPhrase of resolveEffectivePhrases(otherKey, settingsByKey)) {
        if (phrasesCollide(trimmed, otherPhrase)) {
          return { valid: false, reason: `"${trimmed}" ชนกับคำสั่ง "${SCHEDULE_COMMAND_LABELS[otherKey]}" ("${otherPhrase}") -- กรุณาใช้คำอื่น` }
        }
      }
    }
  }

  return { valid: true }
}
