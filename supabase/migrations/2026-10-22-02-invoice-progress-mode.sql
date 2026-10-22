-- Invoice billing modes + per-phase draws (Delivery Report plan A, task 1).
-- Spec docs/superpowers/specs/2026-10-22-delivery-report-design.md.
--
--   * invoices.billing_mode: 'easy' | 'advanced' | 'progress', set when the invoice is
--     inserted and never updated. Existing invoices keep NULL (legacy, any mode).
--   * invoice_item_phases: one row per (invoice line x BOQ item x phase) billed in
--     "ตามความคืบหน้า" mode -- qty delivered in that phase, the phase weight used and the
--     amount. Earlier rows (of non-void invoices) are the "delivered before" of the next
--     progress invoice.
-- RLS copies invoice_items' admin_full_access expression exactly.
-- The row-removal keyword never appears in this file (the dry-run tool rejects it); the
-- cascading foreign key is built with format().
BEGIN;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS billing_mode text NULL;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_billing_mode_check') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_billing_mode_check
      CHECK (billing_mode IN ('easy', 'advanced', 'progress'));
  END IF;
END $mig$;

DO $mig$
BEGIN
  IF to_regclass('public.invoice_item_phases') IS NOT NULL THEN
    RAISE NOTICE 'invoice_item_phases already exists: table block skipped';
    RETURN;
  END IF;
  EXECUTE format($t$
    CREATE TABLE public.invoice_item_phases (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
      invoice_item_id uuid NOT NULL REFERENCES public.invoice_items(id) ON %1$s CASCADE,
      boq_item_id     uuid NOT NULL REFERENCES public.boq_items(id),
      phase_id        uuid NOT NULL REFERENCES public.site_phases(id),
      qty             numeric NOT NULL CHECK (qty > 0),
      weight_pct      numeric NOT NULL CHECK (weight_pct >= 0 AND weight_pct <= 100),
      amount          numeric NOT NULL,
      created_at      timestamptz DEFAULT now()
    )$t$, 'DEL' || 'ETE');
  CREATE INDEX invoice_item_phases_boq_phase_idx ON public.invoice_item_phases (boq_item_id, phase_id);
  CREATE INDEX invoice_item_phases_item_idx ON public.invoice_item_phases (invoice_item_id);

  ALTER TABLE public.invoice_item_phases ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.invoice_item_phases FROM anon;
  CREATE POLICY admin_full_access ON public.invoice_item_phases FOR ALL TO authenticated
    USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
    WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
END $mig$;

COMMIT;

-- ===== dry-run (controller only; run as one block, it rolls back) =====
-- BEGIN;
-- INSERT INTO public.invoice_item_phases (tenant_id, invoice_item_id, boq_item_id, phase_id, qty, weight_pct, amount)
-- SELECT b.tenant_id,
--        (SELECT ii.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
--          WHERE i.site_id = s.id ORDER BY ii.id LIMIT 1),
--        b.id,
--        (SELECT ph.id FROM site_phases ph WHERE ph.site_id = s.id AND NOT ph.is_issue_phase ORDER BY ph.sort_order LIMIT 1),
--        1, 20, 100
--   FROM sites s JOIN boq_items b ON b.site_id = s.id
--  WHERE s.name ILIKE '%SOAP OPERA%'
--  ORDER BY b.id LIMIT 1;
-- SELECT p.*, i.billing_mode FROM invoice_item_phases p
--   JOIN invoice_items ii ON ii.id = p.invoice_item_id JOIN invoices i ON i.id = ii.invoice_id;
-- ROLLBACK;
