// ============================================================
// Is the Gantt weighted-progress schema (migration 2026-10-17-07) there?
// One cached probe per page load: select phase_tasks.progress_mode with
// limit 0. It reads no rows, so it does not depend on what RLS lets this
// user see (a new tenant or a PM with no visible cards still gets the right
// answer). Any error -> not ready -> pre-migration behaviour (the forms
// neither show nor send the new columns).
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

let probe = null // Promise<boolean>
let known = null // boolean once settled

export function probeProgressSchema() {
  if (!probe) {
    probe = Promise.resolve()
      .then(() => supabase.from('phase_tasks').select('progress_mode').limit(0))
      .then(({ error }) => !error, () => false)
      .then((ok) => { known = ok; return ok })
  }
  return probe
}

/** true once the probe succeeded; false while it runs or when it failed. */
export function useProgressSchemaReady() {
  const [ready, setReady] = useState(() => known === true)
  useEffect(() => {
    let cancelled = false
    probeProgressSchema().then((ok) => { if (!cancelled) setReady(ok) })
    return () => { cancelled = true }
  }, [])
  return ready
}

/** Tests only: forget the cached answer. */
export function resetProgressSchemaProbe() { probe = null; known = null }
