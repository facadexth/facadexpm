import { useState, useLayoutEffect, useRef, cloneElement } from 'react'

// Deliberately shorter than the shipped single-page minHeight (1000px, from
// commits dbfec30/901293a) -- mirrors WorkPhotosDocumentModal's own
// 270mm-vs-277mm safety margin against an html2pdf.js page-break modulo bug
// (a page div whose height exactly matches the physical page height can
// trigger a spurious blank page).
export const PAGE_HEIGHT_PX = 960

// Two-pass pagination: mount renderHeader/renderTableHeader/renderRow once
// in a hidden measurement pass, read their real rendered heights (this is
// what makes Thai text wrapping -- which a static estimate can't predict --
// measure correctly), then bucket `items` into pages that fit
// PAGE_HEIGHT_PX minus the (measured) header and table-header heights,
// which repeat identically on every page.
export function usePaginatedDocument({ items, renderHeader, renderTableHeader, renderRow }) {
  const [heights, setHeights] = useState(null)
  const headerRef = useRef(null)
  const tableHeaderRef = useRef(null)
  const rowRefs = useRef([])
  rowRefs.current = []

  useLayoutEffect(() => {
    if (!headerRef.current || !tableHeaderRef.current) return
    const headerHeight = headerRef.current.getBoundingClientRect().height
    const tableHeaderHeight = tableHeaderRef.current.getBoundingClientRect().height
    const rowHeights = rowRefs.current.map(el => (el ? el.getBoundingClientRect().height : 0))
    setHeights({ headerHeight, tableHeaderHeight, rowHeights })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const measured = heights && heights.rowHeights.length === items.length

  if (!measured) {
    // Not measured yet -- render everything on one page as a safe fallback
    // (never drops content) while the hidden pass mounts and measures.
    return {
      pages: [items],
      pageCount: 1,
      measurementNode: (
        <div style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: -99999, width: 700, zIndex: -1 }}>
          <div ref={headerRef}>{renderHeader()}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead ref={tableHeaderRef}>{renderTableHeader()}</thead>
            <tbody>
              {items.map((it, i) => cloneElement(renderRow(it, i), { ref: el => { rowRefs.current[i] = el } }))}
            </tbody>
          </table>
        </div>
      ),
    }
  }

  const available = PAGE_HEIGHT_PX - heights.headerHeight - heights.tableHeaderHeight
  const pages = []
  let current = []
  let currentHeight = 0
  items.forEach((it, i) => {
    const h = heights.rowHeights[i]
    if (current.length && currentHeight + h > available) {
      pages.push(current)
      current = []
      currentHeight = 0
    }
    current.push(it)
    currentHeight += h
  })
  pages.push(current)

  return { pages, pageCount: pages.length, measurementNode: null }
}
