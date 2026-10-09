import { describe, it, expect } from 'vitest'
import { hardwareSetStatus, missingHardwareTypeIds, packagesForSeries } from './projectHardware.js'

const types = {
  slide: { id: 'slide', parent_id: null }, low: { id: 'low', parent_id: 'slide' }, top: { id: 'top', parent_id: 'slide' },
  swing: { id: 'swing', parent_id: null }, fixed: { id: 'fixed', parent_id: null },
}
const items = [
  { type_id: 'slide', hardware_set_id: 'HW-A' },
  { type_id: 'top', hardware_set_id: 'HW-B' },
  { type_id: 'fixed', hardware_set_id: null },
]

describe('hardwareSetStatus', () => {
  it('uses the type\'s own row, else the nearest ancestor\'s', () => {
    expect(hardwareSetStatus(items, types, 'top', 'OLD')).toEqual({ set_id: 'HW-B', status: 'set' })
    expect(hardwareSetStatus(items, types, 'low', 'OLD')).toEqual({ set_id: 'HW-A', status: 'set' })
    expect(hardwareSetStatus(items, types, 'slide', 'OLD')).toEqual({ set_id: 'HW-A', status: 'set' })
  })
  it('a row with no set means "no hardware set" on purpose, not missing', () => {
    expect(hardwareSetStatus(items, types, 'fixed', 'OLD')).toEqual({ set_id: null, status: 'none' })
  })
  it('a type with no row in a chosen package is missing and does NOT fall back to the old project default', () => {
    expect(hardwareSetStatus(items, types, 'swing', 'OLD')).toEqual({ set_id: null, status: 'missing' })
    expect(hardwareSetStatus([], types, 'swing', 'OLD')).toEqual({ set_id: null, status: 'missing' })
  })
  it('with no package at all (null / undefined) the old project default applies, so existing projects price the same', () => {
    expect(hardwareSetStatus(null, types, 'swing', 'OLD')).toEqual({ set_id: 'OLD', status: 'legacy' })
    expect(hardwareSetStatus(undefined, types, 'swing', null)).toEqual({ set_id: null, status: 'legacy' })
  })
  it('no type gives nothing to resolve', () => {
    expect(hardwareSetStatus(items, types, null, 'OLD')).toEqual({ set_id: null, status: 'missing' })
    expect(hardwareSetStatus(null, types, null, 'OLD')).toEqual({ set_id: 'OLD', status: 'legacy' })
  })
})

describe('missingHardwareTypeIds', () => {
  it('lists distinct type ids that are missing, in the order given', () => {
    expect(missingHardwareTypeIds(items, types, ['low', 'swing', 'fixed', 'swing', null])).toEqual(['swing'])
  })
  it('lists nothing for a project without a package or without types', () => {
    expect(missingHardwareTypeIds(null, types, ['swing'])).toEqual([])
    expect(missingHardwareTypeIds(items, types, [])).toEqual([])
    expect(missingHardwareTypeIds(items, types, null)).toEqual([])
  })
})

describe('packagesForSeries', () => {
  const pk = [
    { id: 'a', name: 'B', series_id: 's1', active: true },
    { id: 'b', name: 'A', series_id: null, active: true },
    { id: 'c', name: 'C', series_id: 's2', active: true },
    { id: 'd', name: 'D', series_id: 's1', active: false },
  ]
  it('lists active packages of that series or of any series, sorted by name', () => {
    expect(packagesForSeries(pk, 's1').map(p => p.id)).toEqual(['b', 'a'])
  })
  it('with no series chosen only any-series packages are offered; null input is empty', () => {
    expect(packagesForSeries(pk, null).map(p => p.id)).toEqual(['b'])
    expect(packagesForSeries(null, 's1')).toEqual([])
  })
})
