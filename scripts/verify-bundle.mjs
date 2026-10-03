// Refuses to let a build ship if it talks to the wrong Supabase project.
// Why: on 2026-10-03 three deploys went out pointing at the old Tokyo project
// because the gitignored .env still held its values. The site answered 200,
// so nothing looked wrong until login failed. Run after `vite build`,
// before `wrangler deploy` (the `deploy` npm script does both).
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_REF = 'kntspldhvcjeaubtqtkn' // CHANG (Singapore)
export const FORBIDDEN_REFS = ['yyzbgdmgyvvypfcjuhtr'] // old Tokyo project

export function checkBundle(texts) {
  const all = texts.join('\n')
  const problems = []
  if (!all.includes(REQUIRED_REF)) {
    problems.push(`bundle does not reference the CHANG project (${REQUIRED_REF}) -- check VITE_SUPABASE_URL in .env`)
  }
  for (const ref of FORBIDDEN_REFS) {
    if (all.includes(ref)) problems.push(`bundle still references the retired project ${ref} -- check .env`)
  }
  return problems
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets')
  let files
  try { files = readdirSync(dir).filter(f => f.endsWith('.js')) } catch { files = [] }
  if (!files.length) {
    console.error('verify-bundle: no dist/assets/*.js found -- run `npm run build` first')
    process.exit(1)
  }
  const problems = checkBundle(files.map(f => readFileSync(join(dir, f), 'utf8')))
  if (problems.length) {
    problems.forEach(p => console.error('verify-bundle: ' + p))
    process.exit(1)
  }
  console.log('verify-bundle: OK (points at CHANG, no retired project)')
}
