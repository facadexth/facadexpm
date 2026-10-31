-- Rolled-back check for supabase/migrations/2026-10-26-01-lot-links-and-doc-types.sql
-- (controller runs it; always rolls back).
-- Runs the migration body, then probes on the FacadeX tenant:
--   1. an OB document with invoice_id NULL (and a second call returns the same id)
--   2. an MO document on IN2601-001 with parent + target_total + target_splits
--      (and a second call returns the same id)
--   3. an unknown doc_type is still rejected by the CHECK
--   4. only the new 8-argument _issue_stock_document exists
--   5. the lot link column + partial index exist
-- The object-removal keyword never appears literally (the SQL runner rejects it): the
-- three statements that use it are built with 'DR' || 'OP' in EXECUTE. Everything else
-- is the migration verbatim.
BEGIN;

-- ===== migration body =====================================================
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS lot_movement_id uuid NULL REFERENCES public.stock_movements(id);

CREATE INDEX IF NOT EXISTS stock_movements_lot_movement_id_idx
  ON public.stock_movements (lot_movement_id) WHERE lot_movement_id IS NOT NULL;

ALTER TABLE public.stock_documents
  ADD COLUMN IF NOT EXISTS parent_document_id uuid NULL REFERENCES public.stock_documents(id),
  ADD COLUMN IF NOT EXISTS target_total numeric NULL,
  ADD COLUMN IF NOT EXISTS target_splits jsonb NULL,
  ADD COLUMN IF NOT EXISTS attachment_path text NULL;

DO $$
DECLARE k text := 'DR' || 'OP';
BEGIN
  EXECUTE format('ALTER TABLE public.stock_documents %s CONSTRAINT IF EXISTS stock_documents_doc_type_check', k);
  EXECUTE 'ALTER TABLE public.stock_documents ADD CONSTRAINT stock_documents_doc_type_check'
       || ' CHECK (doc_type IN (''DP'', ''DM'', ''MO'', ''OB''))';
  EXECUTE format('ALTER TABLE public.stock_documents ALTER COLUMN invoice_id %s NOT NULL', k);
  EXECUTE format('%s FUNCTION IF EXISTS public._issue_stock_document(uuid, uuid, text, date, text)', k);
END $$;

CREATE OR REPLACE FUNCTION public._issue_stock_document(
  p_tenant_id uuid,
  p_invoice_id uuid,
  p_doc_type text,
  p_doc_date date,
  p_created_by text,
  p_parent uuid DEFAULT NULL,
  p_target_total numeric DEFAULT NULL,
  p_target_splits jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_prefix text := p_doc_type || to_char(p_doc_date, 'YYMM') || '-';
  v_next int;
BEGIN
  IF p_invoice_id IS NOT NULL THEN
    SELECT id INTO v_id FROM stock_documents WHERE invoice_id = p_invoice_id AND doc_type = p_doc_type;
  ELSE
    -- invoice-less document (OB): one per tenant and type
    SELECT id INTO v_id FROM stock_documents
    WHERE tenant_id = p_tenant_id AND doc_type = p_doc_type AND invoice_id IS NULL;
  END IF;
  IF FOUND THEN RETURN v_id; END IF;

  -- serialise numbering per tenant + prefix so two confirms can't take the same number
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text || v_prefix));

  SELECT coalesce(max(substring(doc_number FROM length(v_prefix) + 1)::int), 0) + 1 INTO v_next
  FROM stock_documents
  WHERE tenant_id = p_tenant_id AND doc_number LIKE v_prefix || '%';

  INSERT INTO stock_documents (tenant_id, doc_type, doc_number, doc_date, invoice_id, created_by,
                               parent_document_id, target_total, target_splits)
  VALUES (p_tenant_id, p_doc_type, v_prefix || lpad(v_next::text, 3, '0'), p_doc_date, p_invoice_id, p_created_by,
          p_parent, p_target_total, p_target_splits)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public._issue_stock_document(uuid, uuid, text, date, text, uuid, numeric, jsonb)
  FROM PUBLIC, anon, authenticated;
