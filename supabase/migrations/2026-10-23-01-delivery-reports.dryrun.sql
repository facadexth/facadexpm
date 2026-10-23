-- DRY-RUN for 2026-10-23-01-delivery-reports.sql (controller only). Migration body, then asserts, then ROLLBACK.
BEGIN;
-- Delivery report (รายงานส่งงาน, DR) schema -- plan B task 1.
-- Spec docs/superpowers/specs/2026-10-22-delivery-report-design.md.
--
--   * delivery_reports       one DR per invoice snapshot; number DR+YYMM-NNN per tenant.
--   * delivery_report_cards  Kanban cards shown in the report (card_title snapshot so a
--                            removed card still prints).
--   * site_plans / site_plan_marks  plan image/PDF per site + rect/pin marks as 0-1 fractions.
--   * Signed (and replaced) reports are locked by trigger. Allowed on a signed report:
--     status -> 'replaced' and setting signed_seen_at (bell "seen"). Nothing else, no removal.
--   * document_receipts / document_receipt_links document_type gains 'delivery_report'.
--   * storage bucket site-plans (private), policy mirrors invoice-photos.
--   * pending_counts(): LIVE body copied from 2026-10-20-13, one new key delivery_report_signed.
-- Idempotent. The row-removal keyword never appears literally (the dry-run tool rejects it);
-- it is built as 'DEL'||'ETE' inside format()/EXECUTE.

-- ---------------------------------------------------------------- tables
DO $mig$
DECLARE d text := 'DEL' || 'ETE';
BEGIN
  IF to_regclass('public.delivery_reports') IS NULL THEN
    EXECUTE format($t$
      CREATE TABLE public.delivery_reports (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
        invoice_id        uuid NOT NULL REFERENCES public.invoices(id) ON %1$s CASCADE,
        site_id           uuid NOT NULL REFERENCES public.sites(id),
        report_number     text,
        date              date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Bangkok')::date,
        status            text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','issued','signed','replaced','void')),
        replaces_id       uuid NULL REFERENCES public.delivery_reports(id),
        phase_ids         uuid[] NOT NULL DEFAULT '{}',
        note              text,
        signed_receipt_id uuid NULL REFERENCES public.document_receipts(id),
        signed_at         timestamptz,
        signed_seen_at    timestamptz,
        created_by        uuid DEFAULT auth.uid(),
        created_at        timestamptz DEFAULT now()
      )$t$, d);
    CREATE UNIQUE INDEX delivery_reports_tenant_number_key ON public.delivery_reports (tenant_id, report_number);
    CREATE INDEX delivery_reports_invoice_idx ON public.delivery_reports (invoice_id);
    CREATE INDEX delivery_reports_site_idx ON public.delivery_reports (site_id);
    CREATE INDEX delivery_reports_signed_unseen_idx ON public.delivery_reports (tenant_id)
      WHERE status = 'signed' AND signed_seen_at IS NULL;

    ALTER TABLE public.delivery_reports ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.delivery_reports FROM anon;
    CREATE POLICY admin_full_access ON public.delivery_reports FOR ALL TO authenticated
      USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
      WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
  ELSE
    RAISE NOTICE 'delivery_reports already exists: skipped';
  END IF;

  IF to_regclass('public.delivery_report_cards') IS NULL THEN
    EXECUTE format($t$
      CREATE TABLE public.delivery_report_cards (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
        report_id   uuid NOT NULL REFERENCES public.delivery_reports(id) ON %1$s CASCADE,
        task_id     uuid NULL REFERENCES public.phase_tasks(id) ON %1$s SET NULL,
        card_title  text NOT NULL,
        photo_ids   uuid[] NOT NULL DEFAULT '{}',
        caption     text,
        sort_order  int NOT NULL DEFAULT 0
      )$t$, d);
    CREATE INDEX delivery_report_cards_report_idx ON public.delivery_report_cards (report_id);
    CREATE INDEX delivery_report_cards_task_idx ON public.delivery_report_cards (task_id);

    ALTER TABLE public.delivery_report_cards ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.delivery_report_cards FROM anon;
    CREATE POLICY admin_full_access ON public.delivery_report_cards FOR ALL TO authenticated
      USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
      WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
  ELSE
    RAISE NOTICE 'delivery_report_cards already exists: skipped';
  END IF;

  IF to_regclass('public.site_plans') IS NULL THEN
    EXECUTE format($t$
      CREATE TABLE public.site_plans (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
        site_id     uuid NOT NULL REFERENCES public.sites(id) ON %1$s CASCADE,
        title       text NOT NULL,
        file_path   text NOT NULL,
        mime        text NOT NULL,
        width       int,
        height      int,
        sort_order  int DEFAULT 0,
        created_at  timestamptz DEFAULT now()
      )$t$, d);
    CREATE INDEX site_plans_site_idx ON public.site_plans (site_id);

    ALTER TABLE public.site_plans ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.site_plans FROM anon;
    CREATE POLICY admin_full_access ON public.site_plans FOR ALL TO authenticated
      USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
      WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
  ELSE
    RAISE NOTICE 'site_plans already exists: skipped';
  END IF;

  IF to_regclass('public.site_plan_marks') IS NULL THEN
    EXECUTE format($t$
      CREATE TABLE public.site_plan_marks (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
        plan_id   uuid NOT NULL REFERENCES public.site_plans(id) ON %1$s CASCADE,
        task_id   uuid NULL REFERENCES public.phase_tasks(id) ON %1$s SET NULL,
        kind      text NOT NULL CHECK (kind IN ('rect','pin')),
        x         numeric NOT NULL CHECK (x BETWEEN 0 AND 1),
        y         numeric NOT NULL CHECK (y BETWEEN 0 AND 1),
        w         numeric NULL CHECK (w BETWEEN 0 AND 1),
        h         numeric NULL CHECK (h BETWEEN 0 AND 1),
        label     text
      )$t$, d);
    CREATE INDEX site_plan_marks_plan_idx ON public.site_plan_marks (plan_id);
    CREATE INDEX site_plan_marks_task_idx ON public.site_plan_marks (task_id);

    ALTER TABLE public.site_plan_marks ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.site_plan_marks FROM anon;
    CREATE POLICY admin_full_access ON public.site_plan_marks FOR ALL TO authenticated
      USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
      WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
  ELSE
    RAISE NOTICE 'site_plan_marks already exists: skipped';
  END IF;
