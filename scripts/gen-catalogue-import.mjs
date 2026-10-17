// One-off generator (2026-10-17): supplier catalogue JSON (docs/catalogs/) -> guarded datafix + report, per config in
// scripts/catalogue-import-configs.mjs. No DB access. Usage: node scripts/gen-catalogue-import.mjs [id ...]  (default: all)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImport, renderSql, renderReport, expectedCounts } from './catalogue-import-lib.mjs'
import { CONFIGS, loadInputs } from './catalogue-import-configs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const want = process.argv.slice(2)
for (const cfg of CONFIGS.filter(c => !want.length || want.includes(c.id))) {
  const m = buildImport(cfg, loadInputs(cfg))
  fs.writeFileSync(path.join(root, cfg.sqlFile), renderSql(m))
  fs.writeFileSync(path.join(root, cfg.reportFile), renderReport(m))
  console.log(cfg.id, JSON.stringify(expectedCounts(m)), '| not imported', m.excluded.length, '| reprints', m.reprints.length, '| no series', m.seriesNotCreated.length)
}
