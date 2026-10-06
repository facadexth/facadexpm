import { describe, it, expect } from 'vitest'
import { isValidThaiId13, normalizeDigits } from './dbdCompanyParse.js'

// 0105564000012 / 0105550123451 คำนวณด้วยสูตรเอง (ถูกต้อง); 0105564000013 ผิด check digit
describe('isValidThaiId13', () => {
  it('accepts valid numbers', () => {
    expect(isValidThaiId13('0105564000012')).toBe(true)
    expect(isValidThaiId13('0105550123451')).toBe(true)
    expect(isValidThaiId13('0107544000108')).toBe(true)
  })
  it('rejects bad check digit, wrong length, junk', () => {
    expect(isValidThaiId13('0105564000013')).toBe(false)
    expect(isValidThaiId13('010556400001')).toBe(false)
    expect(isValidThaiId13('')).toBe(false)
    expect(isValidThaiId13(null)).toBe(false)
  })
  it('accepts hyphens, spaces and Thai digits', () => {
    expect(isValidThaiId13('0-1055-64000-01-2')).toBe(true)
    expect(isValidThaiId13('๐๑๐๕๕๖๔๐๐๐๐๑๒')).toBe(true)
  })
})

describe('normalizeDigits', () => {
  it('converts Thai digits', () => expect(normalizeDigits('๑๐๑๑๐')).toBe('10110'))
})
