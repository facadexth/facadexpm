import { useState, useLayoutEffect, useRef, cloneElement } from 'react'

// Shared page geometry -- exported so every consumer (currently
// QuotationPaper in Quotations.jsx and DocumentPaper in Invoices.jsx)
// builds its real page-div from these exact same numbers
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

// The real page-div's <table> (rows) sits this far below the header/
// doc-info block -- baked in here, and subtracted from the row budget
// below, so every page's available row space accounts for it explicitly
// instead of silently eating into the page-div's bottom padding (which is
// what happened before this constant existed: the gap was real in the
// final render but invisible to the budget math, quietly eroding the
// safety margin PAGE_HEIGHT_PX's own comment describes).
export const TABLE_MARGIN_TOP_PX = 18

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
// into pages that fit PAGE_HEIGHT_PX minus the (measured) header,
// table-header, and TABLE_MARGIN_TOP_PX, which repeat identically on every
// page.
//
// `renderFooter` is optional and describes content (e.g. totals/notes/
// signature) that a consumer renders ONLY on the actual last page, in the
// same page-div as the rows -- if provided, its measured height is reserved
// out of the LAST page's budget specifically (every other page keeps the
// full budget). Without this, a fixed-height last page-div has nowhere for
// an over-budget footer to go (no shrink-to-fit safety net the way a
// `minHeight` div would have had). The returned `pages` array is
// constructed so the footer's home is ALWAYS `pages[pages.length - 1]` --
// callers don't need to track a separate "which page has the footer" index.
//
// `remeasureKey` is optional: an extra value (in addition to `items`) that,
// when it changes, triggers a fresh measurement pass. Needed because
// `renderHeader`/`renderFooter` can depend on things that resolve
// asynchronously AFTER `items` has already settled (e.g. a signature image
// URL fetched from storage) -- without a way to say "remeasure now", the
// hidden pass permanently under-measures by whatever that async content
// contributes. Pass something that's referentially stable until the
// async-dependent content actually changes (e.g. a signed URL string, or a
// composite key built from a couple of them) -- do NOT pass a value that
// changes every render. Since the `measured` check below compares
// `heights.measuredKey === remeasureKey`, an unstable key doesn't just
// waste work re-measuring -- it makes `measured` permanently false on
// every render, which remounts the hidden measurement pass every render,
// which fires the layout effect every render, which calls `setState`
// every render: an unbounded render loop, not just wasted work.
export function usePaginatedDocument({
  items, renderHeader, renderTableHeader, renderRow, renderFooter, remeasureKey,
  pageWidth = PAGE_WIDTH_PX,
  pagePaddingCss = PAGE_PADDING_CSS,
  pageHeight = PAGE_HEIGHT_PX,
  tableMarginTop = TABLE_MARGIN_TOP_PX,
}) {
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
    // measuredKey records which remeasureKey this measurement was taken
    // under -- see the `measured` check below for why this is load-bearing,
    // not just bookkeeping.
    setHeights({ headerHeight, tableHeaderHeight, footerHeight, rowHeights, measuredKey: remeasureKey })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, remeasureKey])

  // Real bug found and fixed here: `measured` used to check ONLY
  // `heights.rowHeights.length === items.length`, never comparing against
  // the current `remeasureKey`. Once a first measurement had landed,
  // `measured` stayed true forever regardless of `items.length` -- so the
  // hidden measurementNode branch below (the only place headerRef/
  // tableHeaderRef/footerRef/rowRefs actually mount) never rendered again,
  // and the useLayoutEffect above early-returned every time on
  // `!headerRef.current`. Net effect: changing `remeasureKey` after the
  // first successful measurement was a silent no-op -- the exact opposite
  // of this hook's documented contract (see the `remeasureKey` comment
  // above). Comparing `heights.measuredKey` here forces `measured` back to
  // false the instant `remeasureKey` changes, which remounts the hidden
  // pass, re-attaches fresh refs, and lets the effect above populate a new
  // `heights` (tagged with the new key) -- restoring the documented
  // behavior. Caught live: a DocumentPaper footer (see Invoices.jsx) that
  // grew ~65px after a mid-session bank-account selection rendered ~11px
  // past its fixed-height page-div's bottom edge because the reserved
  // footer budget never updated.
  const measured = heights && heights.rowHeights.length === items.length && heights.measuredKey === remeasureKey

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
        <div style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: -99999, width: pageWidth, padding: pagePaddingCss, boxSizing: 'border-box', zIndex: -1 }}>
          <div ref={headerRef}>{renderHeader()}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: tableMarginTop }}>
            <thead ref={tableHeaderRef}>{renderTableHeader()}</thead>
            <tbody>
              {items.map((it, i) => cloneElement(renderRow(it, i), { ref: el => { rowRefs.current[i] = el } }))}
            </tbody>
          </table>
          {renderFooter && (
            // display:'flow-root' establishes a new block-formatting
            // context for this wrapper, which makes its own box capture
            // the footer's first child's marginTop the same way the real
            // render does (there, the footer's children are direct flex
            // items of a column-flex container, and flex items never
            // margin-collapse with anything). Without this, a plain <div>
            // wrapper here lets that marginTop collapse OUT of the
            // measured height, under-measuring the footer vs. how it
            // really renders.
            <div ref={footerRef} style={{ display: 'flow-root' }}>{renderFooter()}</div>
          )}
        </div>
      ),
    }
  }

  const availableRegular = pageHeight - heights.headerHeight - heights.tableHeaderHeight - tableMarginTop

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
  // last page, so that page alone needs a smaller budget -- `availableLast`
  // -- to leave the footer room underneath it.
  if (renderFooter) {
    if (heights.footerHeight <= availableRegular) {
      const availableLast = availableRegular - heights.footerHeight
      const last = pages[pages.length - 1]
      // Find the maximal TRAILING run of the last page's rows whose
      // combined height still fits within availableLast -- that run is
      // what stays on the true final (footer-bearing) page. Everything
      // before it in this page spills backward onto a new page inserted
      // just ahead of it, which only ever needs the regular per-page
      // budget (guaranteed, since it's a subset of a page that already
      // fit within availableRegular in the first pass above). This always
      // terminates in a single pass over `last` (no unbounded looping),
      // and always succeeds -- worst case the trailing run is empty (the
      // footer gets a page with zero item rows of its own), which fits
      // because we've already confirmed footerHeight <= availableRegular.
      let keepHeight = 0
      let splitIndex = last.length
      for (let i = last.length - 1; i >= 0; i--) {
        const nextHeight = keepHeight + last[i].h
        if (nextHeight > availableLast) break
        keepHeight = nextHeight
        splitIndex = i
      }
      if (splitIndex > 0) {
        const overflow = last.splice(0, splitIndex) // mutates `last` down to just its fitting trailing run
        pages.splice(pages.length - 1, 0, overflow) // insert the spilled head as a new page just before it
      }
    } else {
      // The footer alone is taller than a full page's regular row budget
      // -- an extreme amount of payment-terms/notes text. No amount of
      // row-shuffling can make room for it alongside any item row, so give
      // it a fully dedicated trailing page (zero items). That page's own
      // fixed height may still not be quite enough for content this
      // long -- there's no more page to give it -- but this is the best
      // any pagination scheme can do short of shrinking the text itself,
      // and it's a documented, extreme-input-only residual limit rather
      // than the routine case Critical 2 was originally about.
      pages.push([])
    }
  }

  // Guard against a gratuitous blank leading page: when there were never
  // any items to begin with (items.length === 0) and the footer alone is
  // taller than a full page's row budget, the branch above pushes a
  // dedicated footer-only trailing page onto `pages`, which already
  // contains the empty `current` page pushed by the first pass -- leaving
  // `pages` as `[[], []]` (an empty first page nobody needed, then the real
  // footer page) instead of just `[[]]`. Only drop it when items.length is
  // actually 0 -- a legitimately empty NON-first page from the routine
  // item-count case must never be removed.
  if (items.length === 0 && pages.length > 1 && pages[0].length === 0) {
    pages.shift()
  }

  return { pages: pages.map(p => p.map(r => r.it)), pageCount: pages.length, measurementNode: null }
}
