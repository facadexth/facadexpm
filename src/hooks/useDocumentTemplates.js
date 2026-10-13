// Published quotation templates + published sample image packs (RLS only returns
// published rows to tenants). Cached for the session so every QuotationPaper on
// screen shares one fetch. A failed fetch (e.g. tables not installed) resolves to
// empty lists, which makes every tenant fall back to the classic layout.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const TTL_MS = 5 * 60 * 1000
let cache = null // { at, data }
let inflight = null

export function clearDocumentTemplatesCache() { cache = null }

export async function fetchPublishedTemplates() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data
  if (!inflight) {
    inflight = (async () => {
      try {
        const [t, p] = await Promise.all([
          supabase.from('document_templates').select('*').eq('status', 'published'),
          supabase.from('document_image_packs').select('*').eq('status', 'published').order('name_th'),
        ])
        const data = t.error || p.error ? { templates: [], packs: [] } : { templates: t.data || [], packs: p.data || [] }
        cache = { at: Date.now(), data }
        return data
      } catch {
        return { templates: [], packs: [] }
      } finally {
        inflight = null
      }
    })()
  }
  return inflight
}

// enabled=false -> no request is made (tenants that never chose a template).
export function useDocumentTemplates(enabled = true) {
  const [state, setState] = useState(() => (cache ? cache.data : { templates: null, packs: null }))
  useEffect(() => {
    if (!enabled) return
    let alive = true
    fetchPublishedTemplates().then(d => { if (alive) setState(d) })
    return () => { alive = false }
  }, [enabled])
  return state
}
