// ============================================================
// useDraftForm — persist "add new" form contents to localStorage
// so an unexpected page reload (e.g. Chrome discarding an inactive
// background tab) doesn't wipe out unsaved typing.
//
// Two ways to use this module, matching two different component
// shapes found in this codebase:
//
// 1. useDraftForm(key, initialForm, enabled) — a drop-in useState
//    replacement, for components that freshly MOUNT each time their
//    modal opens (e.g. <SiteForm> rendered as {showForm && <SiteForm/>}).
//    Restoration happens naturally via the mount-time lazy initializer.
//
// 2. readDraft/saveDraft/clearDraft — raw primitives, for components
//    whose form state lives in an always-mounted parent (e.g.
//    LaborContractors.jsx's SubcontractorTab/ContractsTab, where the
//    modal is just conditional JSX inside a tab that never unmounts).
//    Wire these in manually at the points where the form is opened,
//    changed, saved, and cancelled.
// ============================================================
import { useEffect, useState } from 'react'

const PREFIX = 'draft:'

function safeGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Private browsing, quota exceeded, etc. — persistence is a
    // nice-to-have; fail silently rather than break the form.
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}

/** Read a previously-saved draft for `key`, or null if none exists. */
export function readDraft(key) {
  return safeGet(key)
}

/** Persist `data` as the current draft for `key`. */
export function saveDraft(key, data) {
  safeSet(key, data)
}

/** Remove any saved draft for `key`. */
export function clearDraft(key) {
  safeRemove(key)
}

/**
 * Drop-in replacement for `useState(initialForm)` that also persists
 * to localStorage while `enabled` is true, restoring from any existing
 * draft at mount time. Pass `enabled=false` (e.g. when editing an
 * existing record) to behave exactly like plain useState with zero
 * persistence.
 */
export function useDraftForm(key, initialForm, enabled = true) {
  const [form, setForm] = useState(() => {
    if (!enabled) return initialForm
    const saved = readDraft(key)
    return saved ? { ...initialForm, ...saved } : initialForm
  })

  useEffect(() => {
    if (!enabled) return
    saveDraft(key, form)
  }, [form, enabled, key])

  const clear = () => { if (enabled) clearDraft(key) }

  return [form, setForm, clear]
}
