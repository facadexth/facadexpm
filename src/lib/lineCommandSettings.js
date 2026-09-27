// src/lib/lineCommandSettings.js
// Pure logic for the OWNER-configurable schedule-query commands
// (line_command_settings table) -- shared source of truth for
// CommunicationCenter.jsx's admin UI and line-webhook/index.ts's
// matching (the webhook is a Deno Edge Function and can't import this
// file directly, so its copy is ported in by hand, same pattern as
// formatDailyAssignmentsPushMessage/line-push-daily-assignments).
//
// Deliberately scoped to only the 4 read-only schedule commands, not a
// generic engine -- the 7 write-action commands (แจ้งปัญหา/เบิกของ/
// ขอลา/เช็คอิน/เช็คเอาท์/รูปภาพ/งานเสร็จ) are untouched by design.

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

// Every phrase (or phrase-fragment) matched elsewhere in line-webhook's
// matchGroupAction/matchDMAction -- a custom schedule phrase must not
// collide with any of these (substring either direction) or it could
// silently steal or break one of the other commands. "เสร็จแล้ว" is
// included even though it isn't a *trigger* phrase -- it's the
// universal "done" quick-reply confirmation used across multiple
// two-step flows (site photos, งานเสร็จ), so it's just as reserved.
export const RESERVED_PHRASES = [
  'ปัญหา', 'ไม่มีปัญหา', 'ไม่ปัญหา',
  'อยากเบิก', 'ขอเบิก', 'เบิกของ',
  'ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา',
  'เช็คอิน', 'เช็คเอาท์',
  'รูปภาพ',
  'งานเสร็จ', 'เสร็จงาน', 'เสร็จแล้ว',
]

export function phrasesCollide(a, b) {
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

// settingsByKey: { [command_key]: { enabled, custom_phrase } | undefined }
// A missing entry means "enabled, default phrase" (see migration comment).
export function resolveEffectivePhrase(commandKey, settingsByKey) {
  const row = settingsByKey?.[commandKey]
  return row?.custom_phrase || SCHEDULE_COMMAND_DEFAULTS[commandKey]
}

export function resolveEnabled(commandKey, settingsByKey) {
  const row = settingsByKey?.[commandKey]
  return row ? row.enabled !== false : true
}

// Checks a candidate custom phrase for commandKey against every
// reserved phrase AND every OTHER schedule command's current effective
// phrase (never against itself, so re-saving the same phrase is fine).
// Returns { valid: true } or { valid: false, reason: string }.
export function validateCustomPhrase(candidatePhrase, commandKey, settingsByKey) {
  const trimmed = (candidatePhrase || '').trim()
  if (!trimmed) return { valid: true } // blank = fall back to default, always fine

  for (const reserved of RESERVED_PHRASES) {
    if (phrasesCollide(trimmed, reserved)) {
      return { valid: false, reason: `ชนกับคำสั่งเดิมในระบบ ("${reserved}") -- กรุณาใช้คำอื่น` }
    }
  }

  for (const otherKey of SCHEDULE_COMMAND_KEYS) {
    if (otherKey === commandKey) continue
    const otherPhrase = resolveEffectivePhrase(otherKey, settingsByKey)
    if (phrasesCollide(trimmed, otherPhrase)) {
      return { valid: false, reason: `ชนกับคำสั่ง "${SCHEDULE_COMMAND_LABELS[otherKey]}" ("${otherPhrase}") -- กรุณาใช้คำอื่น` }
    }
  }

  return { valid: true }
}
