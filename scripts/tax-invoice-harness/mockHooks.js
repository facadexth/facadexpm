import { useState, useEffect, useCallback } from 'react'
const W = window
W.__log = W.__log || []
// exact replica of the real useQuery (keeps stale data across dep changes)
function useQuery(fn, deps = []) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null)
  const f = useCallback(async () => { setLoading(true); setError(null); try { const r = await fn(); setData(r) } catch (e) { setError(e.message) } finally { setLoading(false) } }, deps) // eslint-disable-line
  useEffect(() => { f() }, [f])
  return { data, loading, error, refetch: f }
}
const delay = (v, ms = 30) => new Promise(r => setTimeout(() => r(typeof v === 'function' ? v() : v), ms))
const D = () => W.__data
export const useSuppliers = () => useQuery(() => delay(D().suppliers))
export const useSites = () => useQuery(() => delay(D().sites))
export const useCategories = () => useQuery(() => delay(D().categories))
export const useInventoryItems = () => useQuery(() => delay(() => D().items.filter(i => i.active !== false)))
export const useAllInventoryItems = () => useQuery(() => delay(() => [...D().items]))
export const useInventoryItemUnitFactors = () => useQuery(() => delay(D().factors))
export const useActiveTaxInvoiceLinks = () => useQuery(() => delay(new Map(D().links)))
export function useReceivedPosForSupplier(supplierId) {
  return useQuery(() => { W.__log.push(['pos', String(supplierId)]); return delay(() => ({ supplierId: supplierId || '', rows: supplierId ? D().pos.filter(p => p.supplier_id === supplierId && p.status === 'received') : [] }), (D().posDelay || 30)) }, [supplierId])
}
export function useSupplierDeposits(supplierId) { return useQuery(() => delay(D().deposits), [supplierId]) }
export function useSupplierDocumentExamples(supplierId) { return useQuery(() => delay([]), [supplierId]) }
export async function extractPoDocument(b64, mime, ex) { W.__log.push(['extract', mime, ex.length]); return W.__extract ? W.__extract() : { ok: false, error: 'x' } }

// ---- page hooks ----
const NR = 'Could not find the table \'public.supplier_tax_invoices\' in the schema cache'
export function useSupplierTaxInvoices(filters = {}) {
  const r = useQuery(async () => {
    await delay(null, 20)
    if (W.__notReady) throw new Error(NR)
    return (W.__invoices || []).filter(i => (!filters.supplierId || i.supplier_id === filters.supplierId) && (!filters.status || i.status === filters.status))
  }, [JSON.stringify(filters), W.__invVersion])
  return { ...r, notReady: !!W.__notReady }
}
export function useSupplierTaxInvoice(id) {
  const r = useQuery(async () => { if (!id) return null; await delay(null, 20); return (W.__invoices || []).find(i => i.id === id) || null }, [id])
  return { ...r, notReady: false }
}
const call = (name, args) => { W.__log.push(['rpc', name, JSON.stringify(args)]); const f = W.__rpc && W.__rpc[name]; return new Promise((res, rej) => setTimeout(() => { try { res(f ? f(...args) : null) } catch (e) { rej(e) } }, W.__rpcDelay || 60)) }
export const saveSupplierTaxInvoiceDraft = (...a) => call('save', a)
export const previewSupplierTaxInvoice = (...a) => call('preview', a)
export const postSupplierTaxInvoice = (...a) => call('post', a)
export const voidSupplierTaxInvoice = (...a) => call('void', a)
export const deleteSupplierTaxInvoiceDraft = (...a) => call('delete', a)
