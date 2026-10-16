-- 2026-10-15-02: central_stock_site_id prefers the tenant's is_default site (sites.is_default, one per tenant,
-- seeded as "ส่วนกลาง" by handle_new_user since 2026-10-01-06); the name match stays as the fallback for a
-- tenant whose default flag was never set. Same signature and grants as 2026-10-15-01.
CREATE OR REPLACE FUNCTION central_stock_site_id(p_tenant UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM sites
   WHERE tenant_id = p_tenant AND (is_default OR btrim(name) = 'ส่วนกลาง')
   ORDER BY is_default DESC, created_at NULLS LAST, id
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION central_stock_site_id(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION central_stock_site_id(UUID) TO authenticated;
