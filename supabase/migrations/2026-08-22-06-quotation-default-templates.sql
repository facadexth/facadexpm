-- Default boilerplate text for new quotations' "เงื่อนไขการชำระเงิน" and
-- "หมายเหตุ" fields — set once per tenant in Settings, pre-fills every new
-- quotation (existing quotations are never touched), editable per document
-- same as today. Nullable — same rationale as the rest of the company
-- profile columns (2026-08-22-01): existing tenants simply have no default
-- until an OWNER fills one in.
ALTER TABLE tenants
  ADD COLUMN default_payment_terms TEXT,
  ADD COLUMN default_notes         TEXT;
