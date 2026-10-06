import { useState, useEffect, useCallback } from 'react'
const W = window
W.__log = W.__log || []
function useQuery(fn, deps = []) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null)
  const f = useCallback(async () => { setLoading(true); setError(null); try { setData(await fn()) } catch (e) { setError(e.message) } finally { setLoading(false) } }, deps) // eslint-disable-line
  useEffect(() => { f() }, [f])
  return { data, loading, error, refetch: f }
}
const delay = (v, ms = 20) => new Promise(r => setTimeout(() => r(typeof v === 'function' ? v() : v), ms))
const D = () => W.__data
export const usePurchaseOrders = () => useQuery(() => delay(() => D().pos), [W.__posVersion])
export const useSites = () => useQuery(() => delay(D().sites))
export const useSuppliers = () => useQuery(() => delay(D().suppliers))
export const useCategories = () => useQuery(() => delay(D().categories))
export const useUnits = () => useQuery(() => delay([]))
export const useInventoryItems = () => useQuery(() => delay(D().items))
export const useAllInventoryItems = () => useQuery(() => delay(D().items))
export const useInventoryItemUnitFactors = () => useQuery(() => delay([]))
export const useStockBalances = () => useQuery(() => delay([]))
export const useAluminumProfiles = () => useQuery(() => delay([]))
export const useAllAluminumProfiles = () => useQuery(() => delay([]))
export const useMySignatureUrl = () => null
export const useMyWorkerName = () => ({ data: null })
export const useSupplierDocumentExamples = () => useQuery(() => delay([]))
export const useSupplierDeposits = () => useQuery(() => delay([]))
export const extractPoDocument = async () => ({ ok: false })
export const saveSupplierDocumentExample = async () => {}
export const receivePoWithDeposits = async (...a) => { W.__log.push(['rpc', 'receive_po_with_deposits', JSON.stringify(a)]); return 'exp1' }
// null = not ready (links hook errors before the migration / still loading); a Map = live
export const useActiveTaxInvoiceLinks = () => useQuery(() => delay(() => (W.__links ? new Map(W.__links) : null)), [W.__linksVersion])