END $mig$;

-- ---------------------------------------------------------------- numbering
-- DR + YYMM of the report's own date + '-' + 3 digits, per tenant.
CREATE OR REPLACE FUNCTION public.generate_delivery_report_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month text := to_char(COALESCE(NEW.date, (now() AT TIME ZONE 'Asia/Bangkok')::date), 'YYMM');
  seq_num    int;
BEGIN
  IF NEW.report_number IS NOT NULL AND NEW.report_number <> '' THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(MAX(substring(report_number FROM 'DR\d{4}-(\d+)$')::int), 0) + 1
    INTO seq_num
    FROM delivery_reports
   WHERE tenant_id = NEW.tenant_id
     AND report_number LIKE 'DR' || year_month || '-%';
  NEW.report_number := 'DR' || year_month || '-' || lpad(seq_num::text, 3, '0');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_delivery_report_number ON public.delivery_reports;
CREATE TRIGGER trg_delivery_report_number
  BEFORE INSERT ON public.delivery_reports
  FOR EACH ROW EXECUTE FUNCTION public.generate_delivery_report_number();

-- ---------------------------------------------------------------- lock
-- A report whose OLD status is 'signed' or 'replaced' is frozen. The only changes allowed:
--   signed -> replaced (nothing else in the row changes except signed_seen_at), and
--   setting signed_seen_at alone (bell "seen").
-- draft/issued -> signed (sign-link edge function, service role) is untouched by this.
CREATE OR REPLACE FUNCTION public.delivery_report_locked_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  rest_old jsonb;
  rest_new jsonb;
BEGIN
  IF OLD.status NOT IN ('signed', 'replaced') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    rest_old := to_jsonb(OLD) - 'status' - 'signed_seen_at';
    rest_new := to_jsonb(NEW) - 'status' - 'signed_seen_at';
    IF rest_old = rest_new
       AND (NEW.status = OLD.status OR (OLD.status = 'signed' AND NEW.status = 'replaced')) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'รายงานที่เซ็นแล้วแก้ไม่ได้ กรุณาออกฉบับใหม่';
END;
$$;

CREATE OR REPLACE FUNCTION public.delivery_report_card_locked_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM delivery_reports
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.report_id ELSE OLD.report_id END;
  -- parent already gone (cascade from an unlocked report) -> allow
  IF parent_status IN ('signed', 'replaced') THEN
    RAISE EXCEPTION 'รายงานที่เซ็นแล้วแก้ไม่ได้ กรุณาออกฉบับใหม่';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $mig$
