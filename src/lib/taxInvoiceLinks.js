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
export const idArgs = id => ({ p_id: id })
export const voidArgs = (id, reason) => ({ p_id: id, p_reason: reason })

export const TAX_INVOICE_RPCS = {
  save: 'save_supplier_tax_invoice_draft',
  delete: 'delete_supplier_tax_invoice_draft',
  preview: 'preview_supplier_tax_invoice',
  post: 'post_supplier_tax_invoice',
  void: 'void_supplier_tax_invoice',
}
