import { describe, it, expect } from 'vitest'
import { evalExpr } from './layoutExpr.js'
describe('evalExpr', () => {
  it('numbers pass through', () => { expect(evalExpr(2, {})).toBe(2); expect(evalExpr('0.5', {})).toBe(0.5) })
  it('identifiers and arithmetic', () => {
    expect(evalExpr('cols-1', { cols: 4 })).toBe(3)
    expect(evalExpr('(rows-1)*cols', { rows: 3, cols: 4 })).toBe(8)
    expect(evalExpr('nL+nR', { nL: 2, nR: 1 })).toBe(3)
    expect(evalExpr('1/n', { n: 4 })).toBe(0.25)
  })
  it('missing identifier -> 0 for counts, error flagged', () => { expect(() => evalExpr('cols-1', {})).toThrow('layout_expr') })
  it('rejects anything but identifiers, digits and + - * / ( )', () => {
    for (const bad of ['cols--', 'Math.max(1,2)', 'a;b', '1e3x', '__proto__']) expect(() => evalExpr(bad, { cols: 1 })).toThrow('layout_expr')
  })
  it('respects precedence, parentheses and whitespace', () => {
    expect(evalExpr(' 2 + 3 * 4 ', {})).toBe(14)
    expect(evalExpr('(2+3)*4', {})).toBe(20)
    expect(evalExpr('8/2/2', {})).toBe(2)
    expect(evalExpr('10-2-3', {})).toBe(5)
  })
  it('throws on division by zero, empty input and non-numeric params', () => {
    expect(() => evalExpr('1/n', { n: 0 })).toThrow('layout_expr')
    expect(() => evalExpr('', {})).toThrow('layout_expr')
    expect(() => evalExpr('a', { a: 'x' })).toThrow('layout_expr')
    expect(() => evalExpr('toString', {})).toThrow('layout_expr')
    expect(() => evalExpr(NaN, {})).toThrow('layout_expr')
  })
})
