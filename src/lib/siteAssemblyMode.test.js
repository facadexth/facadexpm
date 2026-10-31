import { describe, it, expect } from 'vitest'
import { assemblyModeField, ASSEMBLY_MODE_OPTIONS } from './siteAssemblyMode.js'

describe('assemblyModeField', () => {
  it('ตามบริษัท (empty) saves NULL', () => expect(assemblyModeField({ assembly_mode: '' })).toEqual({ assembly_mode: null }))
  it('keeps none / assembly', () => {
    expect(assemblyModeField({ assembly_mode: 'none' })).toEqual({ assembly_mode: 'none' })
    expect(assemblyModeField({ assembly_mode: 'assembly' })).toEqual({ assembly_mode: 'assembly' })
  })
  it('not loaded yet (undefined): leaves the column alone', () => expect(assemblyModeField({})).toEqual({}))
  it('three options, ตามบริษัท first', () => expect(ASSEMBLY_MODE_OPTIONS.map(o => o.value)).toEqual(['', 'none', 'assembly']))
})