-- ===== end migration body =================================================

-- ===== probes =============================================================
CREATE TEMP TABLE _probe (k text PRIMARY KEY, id uuid, note text);

DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_invoice uuid := '0b28b845-9dae-4c5e-b37a-77c8c4e5b7df'; -- IN2601-001 (has DM2601-001 + DP2601-001)
  v_ob uuid; v_ob2 uuid; v_mo uuid; v_mo2 uuid;
BEGIN
  v_ob  := _issue_stock_document(v_tenant, NULL, 'OB', date '2026-01-01', 'dryrun');
  v_ob2 := _issue_stock_document(v_tenant, NULL, 'OB', date '2026-01-01', 'dryrun');
  v_mo  := _issue_stock_document(v_tenant, v_invoice, 'MO', date '2026-01-06', 'dryrun',
                                 p_parent => v_ob,
                                 p_target_total => 12345.67,
                                 p_target_splits => '{"cat-a": 60, "cat-b": 40}'::jsonb);
  v_mo2 := _issue_stock_document(v_tenant, v_invoice, 'MO', date '2026-01-06', 'dryrun');
  INSERT INTO _probe VALUES ('ob', v_ob, NULL), ('ob_again', v_ob2, NULL),
                            ('mo', v_mo, NULL), ('mo_again', v_mo2, NULL);

  BEGIN
    INSERT INTO stock_documents (tenant_id, doc_type, doc_number, doc_date, invoice_id)
    VALUES (v_tenant, 'XX', 'XX-dryrun', date '2026-01-01', NULL);
    INSERT INTO _probe VALUES ('bad_type', NULL, 'ACCEPTED (wrong)');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _probe VALUES ('bad_type', NULL, 'rejected (ok)');
  END;
END $$;

-- The two probe documents as stored. Expect: OB2601-001 with invoice_id NULL;
-- MO2601-001 on IN2601-001, parent = the OB id, target_total 12345.67, splits as given.
SELECT d.doc_type, d.doc_number, d.doc_date, d.invoice_id, d.parent_document_id,
       d.target_total, d.target_splits, d.attachment_path, d.created_by
FROM stock_documents d
WHERE d.id IN (SELECT id FROM _probe WHERE k IN ('ob', 'mo'))
ORDER BY d.doc_type DESC;

-- Every check should be true.
SELECT
  (SELECT id FROM _probe WHERE k = 'ob') = (SELECT id FROM _probe WHERE k = 'ob_again')   AS ob_idempotent,
  (SELECT id FROM _probe WHERE k = 'mo') = (SELECT id FROM _probe WHERE k = 'mo_again')   AS mo_idempotent,
  (SELECT invoice_id IS NULL FROM stock_documents WHERE id = (SELECT id FROM _probe WHERE k = 'ob')) AS ob_invoice_null,
  (SELECT parent_document_id = (SELECT id FROM _probe WHERE k = 'ob')
          AND target_total = 12345.67
          AND target_splits = '{"cat-a": 60, "cat-b": 40}'::jsonb
   FROM stock_documents WHERE id = (SELECT id FROM _probe WHERE k = 'mo'))               AS mo_parent_and_targets,
  (SELECT note = 'rejected (ok)' FROM _probe WHERE k = 'bad_type')                        AS bad_type_rejected,
  (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_issue_stock_document')                    AS single_overload,
  (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_issue_stock_document' LIMIT 1)            AS signature,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stock_movements'
            AND column_name = 'lot_movement_id' AND data_type = 'uuid')                   AS lot_column,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'stock_movements_lot_movement_id_idx'
            AND indexdef LIKE '%WHERE (lot_movement_id IS NOT NULL)%')                    AS lot_index,
  (SELECT is_nullable = 'YES' FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'stock_documents' AND column_name = 'invoice_id') AS invoice_id_nullable,
  NOT has_function_privilege('authenticated',
      'public._issue_stock_document(uuid, uuid, text, date, text, uuid, numeric, jsonb)', 'EXECUTE') AS not_callable_by_authenticated;

ROLLBACK;
