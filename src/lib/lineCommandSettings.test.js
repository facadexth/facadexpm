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
  it('falls back to the default phrase and enabled=true when no row exists', () => {
    expect(resolveEffectivePhrase('today_job', {})).toBe(SCHEDULE_COMMAND_DEFAULTS.today_job)
    expect(resolveEnabled('today_job', {})).toBe(true)
  })
  it('uses the custom phrase when one is set', () => {
    const settings = { today_job: { enabled: true, custom_phrase: 'สรุปงานวันนี้' } }
    expect(resolveEffectivePhrase('today_job', settings)).toBe('สรุปงานวันนี้')
  })
  it('falls back to default when custom_phrase is null even if a row exists', () => {
    const settings = { today_job: { enabled: false, custom_phrase: null } }
    expect(resolveEffectivePhrase('today_job', settings)).toBe(SCHEDULE_COMMAND_DEFAULTS.today_job)
  })
  it('respects an explicit enabled=false row', () => {
    const settings = { today_job: { enabled: false, custom_phrase: null } }
    expect(resolveEnabled('today_job', settings)).toBe(false)
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
  it('ALL_COMMAND_KEYS is exactly the 4 schedule + 7 fixed keys, 11 total', () => {
    expect(ALL_COMMAND_KEYS).toHaveLength(11)
    expect(ALL_COMMAND_KEYS).toEqual([...SCHEDULE_COMMAND_KEYS, ...FIXED_COMMAND_KEYS])
  })
  it('resolveEnabled generalizes to fixed (non-schedule) command keys', () => {
    expect(resolveEnabled('material_request', {})).toBe(true)
    expect(resolveEnabled('material_request', { material_request: { enabled: false } })).toBe(false)
  })
  it('RESERVED_PHRASES is derived from the fixed commands, not hand-duplicated', () => {
    expect(RESERVED_PHRASES).toEqual(expect.arrayContaining(['เบิกของ', 'ขอลา', 'เช็คอิน', 'เช็คเอาท์', 'รูปภาพ', 'งานเสร็จ']))
  })
})
