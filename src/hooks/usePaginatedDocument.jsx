import { useState, useLayoutEffect, useRef, cloneElement } from 'react'

// This is the CONTENT budget only (header + table-header + rows), not a
// page-div's own outer height -- a consuming component adds its own
// vertical padding on top (see QuotationPaper's PAGE_DIV_HEIGHT_PX).
//
// Calibrated against html2pdf.js's real per-page pixel budget, not picked
// arbitrarily: downloadPDF (src/lib/pdf.js) renders A4 with 10mm top+bottom
// margins, and html2pdf.js's own page-break math (dist/html2pdf.js,
// toContainer_pagebreak) compares live DOM getBoundingClientRect() values
// in CSS reference px (96dpi, independent of html2canvas `scale` or the
// container's rendered width) against that page's content-height budget --
// (297mm - 2*10mm) * 96/25.4 ≈ 1046px. A page-div whose own rendered
// height lands close to that number reproduces the exact modulo/rounding
// "spurious blank/extra page" bug WorkPhotosDocumentModal's PAGE_HEIGHT_MM
// comment already diagnosed for its own 277mm-vs-270mm case (confirmed by
// this task's own live testing: a 2-logical-page quotation exported as 4
// PDF pages because its ~1040px-tall page-divs left only ~6px of margin
// below the 1046px real budget). Consumers must leave a comparable safety
// margin below 1046px for their *total* page-div height (content budget +
// their own padding), not just this content-only number.
export const PAGE_HEIGHT_PX = 900

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
        // width:700 must match the real (final-render) document's own
        // fixed width exactly -- Thai text wraps differently at different
        // widths, so a mismatch here measures the wrong row heights and
        // silently reintroduces the same page-height overflow this hook
        // exists to prevent. See QuotationPaper's own width:700 container.
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
