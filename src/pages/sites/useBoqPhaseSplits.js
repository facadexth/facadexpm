// The site's saved "% ต่อเฟส" rows (boq_phase_splits) -- shared by the BOQ tab matrix
// and the Kanban's per-phase BOQ cards. rows non-empty = the site is in BOQ mode.
// Fails soft: before migration 2026-10-20-15 is live (or on any error) `unavailable`
// is true and rows stay [] so the callers draw nothing new.
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'

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
        const { data, error } = await supabase.from('boq_phase_splits').select('boq_item_id, phase_id, pct').in('boq_item_id', idsKey.split(','))
        if (cancelled) return
        if (error) { setUnavailable(true); setRows([]) } else { setUnavailable(false); setRows(data || []) }
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
