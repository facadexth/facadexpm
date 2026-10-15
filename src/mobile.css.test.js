// Guarantees constraint 1 of the mobile-view spec: every rule in src/mobile.css is inside ONE
// `@media (max-width: 900px)` block, so laptop / landscape tablet never pick up a phone rule.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8')
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

function mediaBlockEnd(text, start) {
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

describe('mobile.css is phone-only', () => {
  it('has exactly one @media block, with the phone query', () => {
    const medias = stripped.match(/@media[^{]*\{/g) || []
    expect(medias).toHaveLength(1)
    expect(medias[0].replace(/\s+/g, ' ').trim()).toBe('@media (max-width: 900px) {')
  })

  it('has no rule before or after that block', () => {
    const start = stripped.indexOf('@media')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(stripped.slice(0, start).trim()).toBe('')
    const end = mediaBlockEnd(stripped, start)
    expect(end).toBeGreaterThan(start)
    expect(stripped.slice(end + 1).trim()).toBe('')
  })

  it('never widens the gate (no min-width, no nested media)', () => {
    expect(stripped).not.toMatch(/@media[^{]*min-width/)
    expect((stripped.match(/@media/g) || []).length).toBe(1)
  })
})
