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
export const useSupplierDeposits = () => useQuery(() => delay(() => W.__deposits || []))
export const extractPoDocument = async () => W.__extract || { ok: false }
export const saveSupplierDocumentExample = async () => {}
export const receivePoWithDeposits = async (...a) => { W.__log.push(['rpc', 'receive_po_with_deposits', JSON.stringify(a)]); return 'exp1' }
// null = not ready (links hook errors before the migration / still loading); a Map = live
export const useActiveTaxInvoiceLinks = () => useQuery(() => delay(() => (W.__links ? new Map(W.__links) : null)), [W.__linksVersion])

// ── 2026-10-09 PO receipts (Task 6). W.__money: [[poId, {receivedItemIds:[...], depositId}]] or null (= not ready);
// W.__ledger: {[poId]: {receipts, deposit, applications, bills}}; W.__deposits: useSupplierDeposits rows;
// W.__wrapperError: thrown by the RPC wrappers; every wrapper call is logged as ['rpc', name, args].
export const usePoMoneyIndex = () => useQuery(() => delay(() => (W.__money === null ? null
  : new Map((W.__money || []).map(([k, v]) => [k, { receivedItemIds: new Set(v.receivedItemIds || []), depositId: v.depositId || null }])))), [W.__moneyVersion])
export const usePoLedger = (poId) => useQuery(() => delay(() => (W.__ledger || {})[poId] || { receipts: [], deposit: null, applications: [], bills: [] }), [poId, W.__ledgerVersion])
const wrapper = (name, result) => async (args) => {
  W.__log.push(['rpc', name, JSON.stringify(args)])
  if (W.__wrapperDelay) await new Promise(r => setTimeout(r, W.__wrapperDelay))
  if (W.__wrapperError) throw W.__wrapperError
  return typeof result === 'function' ? result(args) : result
}
export const createPoDeposit = wrapper('create_po_deposit', () => W.__depositResult || { deposit_id: 'dnew', expense_id: 'enew', amount: 0, amount_no_vat: 0, vat: 0, pct_of_po: 0 })
export const receivePoLines = wrapper('receive_po_lines', () => W.__receiveResult || { receipt_id: 'r1', seq: 1, receipt_no: 'PO-X-R1', expense_id: 'exp1', status: 'received' })
export const splitPayment = wrapper('split_payment', () => W.__splitResult || { paid_expense_id: 'e1', remaining_expense_id: 'e2', paid_amount: 0, remaining_amount: 0 })
