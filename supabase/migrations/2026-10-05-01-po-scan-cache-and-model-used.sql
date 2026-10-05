-- PO document scan: record which model read a document, and cache successful
-- reads per tenant so a re-upload of the same file is free.
-- Spec: docs/superpowers/specs/2026-10-05-po-extract-tiered-fallback-design.md
-- Additive and nullable only. No view references document_scan_usage (checked
-- 2026-10-05), so the new column cannot hit the view column-freeze trap.

ALTER TABLE document_scan_usage ADD COLUMN IF NOT EXISTS model_used TEXT;

CREATE TABLE IF NOT EXISTS scan_result_cache (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key  TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cache_key)
);

ALTER TABLE scan_result_cache ENABLE ROW LEVEL SECURITY;

-- Same gate as document_scan_usage: only the tenant's own admins/owners on a
-- package that includes purchase orders can read or write it.
DROP POLICY IF EXISTS admin_full_access ON scan_result_cache;
CREATE POLICY admin_full_access ON scan_result_cache FOR ALL
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- Hygiene: Supabase's default grants give anon full table privileges; RLS
-- already blocks it, but this table has no reason to be reachable by anon.
REVOKE ALL ON scan_result_cache FROM anon;
