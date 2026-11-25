// State for the customer repair form page (/r/<token>, RepairFormPage.jsx).
// Pure reducer + a localStorage draft so a customer who closes the LINE browser mid-form
// does not lose the items and photos already uploaded.
import { validateItem, LIMITS, SLOTS } from '../../supabase/functions/_shared/repair-form.ts'

let keySeq = 0
// draft.key ties an upload to the draft it started in: a file that finishes after the customer
// cancelled or moved on to another item is dropped instead of landing on the wrong item.
export function emptyDraft() {
  return { key: ++keySeq, location: '', room: '', symptom: '', note: '', files: [], uploading: 0 }
}

export function initialFormState(info) {
  const sites = Array.isArray(info?.sites) ? info.sites : []
  const one = sites.length === 1
  return {
    step: one ? 'item' : 'site',
    siteId: one ? sites[0].id : null,
    items: [],
    draft: emptyDraft(),
    editIndex: null,
    preferredDays: [],
    preferredSlot: null,
    note: '',
    ticketNumber: null,
  }
}

const cleanFile = (f) => {
  const out = { path: f.path, mediaType: f.mediaType, bytes: f.bytes }
  if (typeof f.seconds === 'number') out.seconds = f.seconds
  return out
}

// A confirmed item: exactly FormItem, nothing extra.
const toItem = (d) => ({
  location: d.location || '',
  room: d.room || '',
  symptom: d.symptom || '',
  note: d.note || '',
  files: (d.files || []).map(cleanFile),
})

const sameDraft = (state, action) => action.key === undefined || action.key === state.draft.key
const patchDraft = (state, patch) => ({ ...state, draft: { ...state.draft, ...patch } })

export function repairFormReducer(state, action) {
  switch (action.type) {
    case 'load':
      return action.state
    case 'pickSite':
      return { ...state, siteId: action.siteId, step: state.items.length ? 'list' : 'item' }
    case 'setDraft':
      return patchDraft(state, action.patch)
    case 'fileStarted':
      if (!sameDraft(state, action)) return state
      return patchDraft(state, { uploading: state.draft.uploading + 1 })
    case 'fileUploaded':
      if (!sameDraft(state, action)) return state
      return patchDraft(state, {
        uploading: Math.max(0, state.draft.uploading - 1),
        files: [...state.draft.files, cleanFile(action.file)],
      })
    case 'fileFailed':
      if (!sameDraft(state, action)) return state
      return patchDraft(state, { uploading: Math.max(0, state.draft.uploading - 1) })
    case 'removeFile':
      return patchDraft(state, { files: state.draft.files.filter((_, i) => i !== action.index) })
    case 'confirmItem': {
      const item = toItem(state.draft)
      if (state.draft.uploading > 0 || validateItem(item).length) return state
      const editing = state.editIndex !== null && state.editIndex >= 0 && state.editIndex < state.items.length
      if (!editing && state.items.length >= LIMITS.maxItems) return state
      const items = editing
        ? state.items.map((x, i) => (i === state.editIndex ? item : x))
        : [...state.items, item]
      return { ...state, items, step: 'list', draft: emptyDraft(), editIndex: null }
    }
    case 'editItem': {
      const it = state.items[action.index]
      if (!it) return state
      return { ...state, step: 'item', editIndex: action.index, draft: { ...emptyDraft(), ...it, files: [...it.files] } }
    }
    case 'cancelItem':
      return { ...state, step: state.items.length ? 'list' : 'item', draft: emptyDraft(), editIndex: null }
    case 'deleteItem':
      return { ...state, items: state.items.filter((_, i) => i !== action.index) }
    case 'addAnother':
      if (state.items.length >= LIMITS.maxItems) return state
      return { ...state, step: 'item', draft: emptyDraft(), editIndex: null }
    case 'toList':
      return { ...state, step: 'list' }
    case 'toConfirm':
      return state.items.length ? { ...state, step: 'confirm' } : state
    case 'toggleDay': {
      const days = state.preferredDays
      if (days.includes(action.day)) return { ...state, preferredDays: days.filter((d) => d !== action.day) }
      if (days.length >= LIMITS.maxPreferredDays) return state
      return { ...state, preferredDays: [...days, action.day].sort() }
    }
    case 'setSlot':
      return { ...state, preferredSlot: action.slot }
    case 'setNote':
      return { ...state, note: action.note }
    case 'submitted':
      return { ...state, step: 'done', ticketNumber: action.ticketNumber }
    default:
      return state
  }
}

// ---- draft in localStorage: optional, every failure is silent ----

const draftKey = (token) => `repair-form:${token}`

export function saveDraft(token, state) {
  try {
    const keep = {
      ...state,
      draft: { ...state.draft, uploading: 0, files: (state.draft?.files || []).filter((f) => f && f.path).map(cleanFile) },
      items: (state.items || []).map(toItem),
    }
    localStorage.setItem(draftKey(token), JSON.stringify(keep))
  } catch { /* storage blocked or full: the draft is a convenience only */ }
}

export function loadDraft(token) {
  try {
    const raw = localStorage.getItem(draftKey(token))
    if (!raw) return null
    const st = JSON.parse(raw)
    if (!st || typeof st !== 'object' || !Array.isArray(st.items)) return null
    return {
      step: typeof st.step === 'string' ? st.step : 'site',
      siteId: typeof st.siteId === 'string' ? st.siteId : null,
      items: st.items.map(toItem),
      draft: { ...emptyDraft(), ...(st.draft && typeof st.draft === 'object' ? st.draft : {}), key: ++keySeq, uploading: 0,
        files: (Array.isArray(st.draft?.files) ? st.draft.files : []).filter((f) => f && f.path).map(cleanFile) },
      editIndex: Number.isInteger(st.editIndex) ? st.editIndex : null,
      preferredDays: Array.isArray(st.preferredDays) ? st.preferredDays.filter((d) => typeof d === 'string') : [],
      // a draft saved before the slot list changed may hold an old value: drop it, the customer picks again
      preferredSlot: typeof st.preferredSlot === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, st.preferredSlot) ? st.preferredSlot : null,
      note: typeof st.note === 'string' ? st.note : '',
      ticketNumber: null,
    }
  } catch {
    return null
  }
}

export function clearDraft(token) {
  try { localStorage.removeItem(draftKey(token)) } catch { /* ignore */ }
}

// The state to start from once info has loaded: a saved draft when it fits this link's sites,
// else the fresh state. A draft with a chosen site never shows the site step again.
export function resumeState(info, draft) {
  const fresh = initialFormState(info)
  if (!draft) return fresh
  const sites = Array.isArray(info?.sites) ? info.sites : []
  const siteOk = draft.siteId && sites.some((s) => s.id === draft.siteId)
  const siteId = siteOk ? draft.siteId : fresh.siteId
  let step = ['item', 'list', 'confirm'].includes(draft.step) ? draft.step : (draft.items.length ? 'list' : 'item')
  if (!siteId) step = 'site'
  else if (step === 'list' || step === 'confirm') step = draft.items.length ? step : 'item'
  const editIndex = step === 'item' && draft.editIndex !== null && draft.editIndex < draft.items.length ? draft.editIndex : null
  // A day picked before Bangkok midnight can be "today" now: the confirm screen has no chip for it,
  // so it could never be tapped off. Keep only days inside the link's current bounds.
  const b = info?.bounds
  const preferredDays = b?.min && b?.max
    ? draft.preferredDays.filter((d) => d >= b.min && d <= b.max)
    : draft.preferredDays
  return { ...draft, siteId, step, editIndex, preferredDays }
}
