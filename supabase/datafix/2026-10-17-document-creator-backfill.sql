-- Fill created_by on existing documents from the app's own audit log (the INSERT row's user_email), so old papers
-- show their maker's signature. Documents with no INSERT log stay NULL -> their paper shows no staff signature.
-- Only fills NULLs (never overwrites), skips 'system'. Run after migration 2026-10-17-01. Re-runnable.
DO $$
DECLARE t text; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'invoices', 'receipts', 'purchase_orders', 'labor_payments'] LOOP
    EXECUTE format($q$
      UPDATE %I d SET created_by = a.user_email
        FROM (SELECT DISTINCT ON (record_id) record_id, user_email FROM audit_logs
               WHERE table_name = %L AND action = 'INSERT' AND user_email IS NOT NULL AND user_email <> 'system'
               ORDER BY record_id, changed_at) a
       WHERE a.record_id = d.id AND d.created_by IS NULL$q$, t, t);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '% : % rows', t, n;
  END LOOP;
END $$;
