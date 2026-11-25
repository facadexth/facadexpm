import { describe, it, expect, beforeEach, vi } from 'vitest'
import { repairFormReducer, initialFormState, loadDraft, saveDraft, clearDraft, emptyDraft, resumeState } from './repairFormState.js'

const s1 = { id: 's1', name: 'บ้านคุณสมชาย' }
const s2 = { id: 's2', name: 'อาคาร ABC' }
const img = { path: 't/form-x/1.jpg', mediaType: 'image', bytes: 1000 }

const withDraft = (draft, extra = {}) => ({
  ...initialFormState({ sites: [s1] }),
  draft: { ...emptyDraft(), ...draft },
  ...extra,
})
const valid = { location: 'ห้องนอน', symptom: 'รั่วซึม', files: [img] }

// minimal in-memory localStorage so the round-trip test does not depend on the environment
function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
  }
}

describe('initialFormState', () => {
  it('skips the site step when there is one site', () => {
    const st = initialFormState({ sites: [s1] })
    expect(st.step).toBe('item')
    expect(st.siteId).toBe('s1')
  })
  it('starts on the site step with two sites', () => {
    const st = initialFormState({ sites: [s1, s2] })
    expect(st.step).toBe('site')
    expect(st.siteId).toBe(null)
  })
})

describe('repairFormReducer', () => {
  it('pickSite goes to the item step', () => {
    const st = repairFormReducer(initialFormState({ sites: [s1, s2] }), { type: 'pickSite', siteId: 's2' })
    expect(st.siteId).toBe('s2')
    expect(st.step).toBe('item')
  })

  it('confirmItem with no image is ignored (state unchanged)', () => {
    const st = withDraft({ location: 'ห้องนอน', symptom: 'รั่วซึม', files: [] })
    expect(repairFormReducer(st, { type: 'confirmItem' })).toBe(st)
  })

  it('confirmItem while a file is uploading is ignored', () => {
    const st = withDraft({ ...valid, uploading: 1 })
    expect(repairFormReducer(st, { type: 'confirmItem' })).toBe(st)
  })

  it('a valid confirm adds the item, goes to list and empties the draft', () => {
    const st = repairFormReducer(withDraft(valid), { type: 'confirmItem' })
    expect(st.items.length).toBe(1)
    expect(st.items[0]).toEqual({ location: 'ห้องนอน', room: '', symptom: 'รั่วซึม', note: '', files: [img] })
    expect(st.step).toBe('list')
    expect(st.draft.files).toEqual([])
    expect(st.draft.location).toBe('')
    expect(st.draft.uploading).toBe(0)
  })

  it('editItem then confirmItem replaces the item instead of appending', () => {
    let st = repairFormReducer(withDraft(valid), { type: 'confirmItem' })
    st = repairFormReducer(st, { type: 'editItem', index: 0 })
    expect(st.step).toBe('item')
    expect(st.draft.location).toBe('ห้องนอน')
    st = repairFormReducer(st, { type: 'setDraft', patch: { location: 'ครัว' } })
    st = repairFormReducer(st, { type: 'confirmItem' })
    expect(st.items.length).toBe(1)
    expect(st.items[0].location).toBe('ครัว')
    expect(st.editIndex).toBe(null)
  })

  it('file actions track uploads and ignore a stale draft', () => {
    let st = withDraft({ location: 'ห้องนอน', symptom: 'รั่วซึม' })
    const key = st.draft.key
    st = repairFormReducer(st, { type: 'fileStarted', key })
    st = repairFormReducer(st, { type: 'fileStarted', key })
    expect(st.draft.uploading).toBe(2)
    st = repairFormReducer(st, { type: 'fileUploaded', key, file: img })
    st = repairFormReducer(st, { type: 'fileFailed', key })
    expect(st.draft.uploading).toBe(0)
    expect(st.draft.files).toEqual([img])
    const stale = repairFormReducer(st, { type: 'fileUploaded', key: key + 999, file: img })
    expect(stale).toBe(st)
    st = repairFormReducer(st, { type: 'removeFile', index: 0 })
    expect(st.draft.files).toEqual([])
  })

  it('deleteItem and addAnother', () => {
    let st = repairFormReducer(withDraft(valid), { type: 'confirmItem' })
    st = repairFormReducer(st, { type: 'addAnother' })
    expect(st.step).toBe('item')
    expect(st.editIndex).toBe(null)
    st = repairFormReducer(st, { type: 'cancelItem' })
    expect(st.step).toBe('list')
    st = repairFormReducer(st, { type: 'deleteItem', index: 0 })
    expect(st.items).toEqual([])
  })

  it('toConfirm needs at least one item', () => {
    const empty = { ...initialFormState({ sites: [s1] }), step: 'list' }
    expect(repairFormReducer(empty, { type: 'toConfirm' }).step).toBe('list')
    const one = repairFormReducer(withDraft(valid), { type: 'confirmItem' })
    expect(repairFormReducer(one, { type: 'toConfirm' }).step).toBe('confirm')
  })

  it('toggleDay ignores a 4th day', () => {
    let st = initialFormState({ sites: [s1] })
    for (const d of ['2026-12-01', '2026-12-02', '2026-12-03']) st = repairFormReducer(st, { type: 'toggleDay', day: d })
    const four = repairFormReducer(st, { type: 'toggleDay', day: '2026-12-04' })
    expect(four).toBe(st)
    expect(four.preferredDays).toEqual(['2026-12-01', '2026-12-02', '2026-12-03'])
  })

  it('toggling the same day twice removes it', () => {
    let st = initialFormState({ sites: [s1] })
    st = repairFormReducer(st, { type: 'toggleDay', day: '2026-12-01' })
    expect(st.preferredDays).toEqual(['2026-12-01'])
    st = repairFormReducer(st, { type: 'toggleDay', day: '2026-12-01' })
    expect(st.preferredDays).toEqual([])
  })

  it('setSlot, setNote and submitted', () => {
    let st = initialFormState({ sites: [s1] })
    st = repairFormReducer(st, { type: 'setSlot', slot: 'day' })
    st = repairFormReducer(st, { type: 'setNote', note: 'โทรก่อนเข้า' })
    st = repairFormReducer(st, { type: 'submitted', ticketNumber: 'RP2611-007' })
    expect(st).toMatchObject({ preferredSlot: 'day', note: 'โทรก่อนเข้า', step: 'done', ticketNumber: 'RP2611-007' })
  })
})

