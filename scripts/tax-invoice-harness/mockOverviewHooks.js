// Hooks the site overview content needs, fed from window.__ov (see runOverview.mjs).
const W = typeof window !== 'undefined' ? window : {}
export const useSiteOverview = () => ({ data: W.__ov.site, error: null })
export const useSiteExpensesByCategory = () => ({ data: [] })
export const useQuotations = () => ({ data: W.__ov.quotations })
export const useInvoices = () => ({ data: W.__ov.invoices })
