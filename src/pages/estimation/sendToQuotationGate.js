// Who sees the send button: needs both modules, the right to edit estimation, and the right Quotations.jsx demands
// to create/edit a quotation (ADMIN or above + canEditPage(role, 'quotations')). Pure.
export function canSendToQuotation({ canEditEstimation, hasEstimation, hasQuotations, isAdmin, canEditQuotations }) {
  return !!(canEditEstimation && hasEstimation && hasQuotations && isAdmin && canEditQuotations)
}