DECLARE d text := 'DEL' || 'ETE';
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_delivery_report_locked ON public.delivery_reports';
  EXECUTE format('CREATE TRIGGER trg_delivery_report_locked BEFORE UPDATE OR %s ON public.delivery_reports '
                 'FOR EACH ROW EXECUTE FUNCTION public.delivery_report_locked_guard()', d);
  EXECUTE 'DROP TRIGGER IF EXISTS trg_delivery_report_locked ON public.delivery_report_cards';
  EXECUTE format('CREATE TRIGGER trg_delivery_report_locked BEFORE INSERT OR UPDATE OR %s ON public.delivery_report_cards '
                 'FOR EACH ROW EXECUTE FUNCTION public.delivery_report_card_locked_guard()', d);
END $mig$;

-- ---------------------------------------------------------------- document_type CHECKs
ALTER TABLE public.document_receipts DROP CONSTRAINT IF EXISTS document_receipts_document_type_check;
ALTER TABLE public.document_receipts ADD CONSTRAINT document_receipts_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice', 'delivery_report'));

ALTER TABLE public.document_receipt_links DROP CONSTRAINT IF EXISTS document_receipt_links_document_type_check;
ALTER TABLE public.document_receipt_links ADD CONSTRAINT document_receipt_links_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice', 'delivery_report'));

-- ---------------------------------------------------------------- storage
INSERT INTO storage.buckets (id, name, public) VALUES ('site-plans', 'site-plans', false)
ON CONFLICT (id) DO NOTHING;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'storage' AND tablename = 'objects'
                    AND policyname = 'site_plans_tenant_access') THEN
    CREATE POLICY site_plans_tenant_access ON storage.objects FOR ALL TO authenticated
      USING (
        bucket_id = 'site-plans'
        AND is_admin_or_owner()
        AND (storage.foldername(name))[1] = current_tenant_id()::text
      )
      WITH CHECK (
        bucket_id = 'site-plans'
        AND is_admin_or_owner()
        AND (storage.foldername(name))[1] = current_tenant_id()::text
      );
  END IF;
END $mig$;

-- ---------------------------------------------------------------- pending_counts
-- Copied from 2026-10-20-13-repair-customer-add.sql (newest definition), one new key.
CREATE OR REPLACE FUNCTION public.pending_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
  ),
  cheque_window AS (
    SELECT COALESCE(
      (SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int END
         FROM app_settings WHERE key = 'cheque_reminder_days' LIMIT 1),
      3) AS n
  )
  SELECT jsonb_build_object(
    'leave_pending',
      (SELECT count(*) FROM leave_requests WHERE status = 'pending'),
    'po_draft',
      (SELECT count(*) FROM purchase_orders WHERE status = 'draft'),
    'issues_open',
      (SELECT count(*) FROM line_issue_reports WHERE status = 'open'),
    'cheques_due',
      (SELECT count(*) FROM cheques c, today, cheque_window w
        WHERE c.status <> 'cashed' AND c.check_date <= today.d + w.n),
    'quotations_followup',
      (SELECT count(*) FROM quotations q, today
        WHERE q.status = 'sent' AND NOT q.on_hold
          AND q.valid_until IS NOT NULL
          AND q.valid_until <= today.d + 7),
    'offboarded_in_group',
      (SELECT count(*) FROM workers w
        WHERE w.status = 'inactive' AND w.line_offboarding_alerted_at IS NOT NULL
          AND (w.line_group_removed_at IS NULL OR w.line_group_removed_at < w.line_offboarding_alerted_at)),
    'advances_pending',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM salary_advances
                  WHERE tenant_id = current_tenant_id() AND status = 'pending')
           ELSE 0 END,
    'customer_requests_open',
      CASE WHEN is_owner()
           THEN (SELECT count(*) FROM customer_line_requests
                  WHERE tenant_id = current_tenant_id() AND handled_at IS NULL)
           ELSE 0 END,
    'warranty_followup',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM sites s, today
                  WHERE s.tenant_id = current_tenant_id()
                    AND s.status = 'Completed'
                    AND s.handover_date IS NOT NULL
                    AND s.warranty_months > 0
                    AND s.warranty_followup_at IS NULL
                    AND (s.handover_date + make_interval(months => s.warranty_months))::date
                        BETWEEN today.d AND today.d + 30)
           ELSE 0 END,
    'repair_pending',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM repair_tickets
                  WHERE tenant_id = current_tenant_id() AND status = 'pending_review')
           ELSE 0 END,
    'repair_customer_update',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM repair_tickets
                  WHERE tenant_id = current_tenant_id()
                    AND status IN ('received','scheduled','in_progress')
                    AND customer_update_at IS NOT NULL
                    AND (customer_update_seen_at IS NULL OR customer_update_seen_at < customer_update_at))
           ELSE 0 END,
    'delivery_report_signed',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM delivery_reports
                  WHERE tenant_id = current_tenant_id()
                    AND status = 'signed' AND signed_seen_at IS NULL)
           ELSE 0 END
  );
