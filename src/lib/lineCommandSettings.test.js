import { describe, it, expect } from 'vitest'
import {
  phrasesCollide,
  resolveEffectivePhrase,
  resolveEffectivePhrases,
  resolveEnabled,
  validateCustomPhrase,
  splitPhrases,
  SCHEDULE_COMMAND_DEFAULTS,
  SCHEDULE_COMMAND_KEYS,
  FIXED_COMMAND_KEYS,
  ALL_COMMAND_KEYS,
  RESERVED_PHRASES,
  ADVANCE_COMMAND_KEYS,
  ADVANCE_COMMAND_DEFAULTS,
  RENAMABLE_COMMAND_KEYS,
  FIXED_COMMAND_PHRASES,
} from './lineCommandSettings.js'

describe('phrasesCollide', () => {
  it('detects a substring collision in either direction', () => {
    expect(phrasesCollide('งานวันนี้', 'งานวันนี้ครับ')).toBe(true)
    expect(phrasesCollide('งานวันนี้ครับ', 'งานวันนี้')).toBe(true)
  })
  it('returns false for unrelated phrases', () => {
    expect(phrasesCollide('งานวันนี้', 'เบิกของ')).toBe(false)
  })
  it('returns false for empty input', () => {
    expect(phrasesCollide('', 'เบิกของ')).toBe(false)
    expect(phrasesCollide('เบิกของ', '')).toBe(false)
  })
})

describe('resolveEffectivePhrase / resolveEnabled', () => {
  it('falls back to the default phrase and enabled=true (both contexts) when no row exists', () => {
    expect(resolveEffectivePhrase('today_job', {})).toBe(SCHEDULE_COMMAND_DEFAULTS.today_job)
    expect(resolveEnabled('today_job', {}, 'dm')).toBe(true)
    expect(resolveEnabled('today_job', {}, 'group')).toBe(true)
  })
  it('uses the custom phrase when one is set', () => {
    const settings = { today_job: { enabled_dm: true, enabled_group: true, custom_phrase: 'สรุปงานวันนี้' } }
    expect(resolveEffectivePhrase('today_job', settings)).toBe('สรุปงานวันนี้')
  })
  it('falls back to default when custom_phrase is null even if a row exists', () => {
    const settings = { today_job: { enabled_dm: false, enabled_group: false, custom_phrase: null } }
    expect(resolveEffectivePhrase('today_job', settings)).toBe(SCHEDULE_COMMAND_DEFAULTS.today_job)
  })
  it('respects each context independently', () => {
    const settings = { today_job: { enabled_dm: true, enabled_group: false, custom_phrase: null } }
    expect(resolveEnabled('today_job', settings, 'dm')).toBe(true)
    expect(resolveEnabled('today_job', settings, 'group')).toBe(false)
  })
})

describe('validateCustomPhrase', () => {
  it('accepts a blank phrase (means: use default)', () => {
    expect(validateCustomPhrase('', 'today_job', {})).toEqual({ valid: true })
  })
  it('rejects a phrase colliding with a reserved write-action phrase', () => {
    const result = validateCustomPhrase('ขอเบิกของหน่อย', 'today_job', {})
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/ขอเบิก/)
  })
  it('rejects a phrase colliding with the universal "เสร็จแล้ว" confirmation word', () => {
    const result = validateCustomPhrase('เสร็จแล้วครับ', 'today_job', {})
    expect(result.valid).toBe(false)
  })
  it('rejects a phrase colliding with another schedule command\'s effective phrase', () => {
    const settings = { tomorrow_job: { enabled: true, custom_phrase: 'พรุ่งนี้มีงานอะไร' } }
    const result = validateCustomPhrase('พรุ่งนี้มีงานอะไรบ้าง', 'today_job', settings)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/งานวันพรุ่งนี้/)
  })
  it('allows re-saving the same phrase already assigned to this command', () => {
    const settings = { today_job: { enabled: true, custom_phrase: 'เช็คงานวันนี้' } }
    const result = validateCustomPhrase('เช็คงานวันนี้', 'today_job', settings)
    expect(result.valid).toBe(true)
  })
  it('accepts a genuinely non-colliding new phrase', () => {
    const result = validateCustomPhrase('เช็คตารางวันนี้', 'today_job', {})
    expect(result.valid).toBe(true)
  })
  it('validates every phrase in a comma-separated multi-phrase input', () => {
    const result = validateCustomPhrase('เช็คงานวันนี้,ขอเบิกของ', 'today_job', {})
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/ขอเบิก/)
  })
  it('accepts a multi-phrase input where every phrase is clean', () => {
    const result = validateCustomPhrase('เช็คงานวันนี้, ดูงานวันนี้ ,งานวันนี้จ้า', 'today_job', {})
    expect(result.valid).toBe(true)
  })
})

describe('splitPhrases', () => {
  it('splits, trims, and drops empty fragments', () => {
    expect(splitPhrases('a, b ,,c')).toEqual(['a', 'b', 'c'])
  })
  it('returns an empty array for blank input', () => {
    expect(splitPhrases('')).toEqual([])
    expect(splitPhrases(null)).toEqual([])
  })
})

