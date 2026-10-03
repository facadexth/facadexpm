import { describe, it, expect } from 'vitest'
import { normalizeAppUrl, DEFAULT_APP_URL, APP_URL } from '../../supabase/functions/_shared/app-url.ts'

describe('normalizeAppUrl', () => {
  it('falls back to the current production URL when nothing is configured', () => {
    expect(DEFAULT_APP_URL).toBe('https://changpm.app')
    expect(normalizeAppUrl(undefined)).toBe(DEFAULT_APP_URL)
    expect(normalizeAppUrl('')).toBe(DEFAULT_APP_URL)
    expect(normalizeAppUrl('   ')).toBe(DEFAULT_APP_URL)
  })
  it('accepts an https URL and strips trailing slashes and whitespace', () => {
    expect(normalizeAppUrl('https://changpm.app')).toBe('https://changpm.app')
    expect(normalizeAppUrl(' https://changpm.app/ ')).toBe('https://changpm.app')
    expect(normalizeAppUrl('https://changpm.app///')).toBe('https://changpm.app')
  })
  it('rejects anything that is not a plain https origin, so a typo never produces broken links', () => {
    for (const bad of ['http://changpm.app', 'changpm.app', 'ftp://changpm.app', 'https://', 'javascript:alert(1)', 'https://changpm.app/app']) {
      expect(normalizeAppUrl(bad)).toBe(DEFAULT_APP_URL)
    }
  })
  it('exports a ready-to-use APP_URL (the default when no APP_URL secret is set, as in tests)', () => {
    expect(APP_URL).toBe(DEFAULT_APP_URL)
  })
})
