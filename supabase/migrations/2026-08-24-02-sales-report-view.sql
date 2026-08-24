-- Flat, exportable "what have we actually sold" report — every line item
-- from an ACCEPTED quotation (draft/sent/rejected/expired quotations were
-- never actually sold, so they're excluded), joined out to client/site
-- names for lookup and analysis. security_invoker=true means this view
-- carries no RLS of its own — it inherits whatever RLS already applies to
-- quotation_items/quotations/clients/sites for the querying user, same
-- pattern as expenses_view/incomes_view/sites_progress_view elsewhere in
-- this schema (see the 2026-08-15 view_security_invoker migration).
CREATE VIEW sales_report_view WITH (security_invoker = true) AS
SELECT
  qi.id,
  qi.quotation_id,
  q.quotation_number,
  q.date,
  q.client_id,
  c.name AS client_name,
  q.site_id,
  s.name AS site_name,
  s.site_number,
  qi.catalog_item_id,
  qi.description,
  qi.unit,
  qi.quantity,
  qi.unit_price,
  qi.line_total,
  qi.tenant_id
FROM quotation_items qi
JOIN quotations q ON q.id = qi.quotation_id
LEFT JOIN clients c ON c.id = q.client_id
LEFT JOIN sites s ON s.id = q.site_id
WHERE q.status = 'accepted';
