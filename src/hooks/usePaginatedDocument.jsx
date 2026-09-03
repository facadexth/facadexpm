import { useState, useLayoutEffect, useRef, cloneElement } from 'react'

// Shared page geometry -- exported so every consumer (today: just
// QuotationPaper) builds its real page-div from these exact same numbers
// instead of hand-copying them. This is deliberate: the hidden measurement
// pass below and the real final render MUST agree on width/padding, because
// they're rendering the same header/rows and Thai text wraps differently at
// different content-box widths. A drift here (previously: 700px measured vs
// a 612px real content box once padding+border-box were accounted for)
// makes the hidden pass measure rows shorter than they really render,
// letting real pages come out over-full. See PAGE_HEIGHT_PX below for the
// matching height-budget math.
export const PAGE_WIDTH_PX = 700
export const PAGE_PADDING_V_PX = 40 // top+bottom
export const PAGE_PADDING_H_PX = 44 // left+right
export const PAGE_PADDING_CSS = `${PAGE_PADDING_V_PX}px ${PAGE_PADDING_H_PX}px`

// This is the CONTENT budget only (header + table-header + rows), not a
// page-div's own outer height -- a consuming component adds its own
// vertical padding (PAGE_PADDING_V_PX, both top and bottom) on top of this
// to get its page-div's real fixed height.
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
// prior testing on this same component: a 2-logical-page quotation exported
// as 4 PDF pages because its ~1040px-tall page-divs left only ~6px of
// margin below the 1046px real budget). Consumers must leave a comparable
// safety margin below 1046px for their *total* page-div height (content
// budget + their own padding), not just this content-only number.
export const PAGE_HEIGHT_PX = 900

// Two-pass pagination: mount renderHeader/renderTableHeader/renderRow (and,
// optionally, renderFooter) once in a hidden measurement pass, read their
// real rendered heights (this is what makes Thai text wrapping -- which a
// static estimate can't predict -- measure correctly), then bucket `items`
// into pages that fit PAGE_HEIGHT_PX minus the (measured) header and
// table-header heights, which repeat identically on every page.
//
// `renderFooter` is optional and describes content (e.g. totals/notes/
// signature) that a consumer renders ONLY on the actual last page, in the
// same page-div as the rows -- if provided, its measured height is reserved
// out of the LAST page's budget specifically (every other page keeps the
// full budget), and any rows that would leave the last page too short for
// it are spilled forward onto a new trailing page instead. Without this,
// a fixed-height last page-div has nowhere for an over-budget footer to go
// (no shrink-to-fit safety net the way a `minHeight` div would have had).
export function usePaginatedDocument({ items, renderHeader, renderTableHeader, renderRow, renderFooter }) {
  const [heights, setHeights] = useState(null)
  const headerRef = useRef(null)
  const tableHeaderRef = useRef(null)
  const footerRef = useRef(null)
  const rowRefs = useRef([])
  rowRefs.current = []

  useLayoutEffect(() => {
    if (!headerRef.current || !tableHeaderRef.current) return
    const headerHeight = headerRef.current.getBoundingClientRect().height
    const tableHeaderHeight = tableHeaderRef.current.getBoundingClientRect().height
    const footerHeight = footerRef.current ? footerRef.current.getBoundingClientRect().height : 0
    const rowHeights = rowRefs.current.map(el => (el ? el.getBoundingClientRect().height : 0))
    setHeights({ headerHeight, tableHeaderHeight, footerHeight, rowHeights })
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
        // width/padding/boxSizing here are the exact same shared constants
        // the real page-div is built from (see PAGE_WIDTH_PX etc. above) --
        // this is what keeps the hidden pass's content-box width identical
        // to the real render's, so Thai text wraps the same way in both.
        <div style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: -99999, width: PAGE_WIDTH_PX, padding: PAGE_PADDING_CSS, boxSizing: 'border-box', zIndex: -1 }}>
          <div ref={headerRef}>{renderHeader()}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead ref={tableHeaderRef}>{renderTableHeader()}</thead>
            <tbody>
              {items.map((it, i) => cloneElement(renderRow(it, i), { ref: el => { rowRefs.current[i] = el } }))}
            </tbody>
          </table>
          {renderFooter && <div ref={footerRef}>{renderFooter()}</div>}
        </div>
      ),
    }
  }

  const availableRegular = PAGE_HEIGHT_PX - heights.headerHeight - heights.tableHeaderHeight
  const availableLast = Math.max(availableRegular - heights.footerHeight, 0)

  const rows = items.map((it, i) => ({ it, h: heights.rowHeights[i] }))

  const pages = []
  let current = []
  let currentHeight = 0
  rows.forEach(({ it, h }) => {
    if (current.length && currentHeight + h > availableRegular) {
      pages.push(current)
      current = []
      currentHeight = 0
    }
    current.push({ it, h })
    currentHeight += h
  })
  pages.push(current)

  // The footer (e.g. totals/notes/signature) only ever renders on the true
  // last page, so that page alone needs the smaller `availableLast` budget.
  // If what's currently the last page is packed too tight for the footer to
  // fit underneath it, spill its trailing row onto a fresh page (which
  // becomes the new last page) and re-check -- repeat until it fits. Stops
  // once the last page is down to a single row so one oversized row can't
  // spin this into an infinite loop; that row is left to overflow rather
  // than starve pagination entirely.
  while (pages.length) {
    const last = pages[pages.length - 1]
    const lastHeight = last.reduce((sum, r) => sum + r.h, 0)
    if (lastHeight <= availableLast || last.length <= 1) break
    pages.push([last.pop()])
  }

  return { pages: pages.map(p => p.map(r => r.it)), pageCount: pages.length, measurementNode: null }
}