describe('resolveEffectivePhrases', () => {
  it('returns the default as a single-item array when no custom phrase is set', () => {
    expect(resolveEffectivePhrases('today_job', {})).toEqual([SCHEDULE_COMMAND_DEFAULTS.today_job])
  })
  it('returns every comma-separated custom phrase', () => {
    const settings = { today_job: { enabled: true, custom_phrase: 'สรุปงานวันนี้,เช็คงานวันนี้' } }
    expect(resolveEffectivePhrases('today_job', settings)).toEqual(['สรุปงานวันนี้', 'เช็คงานวันนี้'])
  })
  it('resolveEffectivePhrase returns the first of the multi-phrase list', () => {
    const settings = { today_job: { enabled: true, custom_phrase: 'สรุปงานวันนี้,เช็คงานวันนี้' } }
    expect(resolveEffectivePhrase('today_job', settings)).toBe('สรุปงานวันนี้')
  })
})

describe('command key coverage', () => {
  it('ALL_COMMAND_KEYS is exactly the 4 schedule + 7 fixed + 4 advance keys, 15 total', () => {
    expect(ALL_COMMAND_KEYS).toHaveLength(15)
    expect(ALL_COMMAND_KEYS).toEqual([...SCHEDULE_COMMAND_KEYS, ...FIXED_COMMAND_KEYS, ...ADVANCE_COMMAND_KEYS])
  })
  it('resolveEnabled generalizes to fixed (non-schedule) command keys, per context', () => {
    expect(resolveEnabled('material_request', {}, 'dm')).toBe(true)
    expect(resolveEnabled('material_request', { material_request: { enabled_dm: true, enabled_group: false } }, 'group')).toBe(false)
    expect(resolveEnabled('material_request', { material_request: { enabled_dm: true, enabled_group: false } }, 'dm')).toBe(true)
  })
  it('RESERVED_PHRASES is derived from the fixed commands, not hand-duplicated', () => {
    expect(RESERVED_PHRASES).toEqual(expect.arrayContaining(['เบิกของ', 'ขอลา', 'เช็คอิน', 'เช็คเอาท์', 'รูปภาพ', 'งานเสร็จ']))
  })
})

describe('salary advance + request menu commands (DM only, renamable)', () => {
  it('has the 4 keys the DB CHECK allows, with their default phrases', () => {
    expect(ADVANCE_COMMAND_KEYS).toEqual(['advance_request', 'advance_status', 'request_menu', 'request_status'])
    expect(ADVANCE_COMMAND_DEFAULTS).toEqual({ advance_request: 'เบิกเงิน', advance_status: 'ยอดเบิก', request_menu: 'ยื่นคำขอ', request_status: 'สถานะคำขอ' })
    expect(RENAMABLE_COMMAND_KEYS).toEqual([...SCHEDULE_COMMAND_KEYS, ...ADVANCE_COMMAND_KEYS])
  })
  it('falls back to the default phrase, or uses the custom list', () => {
    expect(resolveEffectivePhrases('advance_request', {})).toEqual(['เบิกเงิน'])
    expect(resolveEffectivePhrases('request_status', { request_status: { custom_phrase: 'เช็คคำขอ, ดูคำขอ' } })).toEqual(['เช็คคำขอ', 'ดูคำขอ'])
  })
  it('missing row = enabled in DM', () => {
    for (const k of ADVANCE_COMMAND_KEYS) expect(resolveEnabled(k, {}, 'dm')).toBe(true)
  })
  it('the default phrases are valid and do not collide with any reserved phrase', () => {
    for (const k of ADVANCE_COMMAND_KEYS) {
      expect(validateCustomPhrase(ADVANCE_COMMAND_DEFAULTS[k], k, {})).toEqual({ valid: true })
      for (const r of RESERVED_PHRASES) expect(phrasesCollide(ADVANCE_COMMAND_DEFAULTS[k], r)).toBe(false)
    }
  })
  it('phrasesCollide flags a custom advance phrase that collides with material-request phrases', () => {
    for (const bad of ['ขอเบิก', 'เบิก', 'เบิกของเงิน', 'อยากเบิกเงิน', 'ขอเบิกเงิน']) {
      expect(FIXED_COMMAND_PHRASES.material_request.some(m => phrasesCollide(bad, m))).toBe(true)
      const r = validateCustomPhrase(bad, 'advance_request', {})
      expect(r.valid).toBe(false)
    }
  })
  it('rejects an advance phrase that collides with another advance or schedule command', () => {
    expect(validateCustomPhrase('ยอดเบิกเงิน', 'advance_request', {}).valid).toBe(false) // contains ยอดเบิก
    expect(validateCustomPhrase('ดูสถานะคำขอ', 'request_menu', {}).valid).toBe(false) // contains สถานะคำขอ
    expect(validateCustomPhrase('งานวันนี้เงิน', 'advance_status', {}).valid).toBe(false)
  })
  it('rejects a schedule phrase that collides with an advance phrase', () => {
    const r = validateCustomPhrase('ยอดเบิกวันนี้', 'today_job', {})
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/ยอดเบิก/)
  })
  it('accepts a clean renamed advance phrase and re-saving its own phrase', () => {
    expect(validateCustomPhrase('ขอเงินล่วงหน้า', 'advance_request', {})).toEqual({ valid: true })
    expect(validateCustomPhrase('เบิกเงิน', 'advance_request', { advance_request: { custom_phrase: 'เบิกเงิน' } })).toEqual({ valid: true })
  })
})
