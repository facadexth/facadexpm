-- Stock document numbers for invoice stock deduction (owner decision
-- 2026-10-17). Each invoice's confirm click issues up to two documents:
--   DPyymm-nnn  ใบรับสินค้าสำเร็จรูป (the finished-goods produce+sell pair)
--   DMyymm-nnn  ใบเบิกวัตถุดิบ       (the raw-material cut)
-- yymm comes from the INVOICE date and nnn restarts every month, per
-- tenant (numbers are never global -- see the 2026-09 cheque/doc-number bug).
-- Every movement points at its document, so reports no longer depend on the
-- PI-/PO-<invoice number> notes text, which went stale when IN2608-065 was
-- renumbered to IN2608-006.

CREATE TABLE IF NOT EXISTS public.stock_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  doc_type text NOT NULL CHECK (doc_type IN ('DP', 'DM')),
  doc_number text NOT NULL,
  doc_date date NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  UNIQUE (tenant_id, doc_number),
  UNIQUE (invoice_id, doc_type)
);

ALTER TABLE public.stock_documents ENABLE ROW LEVEL SECURITY;

-- Read-only from the API: documents are only ever issued by
-- post_invoice_stock_deduction below. Same gate as stock_movements.
DROP POLICY IF EXISTS stock_documents_read ON public.stock_documents;
CREATE POLICY stock_documents_read ON public.stock_documents FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('purchase_orders')));

REVOKE ALL ON public.stock_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_documents TO authenticated;

ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS stock_document_id uuid REFERENCES public.stock_documents(id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_stock_document ON public.stock_movements (stock_document_id);

-- Issues (or returns the existing) DP/DM document of one invoice.
-- Server-only helper: callers are the SECURITY DEFINER functions below.
CREATE OR REPLACE FUNCTION public._issue_stock_document(p_tenant_id uuid, p_invoice_id uuid, p_doc_type text, p_doc_date date, p_created_by text)
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
  SELECT id INTO v_id FROM stock_documents WHERE invoice_id = p_invoice_id AND doc_type = p_doc_type;
  IF FOUND THEN RETURN v_id; END IF;

  -- serialise numbering per tenant + prefix so two confirms can't take the same number
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text || v_prefix));

  SELECT coalesce(max(substring(doc_number FROM length(v_prefix) + 1)::int), 0) + 1 INTO v_next
  FROM stock_documents
  WHERE tenant_id = p_tenant_id AND doc_number LIKE v_prefix || '%';

  INSERT INTO stock_documents (tenant_id, doc_type, doc_number, doc_date, invoice_id, created_by)
  VALUES (p_tenant_id, p_doc_type, v_prefix || lpad(v_next::text, 3, '0'), p_doc_date, p_invoice_id, p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public._issue_stock_document(uuid, uuid, text, date, text) FROM PUBLIC, anon, authenticated;

-- Posts one invoice's whole stock deduction in one transaction: dated to
-- the invoice date (23:59 Bangkok), every row tagged with its DP (finished
-- goods) or DM (raw material) document. reference_type/reference_id are set
-- here from p_invoice_id; whatever the client sent for them is ignored.
-- p_movements: json array of {inventory_item_id, site_id, movement_type,
-- quantity, unit_cost, notes}, posted in order.
CREATE OR REPLACE FUNCTION public.post_invoice_stock_deduction(p_invoice_id uuid, p_movements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid := current_tenant_id();
  v_email text := auth.email();
  v_date date;
  v_at timestamptz;
  v_row record;
  v_mid uuid;
  v_dp uuid;
  v_dm uuid;
  v_n int := 0;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_movements IS NULL OR jsonb_typeof(p_movements) <> 'array' OR jsonb_array_length(p_movements) = 0 THEN
    RAISE EXCEPTION 'p_movements must be a non-empty json array';
  END IF;

  SELECT date INTO v_date FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice not found for this tenant'; END IF;
  IF v_date IS NULL THEN RAISE EXCEPTION 'invoice has no date'; END IF;
  v_at := (v_date + time '23:59') AT TIME ZONE 'Asia/Bangkok';

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_movements) m
    LEFT JOIN inventory_items ii ON ii.id = (m->>'inventory_item_id')::uuid AND ii.tenant_id = v_tenant_id
    WHERE ii.id IS NULL
  ) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_movements) m
    LEFT JOIN sites s ON s.id = (m->>'site_id')::uuid AND s.tenant_id = v_tenant_id
    WHERE s.id IS NULL
  ) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  FOR v_row IN
    SELECT e.value AS m, e.ordinality AS ord, ii.item_kind
    FROM jsonb_array_elements(p_movements) WITH ORDINALITY e
    JOIN inventory_items ii ON ii.id = (e.value->>'inventory_item_id')::uuid
    ORDER BY e.ordinality
  LOOP
    SELECT movement_id INTO v_mid FROM _apply_stock_movement(v_tenant_id,
      (v_row.m->>'inventory_item_id')::uuid,
      (v_row.m->>'site_id')::uuid,
      v_row.m->>'movement_type',
      (v_row.m->>'quantity')::numeric,
      (v_row.m->>'unit_cost')::numeric,
      'invoice',
      p_invoice_id,
      v_row.m->>'notes',
      v_email,
      v_at + (v_row.ord * interval '1 microsecond'));

    IF v_row.item_kind = 'finished_goods' THEN
      v_dp := coalesce(v_dp, _issue_stock_document(v_tenant_id, p_invoice_id, 'DP', v_date, v_email));
      UPDATE stock_movements SET stock_document_id = v_dp WHERE id = v_mid;
    ELSE
      v_dm := coalesce(v_dm, _issue_stock_document(v_tenant_id, p_invoice_id, 'DM', v_date, v_email));
      UPDATE stock_movements SET stock_document_id = v_dm WHERE id = v_mid;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'rows', v_n,
    'dp', (SELECT doc_number FROM stock_documents WHERE id = v_dp),
    'dm', (SELECT doc_number FROM stock_documents WHERE id = v_dm));
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice_stock_deduction(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_stock_deduction(uuid, jsonb) TO authenticated;
