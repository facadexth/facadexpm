-- Monthly quota for the AI document-scan feature (extract-po-document
-- edge function). Each call spends real ANTHROPIC_API_KEY money, so this
-- caps usage per tenant per calendar month, tier-configurable from
-- platform admin (packages.max_document_scans_per_month, editable in
-- TenantManagement.jsx same as max_admins/max_workers/max_sites).
-- NULL = unlimited (Enterprise's default -- no number was given for it).
ALTER TABLE packages ADD COLUMN max_document_scans_per_month INT;

UPDATE packages SET max_document_scans_per_month = 10  WHERE name = 'Free';
UPDATE packages SET max_document_scans_per_month = 50  WHERE name = 'Solo';
UPDATE packages SET max_document_scans_per_month = 100 WHERE name = 'Pro Team';
UPDATE packages SET max_document_scans_per_month = 500 WHERE name = 'Business';
-- Enterprise: left NULL (unlimited) -- no number given, custom tier.

-- One row per actual AI call attempt (the edge function inserts this
-- right after the Anthropic call, whether or not the AI's JSON response
-- was well-formed -- what costs money is the API call itself, not
-- whether the response turned out to be useful).
CREATE TABLE document_scan_usage (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_scan_usage_tenant_month ON document_scan_usage(tenant_id, created_at);

ALTER TABLE document_scan_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON document_scan_usage FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- Calendar-month reset (matches the never-shipped quotation-limits draft's
-- recommendation, and how plan_expires_at/trial concepts already work in
-- this app): date_trunc('month', now()), not a rolling 30-day window.
-- SECURITY DEFINER + explicit REVOKE/GRANT, same shape as
-- tenant_under_seat_limit() -- callers can check "am I still under quota"
-- without needing direct SELECT on other tenants' packages/usage rows.
CREATE OR REPLACE FUNCTION tenant_under_document_scan_limit()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_limit     INT;
  v_count     INT;
BEGIN
  SELECT p.max_document_scans_per_month INTO v_limit
  FROM tenants t JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  IF v_limit IS NULL THEN
    RETURN true;
  END IF;

  SELECT count(*) INTO v_count FROM document_scan_usage
  WHERE tenant_id = v_tenant_id AND created_at >= date_trunc('month', now());

  RETURN v_count < v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_under_document_scan_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_under_document_scan_limit() TO authenticated;

-- How many scans used this calendar month (for a "X / Y this month" UI),
-- same auth shape as the limit check above.
CREATE OR REPLACE FUNCTION tenant_document_scan_usage_this_month()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM document_scan_usage
  WHERE tenant_id = current_tenant_id() AND created_at >= date_trunc('month', now());
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_document_scan_usage_this_month() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_document_scan_usage_this_month() TO authenticated;
