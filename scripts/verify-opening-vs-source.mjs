// Checks the FacadeX 2026 opening stock in the database against its import source,
// before the OB2601-001 datafix (supabase/datafix/2026-10-26-06-facadex-ob.sql) runs.
//
// Usage:
//   node scripts/verify-opening-vs-source.mjs <source.xlsx> <opening.csv>
//
//   <source.xlsx>  ยอดยกมาต้นปี_2569.xlsx (main checkout root): the machine-readable sheet
//                  built from the 31 ธ.ค. 2568 PDF. Sheet 1, data from row 5:
//                  A code (blank so far) | B name | C unit | D qty | E unit cost |
//                  F value | G category | H notes ("รหัสเดิม: <code>; PDF หน้า <n>").
//                  The item code is column A, or the "รหัสเดิม:" code in the notes.
//   <opening.csv>  read-only export of the opening movements, header row
//                  item_code,item_name,qty,unit_cost  (one row per movement), e.g.
//                    SELECT ii.code AS item_code, ii.name AS item_name,
//                           m.quantity AS qty, m.unit_cost
//                    FROM stock_movements m JOIN inventory_items ii ON ii.id = m.inventory_item_id
//                    WHERE m.tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'
//                      AND m.reference_type = 'opening_balance';
//
// Rows are grouped per item on both sides (qty summed, unit cost = value / qty), then
// joined on item code; whatever is left unmatched is joined again on the item name
// (trimmed, whitespace collapsed). Prints every item whose qty or unit cost differs by
// more than 0.01, every item found on one side only, and summary counts.
// Exit 0 = no mismatches, 1 = mismatches, 2 = bad input.
//
// Spreadsheet reading uses the `xlsx` package already in package.json (no new deps).
import { readFileSync } from 'node:fs'
import XLSX from 'xlsx'

const TOLERANCE = 0.01

const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return 0
  const n = Number(String(v).replace(/,/g, ''))
  if (Number.isNaN(n)) throw new Error(`not a number: ${JSON.stringify(v)}`)
  return n
}

// ---- source workbook -------------------------------------------------------
function readSource(path) {
  const wb = XLSX.readFile(path)
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })
  const out = []
  rows.slice(4).forEach((r, i) => {
    const name = normName(r[1])
    if (!name) return // blank line
    const fromNotes = /รหัสเดิม:\s*([^;]+)/.exec(String(r[7] ?? ''))
    const code = String(r[0] ?? '').trim() || (fromNotes ? fromNotes[1].trim() : '')
    out.push({ line: i + 5, code, name, qty: num(r[3]), unitCost: num(r[4]) })
  })
  return out
}

// ---- opening CSV (minimal RFC 4180: quoted fields, "" escapes, commas/newlines in quotes)
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

function readOpening(path) {
  const [header, ...data] = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]))
  for (const need of ['item_code', 'item_name', 'qty', 'unit_cost']) {
    if (!(need in col)) throw new Error(`CSV is missing column "${need}" (has: ${header.join(', ')})`)
  }
  return data.map((r, i) => ({
    line: i + 2,
    code: String(r[col.item_code] ?? '').trim(),
    name: normName(r[col.item_name]),
    qty: num(r[col.qty]),
    unitCost: num(r[col.unit_cost]),
  }))
}

// ---- group one side per item --------------------------------------------------
// key = code when present, else "name:<name>". Several rows of one item (e.g. two
// sites) are summed; unit cost becomes the value-weighted average.
function group(rows) {
  const items = new Map()
  for (const r of rows) {
    const key = r.code || `name:${r.name}`
    const g = items.get(key) ?? { code: r.code, name: r.name, qty: 0, value: 0, rows: 0 }
    g.qty += r.qty
    g.value += r.qty * r.unitCost
    g.rows += 1
    items.set(key, g)
  }
  for (const g of items.values()) g.unitCost = g.qty !== 0 ? g.value / g.qty : 0
  return items
}

