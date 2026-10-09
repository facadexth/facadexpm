// The bank account a new quotation preselects: same rule as the Quotation form's effect (Quotations.jsx):
// accounts of the document's VAT category, the one flagged is_default, else the first. Pure.
export function pickDefaultBankAccount(accounts, hasVat) {
  const cat = hasVat ? 'vat' : 'non_vat'
  const list = (accounts || []).filter(a => a.vat_category === cat)
  return (list.find(a => a.is_default) || list[0] || null)
}
