#!/usr/bin/env node
// Compare two layout fingerprints (scripts/layout-fingerprint.browser.js output saved as JSON).
// Usage: node scripts/layout-fingerprint-diff.mjs before.json after.json [--tolerance=1]
// Exit 1 when any page differs; prints up to 20 differing elements per page.
import { readFileSync } from 'node:fs'

const [,, beforePath, afterPath, ...flags] = process.argv
if (!beforePath || !afterPath) { console.error('usage: layout-fingerprint-diff before.json after.json [--tolerance=px]'); process.exit(2) }
const tol = Number((flags.find(f => f.startsWith('--tolerance=')) || '--tolerance=1').split('=')[1])
const a = JSON.parse(readFileSync(beforePath, 'utf8')), b = JSON.parse(readFileSync(afterPath, 'utf8'))

export function diffPages(before, after, tolerance = 1) {
  const report = {}
  const names = new Set([...Object.keys(before.pages || {}), ...Object.keys(after.pages || {})])
  for (const name of names) {
    const x = before.pages?.[name], y = after.pages?.[name]
    const diffs = []
    if (!x || !y || x.error || y.error) { report[name] = [{ note: `missing or errored: before=${!!x && !x.error} after=${!!y && !y.error}` }]; continue }
    const byPath = new Map(x.map(e => [e.path, e]))
    const seen = new Set()
    for (const e of y) {
      seen.add(e.path)
      const o = byPath.get(e.path)
      if (!o) { diffs.push({ path: e.path, note: 'new element', tag: e.tag, cls: e.cls }); continue }
      if (o.tag !== e.tag || o.cls !== e.cls) { diffs.push({ path: e.path, note: 'tag/class', before: `${o.tag}.${o.cls}`, after: `${e.tag}.${e.cls}` }); continue }
      const rectOff = o.rect.some((v, i) => Math.abs(v - e.rect[i]) > tolerance)
      const styleOff = o.st.some((v, i) => v !== e.st[i])
      if (rectOff || styleOff) diffs.push({ path: e.path, note: rectOff ? 'rect' : 'style', before: rectOff ? o.rect : o.st, after: rectOff ? e.rect : e.st })
    }
    for (const e of x) if (!seen.has(e.path)) diffs.push({ path: e.path, note: 'removed element', tag: e.tag, cls: e.cls })
    if (diffs.length) report[name] = diffs
  }
  return report
}

const report = diffPages(a, b, tol)
const names = Object.keys(report)
if (!names.length) { console.log(`layout-fingerprint: no differences (${Object.keys(a.pages || {}).length} pages, tolerance ${tol}px)`); process.exit(0) }
for (const name of names) {
  console.log(`\n== ${name}: ${report[name].length} difference(s)`)
  for (const d of report[name].slice(0, 20)) console.log('  ', JSON.stringify(d))
}
process.exit(1)
