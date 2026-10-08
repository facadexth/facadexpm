import { describe, it, expect } from 'vitest'
import { seriesLabelFull, seriesLabelShort } from './aluCatalog.js'

const provider = { name: 'ไทยยูนิค', short_name: 'TYK' }
describe('series labels', () => {
  it('full label puts the owner after the series name', () => {
    expect(seriesLabelFull({ name: 'กล่องร่อง' }, provider)).toBe('กล่องร่อง · ไทยยูนิค')
  })
  it('short label uses the owner short name', () => {
    expect(seriesLabelShort({ name: 'กล่องร่อง' }, provider)).toBe('กล่องร่อง (TYK)')
  })
  it('falls back to the bare series name when the provider is unknown', () => {
    expect(seriesLabelFull({ name: 'กล่องร่อง' }, undefined)).toBe('กล่องร่อง')
    expect(seriesLabelShort({ name: 'กล่องร่อง' }, { name: 'X', short_name: '' })).toBe('กล่องร่อง')
  })
})