function compare(src, db) {
  const pairs = [] // [srcItem, dbItem, matchedBy]
  const srcLeft = new Map(src), dbLeft = new Map(db)

  for (const [key, s] of src) {
    if (s.code && db.has(key)) {
      pairs.push([s, db.get(key), 'code'])
      srcLeft.delete(key); dbLeft.delete(key)
    }
  }
  // second pass: by name, only where the name is unique on both remaining sides
  const byName = (m) => {
    const idx = new Map()
    for (const [k, g] of m) idx.set(g.name, idx.has(g.name) ? null : k)
    return idx
  }
  const srcNames = byName(srcLeft), dbNames = byName(dbLeft)
  for (const [name, sk] of srcNames) {
    const dk = dbNames.get(name)
    if (sk && dk) {
      pairs.push([srcLeft.get(sk), dbLeft.get(dk), 'name'])
      srcLeft.delete(sk); dbLeft.delete(dk)
    }
  }
  return { pairs, srcOnly: [...srcLeft.values()], dbOnly: [...dbLeft.values()] }
}

// ---- main ----------------------------------------------------------------------
const [srcPath, csvPath] = process.argv.slice(2)
if (!srcPath || !csvPath) {
  console.error('usage: node scripts/verify-opening-vs-source.mjs <source.xlsx> <opening.csv>')
  process.exit(2)
}

let srcRows, dbRows
try {
  srcRows = readSource(srcPath)
  dbRows = readOpening(csvPath)
} catch (e) {
  console.error(`cannot read input: ${e.message}`)
  process.exit(2)
}

const { pairs, srcOnly, dbOnly } = compare(group(srcRows), group(dbRows))
const fmt = (n) => Number(n.toFixed(4)).toString()
const label = (g) => `${g.code || '(no code)'}  ${g.name}`

const diffs = pairs.filter(([s, d]) =>
  Math.abs(s.qty - d.qty) > TOLERANCE || Math.abs(s.unitCost - d.unitCost) > TOLERANCE)
// a zero-qty source line with no movement is fine (nothing was brought forward)
const srcMissing = srcOnly.filter((s) => Math.abs(s.qty) > TOLERANCE)
const srcZeroSkipped = srcOnly.length - srcMissing.length

if (diffs.length) {
  console.log(`\n== qty / unit-cost differences (${diffs.length}) ==`)
  for (const [s, d, by] of diffs) {
    console.log(`${label(s)}   [matched by ${by}${by === 'name' ? `, db code ${d.code || '-'}` : ''}]`)
    if (Math.abs(s.qty - d.qty) > TOLERANCE) {
      console.log(`    qty        source ${fmt(s.qty)}  db ${fmt(d.qty)}  diff ${fmt(d.qty - s.qty)}`)
    }
    if (Math.abs(s.unitCost - d.unitCost) > TOLERANCE) {
      console.log(`    unit cost  source ${fmt(s.unitCost)}  db ${fmt(d.unitCost)}  diff ${fmt(d.unitCost - s.unitCost)}`)
    }
  }
}
if (srcMissing.length) {
  console.log(`\n== in source, no opening movement (${srcMissing.length}) ==`)
  for (const s of srcMissing) console.log(`${label(s)}   qty ${fmt(s.qty)}  unit cost ${fmt(s.unitCost)}`)
}
if (dbOnly.length) {
  console.log(`\n== opening movement, not in source (${dbOnly.length}) ==`)
  for (const d of dbOnly) console.log(`${label(d)}   qty ${fmt(d.qty)}  unit cost ${fmt(d.unitCost)}`)
}

const total = (rows) => rows.reduce((t, r) => t + r.qty * r.unitCost, 0)
const byCode = pairs.filter((p) => p[2] === 'code').length
console.log('\n== summary ==')
console.log(`source lines            ${srcRows.length}`)
console.log(`opening movement rows   ${dbRows.length}`)
console.log(`items matched           ${pairs.length}  (by code ${byCode}, by name ${pairs.length - byCode})`)
console.log(`qty/cost differences    ${diffs.length}`)
console.log(`source only             ${srcMissing.length}  (+ ${srcZeroSkipped} zero-qty source lines ignored)`)
console.log(`db only                 ${dbOnly.length}`)
console.log(`total value  source ${total(srcRows).toFixed(2)}  db ${total(dbRows).toFixed(2)}`)

const mismatches = diffs.length + srcMissing.length + dbOnly.length
console.log(mismatches ? `\nFAIL: ${mismatches} mismatch(es)` : '\nOK: opening matches the source')
process.exit(mismatches ? 1 : 0)
