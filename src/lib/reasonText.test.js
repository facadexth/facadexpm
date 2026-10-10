import { describe, it, expect } from 'vitest'
import { reasonText, unresolvedText } from './reasonText.js'

describe('reasonText for the part-model expander issues', () => {
  it('gives Thai text (not the raw code) for every expander reason', () => {
    for (const code of ['no_butt_distance', 'no_butt_target', 'no_profile_family', 'corner_violation', 'no_model']) {
      const t = reasonText(code)
      expect(t).not.toBe(code)
      expect(t).toMatch(/[฀-๿]/)
      expect(unresolvedText({ name: 'x', reason: code, source: 'joint' })).toBe(t)
    }
  })
})