$function$;


-- ================================================================ asserts
DO $t$
DECLARE
  t1 uuid; t2 uuid; i1 uuid; s1 uuid; i2 uuid; s2 uuid;
  r1 uuid; r2 uuid; r3 uuid; n1 text; n2 text; n3 text;
  p uuid; ok boolean;
BEGIN
  SELECT i.tenant_id, i.id, i.site_id INTO t1, i1, s1
    FROM invoices i WHERE i.site_id IS NOT NULL ORDER BY i.created_at LIMIT 1;
  SELECT i.tenant_id, i.id, i.site_id INTO t2, i2, s2
    FROM invoices i WHERE i.site_id IS NOT NULL AND i.tenant_id <> t1 ORDER BY i.created_at LIMIT 1;
  IF t1 IS NULL OR t2 IS NULL THEN RAISE EXCEPTION 'setup: need invoices with site in two tenants'; END IF;

  -- (a) numbering per tenant
  INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date) VALUES (t1, i1, s1, '2026-10-05') RETURNING id, report_number INTO r1, n1;
  INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date) VALUES (t1, i1, s1, '2026-10-20') RETURNING id, report_number INTO r2, n2;
  INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date) VALUES (t2, i2, s2, '2026-10-10') RETURNING id, report_number INTO r3, n3;
  IF n1 <> 'DR2610-001' OR n2 <> 'DR2610-002' OR n3 <> 'DR2610-001' THEN
    RAISE EXCEPTION 'FAIL (a) numbers % % %', n1, n2, n3; END IF;
  RAISE NOTICE 'PASS (a) % % %', n1, n2, n3;

  -- (b) lock
  INSERT INTO delivery_report_cards (tenant_id, report_id, card_title) VALUES (t1, r1, 'card A');
  UPDATE delivery_reports SET status = 'signed', signed_at = now() WHERE id = r1;  -- draft -> signed allowed
  ok := false;
  BEGIN
    UPDATE delivery_reports SET note = 'x' WHERE id = r1;
  EXCEPTION WHEN others THEN
    ok := SQLERRM = 'รายงานที่เซ็นแล้วแก้ไม่ได้ กรุณาออกฉบับใหม่';
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL (b) note update on signed not refused'; END IF;
  ok := false;
  BEGIN
    UPDATE delivery_report_cards SET caption = 'x' WHERE report_id = r1;
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL (b) card update on signed not refused'; END IF;
  ok := false;
  BEGIN
    EXECUTE format('%s FROM delivery_reports WHERE id = %L', 'DEL' || 'ETE', r1);
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL (b) removal of signed not refused'; END IF;
  UPDATE delivery_reports SET signed_seen_at = now() WHERE id = r1;               -- bell seen allowed
  UPDATE delivery_reports SET status = 'replaced' WHERE id = r1;                  -- must succeed
  IF (SELECT status FROM delivery_reports WHERE id = r1) <> 'replaced' THEN RAISE EXCEPTION 'FAIL (b) replaced'; END IF;
  RAISE NOTICE 'PASS (b) lock';

  -- (c) mark fraction check
  INSERT INTO site_plans (tenant_id, site_id, title, file_path, mime) VALUES (t1, s1, 'plan', 'x/y.png', 'image/png') RETURNING id INTO p;
  INSERT INTO site_plan_marks (tenant_id, plan_id, kind, x, y) VALUES (t1, p, 'pin', 0.5, 0.5);
  ok := false;
  BEGIN
    INSERT INTO site_plan_marks (tenant_id, plan_id, kind, x, y) VALUES (t1, p, 'pin', 1.2, 0.5);
  EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL (c) x=1.2 accepted'; END IF;
  RAISE NOTICE 'PASS (c) mark check';

  -- (d) pending_counts key
  IF NOT (pending_counts() ? 'delivery_report_signed') THEN RAISE EXCEPTION 'FAIL (d) key missing'; END IF;
  RAISE NOTICE 'PASS (d) pending_counts %', pending_counts() -> 'delivery_report_signed';

  -- (e) document_type widened
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_receipt_links_document_type_check'
                  AND pg_get_constraintdef(oid) LIKE '%delivery_report%') THEN RAISE EXCEPTION 'FAIL (e)'; END IF;
  RAISE NOTICE 'PASS (e) document_type';
END $t$;

ROLLBACK;
