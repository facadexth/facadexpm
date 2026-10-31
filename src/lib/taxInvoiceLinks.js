// Pure helpers for the supplier tax invoice hooks (kept out of useSupabase.js so they can be unit tested).

/** Map<po_id, {invoice_id, invoice_no, status}> from active supplier_tax_invoice_pos rows. */
export function buildActiveLinkMap(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (r.active === false) continue // void / relinked rows never count (the hook also filters server-side)
    m.set(r.po_id, { invoice_id: r.invoice_id, invoice_no: r.supplier_tax_invoices?.invoice_no || '', status: r.supplier_tax_invoices?.status || '' })
  }
  return m
}

// RPC argument builders. The parameter names MUST match the SQL functions in
// supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql (locked by taxInvoiceLinks.test.js).
export const saveDraftArgs = (id, header, items, poIds) =>
  ({ p_id: id || null, p_header: header, p_items: items || [], p_po_ids: poIds || [] })
export const saveReceiptDraftArgs = (id, header, items, receiptIds) =>
  ({ p_id: id || null, p_header: header, p_items: items || [], p_receipt_ids: receiptIds || [] })
/** Which save RPC + args a tax invoice form uses. An explicit link_kind ('po' | 'delivery') alone decides the route and
 *  only that kind's ids are sent (the form layer clears the other list when switching). With no link_kind, receipt ids
 *  mean delivery. A delivery form ALWAYS goes to the receipt RPC (even with no receipt picked yet: the server answers
 *  no_receipts), so an old bundle's po-level save can never be hit by a delivery draft. */
export function draftSaveCall(form, id, header, items) {
  const kind = form?.link_kind === 'delivery' || form?.link_kind === 'po'
    ? form.link_kind
    : ((form?.receipt_ids || []).length > 0 ? 'delivery' : 'po')
  if (kind === 'delivery') return { rpc: TAX_INVOICE_RPCS.saveReceipts, args: saveReceiptDraftArgs(id, header, items, form?.receipt_ids) }
  return { rpc: TAX_INVOICE_RPCS.save, args: saveDraftArgs(id, header, items, form?.po_ids) }
}
export const idArgs = id => ({ p_id: id })
/** post must pass the revision the user previewed; a missing value is sent as null and the server refuses it. */
export const postArgs = (id, expectedRevision) => ({ p_id: id, p_expected_revision: Number.isInteger(expectedRevision) ? expectedRevision : null })
export const voidArgs = (id, reason) => ({ p_id: id, p_reason: reason })

export const TAX_INVOICE_RPCS = {
  save: 'save_supplier_tax_invoice_draft',
  saveReceipts: 'save_supplier_tax_invoice_receipt_draft',
  delete: 'delete_supplier_tax_invoice_draft',
  preview: 'preview_supplier_tax_invoice',
  post: 'post_supplier_tax_invoice',
  void: 'void_supplier_tax_invoice',
}
