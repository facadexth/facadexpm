// The site's saved "% ต่อเฟส" rows (boq_phase_splits) -- shared by the BOQ tab matrix
// and the Kanban's per-phase BOQ cards. rows non-empty = the site is in BOQ mode.
// Ids go in chunks of at most 100 per .in() (URL length) and every chunk is paged with
// .range() through fetchAllRows (PostgREST row cap), so no rows are dropped.
// Fails soft: before migration 2026-10-20-15 is live (or on any error) `unavailable`
// is true and rows stay [] so the callers draw nothing new.
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { fetchAllRows } from '../../lib/fetchAllRows.js'

export const SPLIT_ID_CHUNK = 100

export async function fetchBoqPhaseSplits(boqItemIds) {
  let all = []
  for (let i = 0; i < boqItemIds.length; i += SPLIT_ID_CHUNK) {
    const chunk = boqItemIds.slice(i, i + SPLIT_ID_CHUNK)
    const rows = await fetchAllRows(() => supabase
      .from('boq_phase_splits')
      .select('boq_item_id, phase_id, pct')
      .in('boq_item_id', chunk)
      .order('boq_item_id', { ascending: true })
      .order('phase_id', { ascending: true }))
    all = all.concat(rows)
  }
  return all
}

export function useBoqPhaseSplits(boqItemIds, enabled = true) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [tick, setTick] = useState(0)
  const idsKey = (boqItemIds || []).join(',')
  useEffect(() => {
    if (!enabled || !idsKey) { setRows([]); setLoading(false); return undefined }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const data = await fetchBoqPhaseSplits(idsKey.split(','))
        if (cancelled) return
        setUnavailable(false); setRows(data)
      } catch {
        if (!cancelled) { setUnavailable(true); setRows([]) }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [idsKey, enabled, tick])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { rows, loading, unavailable, boqMode: rows.length > 0, reload }
}
