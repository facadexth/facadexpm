export const supabase = { from() { throw new Error('NETWORK: supabase.from called') }, rpc() { throw new Error('NETWORK rpc') }, functions: { invoke() { throw new Error('NETWORK invoke') } } }
export const fmt = (n, decimals = 2) => { if (n == null || isNaN(n)) return '—'; return Number(n).toLocaleString('th-TH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) }
export const fmtDate = d => { if (!d) return '—'; return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) }
