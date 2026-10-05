import { describe, it, expect, vi } from 'vitest'
import { shouldBlockEnter, shouldBlurOnWheel, installInputGuards } from './inputGuards.js'

const input = (over = {}) => ({
  tagName: 'INPUT', type: 'text', form: {}, closest: () => null, ...over,
})
const key = (target, over = {}) => ({ key: 'Enter', isComposing: false, target, ...over })

describe('shouldBlockEnter', () => {
  it('blocks Enter in text/number/checkbox inputs inside a form', () => {
    expect(shouldBlockEnter(key(input()))).toBe(true)
    expect(shouldBlockEnter(key(input({ type: 'number' })))).toBe(true)
    expect(shouldBlockEnter(key(input({ type: 'checkbox' })))).toBe(true)
  })
  it('does not block textarea', () => {
    expect(shouldBlockEnter(key({ tagName: 'TEXTAREA', form: {}, closest: () => null }))).toBe(false)
  })
  it('does not block inputs outside a form', () => {
    expect(shouldBlockEnter(key(input({ form: null })))).toBe(false)
  })
  it.each(['submit', 'button', 'reset', 'image', 'file'])('does not block type=%s', (type) => {
    expect(shouldBlockEnter(key(input({ type })))).toBe(false)
  })
  it('does not block inside [data-enter-submit]', () => {
    expect(shouldBlockEnter(key(input({ closest: () => ({}) })))).toBe(false)
  })
  it('does not block while composing or for other keys', () => {
    expect(shouldBlockEnter(key(input(), { isComposing: true }))).toBe(false)
    expect(shouldBlockEnter(key(input(), { key: 'a' }))).toBe(false)
  })
})

describe('shouldBlurOnWheel', () => {
  it('true only for focused number input', () => {
    const n = input({ type: 'number' })
    expect(shouldBlurOnWheel({ target: n }, { activeElement: n })).toBe(true)
    expect(shouldBlurOnWheel({ target: n }, { activeElement: {} })).toBe(false)
    const t = input()
    expect(shouldBlurOnWheel({ target: t }, { activeElement: t })).toBe(false)
  })
})

describe('installInputGuards', () => {
  const makeDoc = () => {
    const l = {}
    return {
      l, activeElement: null,
      addEventListener: vi.fn((t, fn, o) => { l[t] = { fn, o } }),
      removeEventListener: vi.fn((t, fn, o) => { if (l[t]?.fn === fn) delete l[t] }),
    }
  }
  it('registers listeners, behaves, and removes', () => {
    const doc = makeDoc()
    const remove = installInputGuards(doc)
    expect(doc.l.keydown.o).toBe(true)
    expect(doc.l.wheel.o).toEqual({ passive: true, capture: true })
    const pd = vi.fn()
    doc.l.keydown.fn({ ...key(input()), preventDefault: pd })
    expect(pd).toHaveBeenCalledTimes(1)
    doc.l.keydown.fn({ ...key({ tagName: 'TEXTAREA', form: {} }), preventDefault: pd })
    expect(pd).toHaveBeenCalledTimes(1)
    const blur = vi.fn()
    const n = input({ type: 'number', blur })
    doc.activeElement = n
    doc.l.wheel.fn({ target: n })
    expect(blur).toHaveBeenCalledTimes(1)
    const t = input({ blur })
    doc.activeElement = t
    doc.l.wheel.fn({ target: t })
    expect(blur).toHaveBeenCalledTimes(1)
    remove()
    expect(doc.l.keydown).toBeUndefined()
    expect(doc.l.wheel).toBeUndefined()
  })
  it('is idempotent', () => {
    const doc = makeDoc()
    const a = installInputGuards(doc)
    const b = installInputGuards(doc)
    expect(doc.addEventListener).toHaveBeenCalledTimes(2)
    expect(a).toBe(b)
    a()
  })
})
