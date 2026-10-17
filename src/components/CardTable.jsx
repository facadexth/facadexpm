// CardTable — phone card view for a plain <table> (mobile-view spec §4).
// Desktop (> 900px): renders exactly the old `<div className="table-wrap">` and nothing else, so pages can swap
// their wrapper without any desktop change. Phone: same div with the extra class `card-table`, and after every
// render the cells get `data-label` (header text) and `data-role` (title / amount / sub / row / status / actions /
// hide) so src/mobile.css can draw each <tr> as a card. Markup, handlers and sorting stay the page's own.
import { useLayoutEffect, useRef } from 'react'
import { useIsPhone } from '../hooks/useIsPhone.js'
import { inferRoles, cleanLabel, describeCell } from '../lib/cardTable.js'

export function decorateTable(wrap, map) {
  const table = wrap.querySelector('table')
  if (!table) return
  const ths = [...table.querySelectorAll(':scope > thead th')]
  const headers = ths.map(th => th.textContent)
  ths.forEach(th => { th.dataset.sortable = (th.classList.contains('sortable') || typeof th.onclick === 'function') ? 'true' : 'false' })
  const rows = [...table.querySelectorAll(':scope > tbody > tr')]
  const sampleTr = rows.find(tr => tr.children.length === headers.length)
  const sample = sampleTr ? [...sampleTr.children].map(describeCell) : null
  const roles = inferRoles(headers, sample, map)
  const labels = headers.map(cleanLabel)
  rows.forEach(tr => {
    const tds = [...tr.children]
    if (tds.length !== headers.length) {
      tds.forEach(td => { td.dataset.empty = 'true'; delete td.dataset.role; delete td.dataset.label })
      return
    }
    tds.forEach((td, i) => {
      if (td.dataset.label !== labels[i]) td.dataset.label = labels[i]
      if (td.dataset.role !== roles[i]) td.dataset.role = roles[i]
      if (td.dataset.empty) delete td.dataset.empty
    })
  })
}

export default function CardTable({ map, className = 'table-wrap', children }) {
  const isPhone = useIsPhone()
  const ref = useRef(null)
  useLayoutEffect(() => {
    if (!isPhone || !ref.current) return
    const el = ref.current
    decorateTable(el, map)
    // React re-renders rows on data / sort / filter changes: decorate again. Only data-* attributes are written,
    // so the observer (childList only) never sees its own work → no loop.
    const mo = new MutationObserver(() => decorateTable(el, map))
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [isPhone, map])
  if (!isPhone) return <div className={className}>{children}</div>
  return <div ref={ref} className={`${className} card-table`}>{children}</div>
}
