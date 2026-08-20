// ============================================================
// Excel export -- shared by any page that wants a "export to Excel"
// button. Exports exactly the rows the caller passes in (already
// filtered by that page's own active filters -- this module does no
// filtering of its own), with real numeric/date cells rather than the
// formatted display strings shown on screen.
// ============================================================
import * as XLSX from 'xlsx'

/**
 * Pure row-shaping step: maps `rows` through `columns`' accessors into
 * plain objects keyed by each column's header, in column-definition
 * order. Exported separately from exportToExcel so this logic --  the
 * only part worth automated testing -- can be tested without triggering
 * a real file download.
 */
export function buildExportRows(rows, columns) {
  return rows.map(row => {
    const out = {}
    for (const col of columns) {
      out[col.header] = col.accessor(row)
    }
    return out
  })
}

function timestamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * Builds a single-sheet workbook from `rows`/`columns` (see
 * buildExportRows) and triggers a browser download named
 * `${filenameBase}_${timestamp}.xlsx`. cellDates:true makes any
 * accessor that returns a JS Date write as a real Excel date cell
 * instead of a bare serial number or string.
 */
export function exportToExcel(rows, columns, filenameBase) {
  const data = buildExportRows(rows, columns)
  const worksheet = XLSX.utils.json_to_sheet(data, { cellDates: true })
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  XLSX.writeFile(workbook, `${filenameBase}_${timestamp()}.xlsx`)
}
