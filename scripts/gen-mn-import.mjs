// One-off generator (2026-10-17, owner: "MN first"): MN (บจก. แม่น้ำเมทอลซัพพลาย) aluminium catalogue -> guarded datafix.
// Reads the extracted JSON under docs/catalogs/ (no DB access) and writes, deterministically:
//   supabase/datafix/2026-10-17-import-mn-catalogue.sql   (run via .superpowers/sdd/2026-10-17-mn-import/run-mn-import-dryrun.sh first)
//   docs/catalogs/mn/IMPORT-REPORT.md                     (counts, every exclusion, ambiguous links, owner questions)
// Usage: node scripts/gen-mn-import.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImport, renderSql, renderReport, expectedCounts } from './mn-import-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

const catalog = read('docs/catalogs/mn/mn-aluminium-profile-2021.json')
const pricebook = read('docs/catalogs/sms/mn-pricelist-2024.json')
const setsDir = 'docs/catalogs/mn-sets'
const sets = {}
for (const f of fs.readdirSync(path.join(root, setsDir)).filter(f => /^mn\d\d-.*\.json$/.test(f)).sort()) sets[f.slice(0, 4)] = read(`${setsDir}/${f}`)

const model = buildImport({ catalog, pricebook, sets })
const sqlPath = path.join(root, 'supabase/datafix/2026-10-17-import-mn-catalogue.sql')
const reportPath = path.join(root, 'docs/catalogs/mn/IMPORT-REPORT.md')
fs.writeFileSync(sqlPath, renderSql(model))
fs.writeFileSync(reportPath, renderReport(model))
console.log('expected counts', expectedCounts(model))
console.log('excluded price cells', model.priceExcl.length, '| excluded profiles', model.excludedProfiles.length)
console.log('wrote', path.relative(root, sqlPath), 'and', path.relative(root, reportPath))