describe('saveDraft / loadDraft', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('round-trips through localStorage key repair-form:<token>', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const st = repairFormReducer(withDraft(valid), { type: 'confirmItem' })
    saveDraft('tok1', st)
    expect(ls.getItem('repair-form:tok1')).toBeTruthy()
    const back = loadDraft('tok1')
    expect(back.items).toEqual(st.items)
    expect(back.siteId).toBe('s1')
    expect(back.step).toBe('list')
    clearDraft('tok1')
    expect(loadDraft('tok1')).toBe(null)
  })

  it('never saves files without a path and saves uploading as 0', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const st = withDraft({ ...valid, files: [img, { mediaType: 'image', bytes: 5 }] })
    saveDraft('tok2', st)
    const back = loadDraft('tok2')
    expect(back.draft.files).toEqual([img])
    expect(back.draft.uploading).toBe(0)
  })

  it('a draft saved with an old slot (afternoon) comes back with no slot; day survives', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const st = repairFormReducer(withDraft(valid), { type: 'confirmItem' })
    saveDraft('tok4', { ...st, preferredSlot: 'afternoon' })
    expect(loadDraft('tok4').preferredSlot).toBe(null)
    saveDraft('tok4', { ...st, preferredSlot: 'day' })
    expect(loadDraft('tok4').preferredSlot).toBe('day')
  })

  it('loadDraft returns null when localStorage.getItem throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(loadDraft('tok3')).toBe(null)
    expect(() => saveDraft('tok3', initialFormState({ sites: [s1] }))).not.toThrow()
  })

  it('loadDraft returns null for junk JSON', () => {
    const ls = memoryStorage()
    ls.setItem('repair-form:tok4', '{not json')
    vi.stubGlobal('localStorage', ls)
    expect(loadDraft('tok4')).toBe(null)
  })
})

describe('resumeState', () => {
  it('drops restored preferred days outside the new bounds', () => {
    const draft = { ...initialFormState({ sites: [s1] }), step: 'confirm', items: [{ location: 'ห้องนอน', room: '', symptom: 'รั่วซึม', note: '', files: [img] }],
      preferredDays: ['2026-11-25', '2026-11-27'] }
    const st = resumeState({ sites: [s1], bounds: { min: '2026-11-26', max: '2027-01-25' } }, draft)
    expect(st.preferredDays).toEqual(['2026-11-27'])
  })
})
