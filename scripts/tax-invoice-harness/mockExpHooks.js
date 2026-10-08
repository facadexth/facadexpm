// Expenses page mocks (see README.md). W.__exp: expense rows (expenses_view shape); wrapper calls logged in W.__log.
// W.__splitReady === false: pre-migration (useSplitPaymentReady false) -> the จ่ายบางส่วน action is hidden.
import { useState, useEffect, useCallback, useMemo } from 'react'
const W = window
W.__log = W.__log || []
function useQuery(fn, deps = []) {
  const [data, setData] = useState(null); const [error, setError] = useState(null)
  const f = useCallback(async () => { try { setData(await fn()) } catch (e) { setError(e.message) } }, deps) // eslint-disable-line
  useEffect(() => { f() }, [f])
  return { data, loading: data == null, error, refetch: f }
}
const delay = (v, ms = 20) => new Promise(r => setTimeout(() => r(typeof v === 'function' ? v() : v), ms))
export const useExpenses = () => useQuery(() => delay(() => W.__exp || []), [W.__expVersion])
export const useSites = () => useQuery(() => delay([]))
export const useCategories = () => useQuery(() => delay([]))
export const useSuppliers = () => useQuery(() => delay([]))
export const useCheques = () => useQuery(() => delay([]))
export const useCreditNoteExpenseIds = () => useQuery(() => delay(() => new Set(W.__cnIds || [])))
export const useSupplierCreditNotes = () => useQuery(() => delay([]))
export function useDepositMap() { const m = useMemo(() => new Map(W.__depMap || []), []); return { data: m, refetch: () => {} } }
export const registerSupplierDeposit = async () => {}
export const useSplitPaymentReady = () => useQuery(() => delay(() => W.__splitReady !== false)).data
export const splitPayment = async (args) => {
  W.__log.push(['rpc', 'split_payment', JSON.stringify(args)])
  if (W.__wrapperDelay) await new Promise(r => setTimeout(r, W.__wrapperDelay))
  if (W.__wrapperError) throw W.__wrapperError
  // server effect: the bill becomes the paid part, a new pending row holds the remainder (the list refetch picks both up)
  const src = (W.__exp || []).find(e => e.id === args.expenseId)
  W.__exp = (W.__exp || []).map(e => e.id === args.expenseId ? { ...e, status: 'paid', amount: Number(args.amount) } : e)
  W.__exp.push({ ...src, id: 'enew', status: 'pending', description: 'ยอดคงเหลือ NEW', amount: 1 })
  return { paid_expense_id: args.expenseId, remaining_expense_id: 'enew', paid_amount: Number(args.amount), remaining_amount: 1 }
}
export const usePoUnreceiveReversesStock = () => W.__unreceiveProbe !== false
