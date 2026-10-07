// supabase mock for the PO page harness: chainable, resolves empty; writes and rpc calls are logged in window.__log.
const W = window
W.__log = W.__log || []
const builder = (table) => {
  const p = new Proxy(function () {}, {
    get(_, k) {
      if (k === 'then') return res => Promise.resolve({ data: [], error: null }).then(res)
      return (...a) => { if (['update', 'insert', 'delete'].includes(k)) W.__log.push([k, table, JSON.stringify(a[0] ?? null)]); return p }
    },
  })
  return p
}
export const supabase = {
  from: t => builder(t),
  rpc: (name, args) => { W.__log.push(['rpc', name, JSON.stringify(args)]); return Promise.resolve({ data: null, error: W.__rpcError || null }) },
  auth: { getSession: async () => ({ data: { session: { user: { email: 'o@x.y' } } } }) },
  functions: { invoke() { throw new Error('NETWORK invoke') } },
  storage: { from() { throw new Error('NETWORK storage') } },
}
export const fmt = (n, decimals = 2) => { if (n == null || isNaN(n)) return '—'; return Number(n).toLocaleString('th-TH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) }
export const fmtDate = d => { if (!d) return '—'; return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) }
