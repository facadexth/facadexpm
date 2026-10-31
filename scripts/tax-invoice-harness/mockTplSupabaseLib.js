// supabase mock for the document-templates admin page harness: tables resolve to window.__tables[table], rpc to window.__rpc[name]; writes are logged in window.__log.
const W = window
W.__log = W.__log || []
const builder = (table) => {
  const p = new Proxy(function () {}, {
    get(_, k) {
      if (k === 'then') return res => Promise.resolve({ data: (W.__tables || {})[table] ?? [], error: null }).then(res)
      return (...a) => {
        if (['update', 'insert', 'delete', 'upsert'].includes(k)) W.__log.push([k, table, JSON.stringify(a[0] ?? null)])
        return p
      }
    },
  })
  return p
}
export const supabase = {
  from: t => builder(t),
  rpc: (name, args) => { W.__log.push(['rpc', name, JSON.stringify(args)]); return Promise.resolve({ data: (W.__rpc || {})[name] ?? null, error: null }) },
  storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: p => ({ data: { publicUrl: p } }) }) },
  auth: { getUser: async () => ({ data: { user: { email: 'admin@example.com' } } }) },
}
export const fmt = (n, d = 2) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
export const fmtDate = d => (d ? new Date(d).toLocaleDateString('th-TH') : '')
