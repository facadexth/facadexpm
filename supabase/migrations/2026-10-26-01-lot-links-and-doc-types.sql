-- FIFO + MO/OB stock documents, step 1: schema only (owner-approved design 2026-10-26).
--
--   * stock_movements.lot_movement_id -- an out-row (sale_out / transfer_out of raw
--     material) names the in-row (lot) it consumed, so FIFO cost is traceable per lot.
--   * stock_documents gains two document types:
--       MOyymm-nnn  ใบสั่งผลิต   -- per invoice; parent of that invoice's DM and DP.
--                                   Stores the cut's value target (target_total) and the
--                                   per-category split it was planned with (target_splits).
--       OByymm-nnn  ยอดยกมา     -- opening balance; not tied to any invoice, so
--                                   invoice_id becomes nullable. attachment_path points
--                                   at the stock-count PDF in storage.
--   * _issue_stock_document takes the optional parent / target arguments. Idempotency
--     is unchanged for invoice documents ((invoice_id, doc_type)); an invoice-less
--     document (OB) is one per (tenant_id, doc_type).
--
-- Additive except: the doc_type CHECK is widened, invoice_id loses NOT NULL, and the
-- old 5-argument _issue_stock_document is replaced (keeping it would make every
-- existing 5-argument call ambiguous against the new one with defaults).
-- No view selects stock_movements.* / stock_documents.* (inventory_first_receipts lists
-- its columns), so no view needs re-creating. Idempotent.

-- ---------------------------------------------------------------------------
-- stock_movements: lot link
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS lot_movement_id uuid NULL REFERENCES public.stock_movements(id);

-- Partial: only FIFO out-rows carry a lot; lookups are "what consumed this lot".
CREATE INDEX IF NOT EXISTS stock_movements_lot_movement_id_idx
  ON public.stock_movements (lot_movement_id) WHERE lot_movement_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- stock_documents: MO / OB
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_documents
  ADD COLUMN IF NOT EXISTS parent_document_id uuid NULL REFERENCES public.stock_documents(id),
  ADD COLUMN IF NOT EXISTS target_total numeric NULL,
  ADD COLUMN IF NOT EXISTS target_splits jsonb NULL,
  ADD COLUMN IF NOT EXISTS attachment_path text NULL;

-- The inline CHECK of 2026-10-17-05 got Postgres's default name.
ALTER TABLE public.stock_documents DROP CONSTRAINT IF EXISTS stock_documents_doc_type_check;
ALTER TABLE public.stock_documents ADD CONSTRAINT stock_documents_doc_type_check
  CHECK (doc_type IN ('DP', 'DM', 'MO', 'OB'));

-- OB has no invoice. UNIQUE (invoice_id, doc_type) stays: NULLs are distinct there,
-- so the one-OB-per-tenant rule lives in _issue_stock_document below.
ALTER TABLE public.stock_documents ALTER COLUMN invoice_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- _issue_stock_document: optional parent / targets, invoice-less (OB) documents
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public._issue_stock_document(uuid, uuid, text, date, text);

-- Issues (or returns the existing) stock document. Server-only helper: callers are
-- SECURITY DEFINER functions / datafixes. On an idempotent return the stored
-- parent/targets are left as they were.
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
