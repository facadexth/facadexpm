// One-off generator (2026-10-17, owner: "ทำ Smart Plus ต่อเลย ไม่มี profile general"): SMART PLUS (บจก. รัตนดำรงค์)
// aluminium catalogue -> guarded datafix. Reads the extracted JSON under docs/catalogs/smartplus/ (no DB access) and writes:
//   supabase/datafix/2026-10-17-import-smartplus-catalogue.sql  (dry run first: .superpowers/sdd/2026-10-17-sp-import/run-sp-import-dryrun.sh)
//   docs/catalogs/smartplus/IMPORT-REPORT.md                    (counts, exclusions, cut sheets, owner questions)
// Usage: node scripts/gen-sp-import.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImport, renderSql, renderReport, expectedCounts } from './sp-import-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

const model = buildImport({ catalog: read('docs/catalogs/smartplus/smart-plus-2024.json'), cuts: read('docs/catalogs/smartplus/smart-plus-cut-formulas-2022.json') })
const sqlPath = path.join(root, 'supabase/datafix/2026-10-17-import-smartplus-catalogue.sql')
const reportPath = path.join(root, 'docs/catalogs/smartplus/IMPORT-REPORT.md')
fs.writeFileSync(sqlPath, renderSql(model))
fs.writeFileSync(reportPath, renderReport(model))
console.log('expected counts', expectedCounts(model))
console.log('excluded profiles', model.excludedProfiles.length, '| reprint diffs', model.reprints.length, '| cut sheets', model.cutSheets.length)
console.log('wrote', path.relative(root, sqlPath), 'and', path.relative(root, reportPath))
