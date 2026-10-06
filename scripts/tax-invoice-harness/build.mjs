// Bundles the supplier tax invoice PAGE with mocked hooks / supabase into <tmpdir>/tax-invoice-harness-out.js.
// Usage: node scripts/tax-invoice-harness/build.mjs   (see README.md)
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const WT = path.resolve(H, '../..')
export const OUT = path.join(tmpdir(), 'tax-invoice-harness-out.js')
await build({
  entryPoints: [H + 'entry.jsx'], bundle: true, outfile: OUT, format: 'iife', jsx: 'automatic',
  nodePaths: [WT + '/node_modules'], define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'warning',
  plugins: [{ name: 'mock', setup(b) {
    b.onResolve({ filter: /^SRC\// }, a => ({ path: WT + '/src/' + a.path.slice(4) }))
    b.onResolve({ filter: /hooks\/useUserRole\.js$/ }, () => ({ path: H + 'useRoleMock.js' }))
    b.onResolve({ filter: /hooks\/useSupabase\.js$/ }, () => ({ path: H + 'mockHooks.js' }))
    b.onResolve({ filter: /components\/QuickAddSelect\.jsx$|^\.\/QuickAddSelect\.jsx$/ }, () => ({ path: H + 'MockQuickAdd.jsx' }))
    b.onResolve({ filter: /(^|\/)supabase\.js$/ }, a => a.importer.includes('/src/') ? { path: H + 'mockSupabaseLib.js' } : undefined)
  } }],
})
console.log('built', OUT)
