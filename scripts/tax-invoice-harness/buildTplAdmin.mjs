// Bundles DocumentTemplatesAdmin (hooks stubbed) into <tmpdir>/tpladmin-harness-out.js. Hook stubs are generated from the real useSupabase.js export list.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const WT = path.resolve(H, '../..')
export const OUT = path.join(tmpdir(), 'tpladmin-harness-out.js')
const names = [...readFileSync(WT + '/src/hooks/useSupabase.js', 'utf8').matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(m => m[1])
const stubSource = names.map(n => {
  if (n === 'useMySignatureUrl') return `export const ${n} = () => null`
  if (n === 'useMyWorkerName') return `export const ${n} = () => ({ data: null })`
  return `export const ${n} = () => ({ data: null, loading: false, error: null, refetch: () => {} })`
}).join('\n')
await build({
  entryPoints: [H + 'entryTplAdmin.jsx'], bundle: true, outfile: OUT, format: 'iife', jsx: 'automatic',
  nodePaths: [WT + '/node_modules'], define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'warning',
  plugins: [{ name: 'mock', setup(b) {
    b.onResolve({ filter: /^SRC\// }, a => ({ path: WT + '/src/' + a.path.slice(4) }))
    b.onResolve({ filter: /hooks\/useUserRole\.js$/ }, () => ({ path: H + 'useRoleMock.js' }))
    b.onResolve({ filter: /hooks\/useTenant\.js$/ }, () => ({ path: H + 'mockTenant.js' }))
    b.onResolve({ filter: /hooks\/useSupabase\.js$/ }, () => ({ path: 'useSupabaseStub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stubSource, loader: 'js' }))
    b.onResolve({ filter: /\/Sites\.jsx$/ }, () => ({ path: 'sitesStub', namespace: 'sites' }))
    b.onLoad({ filter: /.*/, namespace: 'sites' }, () => ({ contents: 'export const SiteForm = () => null; export const siteFormToPayload = () => ({})', loader: 'js' }))
    b.onResolve({ filter: /(^|\/)supabase\.js$/ }, a => a.importer.includes('/src/') ? { path: H + 'mockTplSupabaseLib.js' } : undefined)
  } }],
})
console.log('built', OUT)
