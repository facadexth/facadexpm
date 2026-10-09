// Every hook Invoices.jsx imports, as inert stubs: the harness only renders DocumentPaper (see runInvoiceDoc.mjs).
const none = () => ({ data: null, loading: false, error: null, refetch: () => {} })
export const useInvoices = none
export const useQuotationItemUnits = none
export const useQuotations = none
export const useSites = none
export const useReceipts = none
export const useInvoicePhotos = none
export const useDocumentReceipt = none
export const useMySignatureUrl = () => null
export const useMyWorkerName = () => ({ data: null })
export const useBankAccounts = none
export const useSiteDepositBalance = none
export const useQuotationDepositTaxOffset = none
export const getQuotationDepositTaxOffset = async () => 0
export const logDocumentPrint = async () => {}
export const useInvoiceDepositChoiceReady = () => false
export const useSiteReservedDeposit = none
