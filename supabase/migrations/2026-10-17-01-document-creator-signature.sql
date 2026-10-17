-- Documents carry the signature of the person who MADE them, not of whoever opens / exports them (owner 2026-10-16).
-- 1) created_by (login email) on every document table whose paper shows the staff signature; new rows fill it from
--    the JWT automatically (DEFAULT auth.email()), so no client change is needed to record it. quotations already has
--    the column (never filled by the app) and only gets the default.
-- 2) Same-tenant users may READ each other's signature row and image (writes stay own-only), so a document opened by
--    someone else can show its maker's signature.
-- 3) document_signer_name(email): the maker's worker name for the line under the signature (workers is admin-read).
ALTER TABLE invoices        ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE receipts        ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE labor_payments  ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE invoices        ALTER COLUMN created_by SET DEFAULT auth.email();
ALTER TABLE receipts        ALTER COLUMN created_by SET DEFAULT auth.email();
ALTER TABLE purchase_orders ALTER COLUMN created_by SET DEFAULT auth.email();
ALTER TABLE labor_payments  ALTER COLUMN created_by SET DEFAULT auth.email();
ALTER TABLE quotations      ALTER COLUMN created_by SET DEFAULT auth.email();

DROP POLICY IF EXISTS tenant_signature_read ON user_signatures;
CREATE POLICY tenant_signature_read ON user_signatures FOR SELECT
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS user_signatures_tenant_read ON storage.objects;
CREATE POLICY user_signatures_tenant_read ON storage.objects FOR SELECT
  USING (bucket_id = 'user-signatures' AND (storage.foldername(name))[1] = (current_tenant_id())::text);

CREATE OR REPLACE FUNCTION public.document_signer_name(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.name FROM workers w
   WHERE w.tenant_id = current_tenant_id() AND p_email IS NOT NULL AND lower(w.email) = lower(p_email)
   ORDER BY w.created_at NULLS LAST
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.document_signer_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_signer_name(text) TO authenticated;
