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
// W.__depositsError: the deposit query fails (useQuery stores the error, data stays null)
export const useSupplierDeposits = () => useQuery(() => delay(null).then(() => { if (W.__depositsError) throw new Error(W.__depositsError); return W.__deposits || [] }))
export const extractPoDocument = async () => W.__extract || { ok: false }
export const saveSupplierDocumentExample = async () => {}
export const receivePoWithDeposits = async (...a) => { W.__log.push(['rpc', 'receive_po_with_deposits', JSON.stringify(a)]); return 'exp1' }
// null = not ready (links hook errors before the migration / still loading); a Map = live
export const useActiveTaxInvoiceLinks = () => useQuery(() => delay(() => (W.__links ? new Map(W.__links) : null)), [W.__linksVersion])

// 2026-10-09 per-delivery tax invoice. W.__deliveryReady === false -> not ready (the harness sets it false up front; sections 1-9 run as before)
// window event '__readychange' refetches it (the real hook resolves later while a form is already open)
export const useDeliveryTaxInvoiceReady = () => {
  const q = useQuery(() => delay(() => W.__deliveryReady !== false), [])
  useEffect(() => { const h = () => q.refetch(); W.addEventListener('__readychange', h); return () => W.removeEventListener('__readychange', h) }, [q.refetch]) // eslint-disable-line
  return q.data
}
export const useActiveReceiptTaxInvoiceLinks = () => useQuery(() => delay(() => (W.__deliveryReady === false ? { ready: false, map: new Map() } : { ready: true, map: new Map(W.__receiptLinks || []) })), [W.__posVersion])

// ── 2026-10-09 PO receipts (Task 6). W.__money: [[poId, {receivedItemIds:[...], receiptIds:[...], depositId}]] or null (= not ready);
// W.__ledger: {[poId]: {receipts, deposit, applications, bills}}; W.__deposits: useSupplierDeposits rows;
// W.__wrapperError: thrown by the RPC wrappers; every wrapper call is logged as ['rpc', name, args].
// W.__moneySchema === false: the pre-migration soft-failed index (empty Map with schemaReady false), as fetchPoMoneyIndex returns it live.
export const usePoMoneyIndex = () => useQuery(() => delay(() => (W.__money === null ? null
  : Object.assign(new Map((W.__money || []).map(([k, v]) => [k, { receivedItemIds: new Set(v.receivedItemIds || []), receiptIds: new Set(v.receiptIds || []), depositId: v.depositId || null, billCount: v.billCount || 0 }])), { schemaReady: W.__moneySchema !== false }))), [W.__moneyVersion])
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
