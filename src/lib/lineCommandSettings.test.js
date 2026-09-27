import { describe, it, expect } from 'vitest'
import {
  phrasesCollide,
  resolveEffectivePhrase,
  resolveEnabled,
  validateCustomPhrase,
  SCHEDULE_COMMAND_DEFAULTS,
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
})
