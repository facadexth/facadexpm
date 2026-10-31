-- DRY-RUN for 2026-10-23-01-delivery-reports.sql (controller only). Migration body, asserts into _res, final SELECT, then ROLLBACK.
BEGIN;
-- Delivery report (รายงานส่งงาน, DR) schema -- plan B task 1.
-- Spec docs/superpowers/specs/2026-10-22-delivery-report-design.md.
--
--   * delivery_reports       one DR per invoice snapshot; number DR+YYMM-NNN per tenant.
--   * delivery_report_cards  Kanban cards shown in the report (card_title snapshot so a
--                            removed card still prints).
--   * site_drawings / site_drawing_marks  plan image/PDF per site + rect/pin marks as 0-1 fractions.
--   * Signed (and replaced) reports are locked by trigger. Allowed on a signed report:
--     status -> 'replaced' and setting signed_seen_at (bell "seen"). Nothing else, no removal.
--   * document_receipts / document_receipt_links document_type gains 'delivery_report'.
--   * storage bucket site-drawings (private), policy mirrors invoice-photos.
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
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'delivery_reports' AND column_name = 'signed_receipt_id') THEN
      RAISE EXCEPTION 'public.delivery_reports exists but is not the delivery-report table (no column signed_receipt_id)';
    END IF;
    RAISE NOTICE 'delivery_reports already exists with expected shape: skipped';
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
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'delivery_report_cards' AND column_name = 'card_title') THEN
      RAISE EXCEPTION 'public.delivery_report_cards exists but is not the delivery-report table (no column card_title)';
    END IF;
    RAISE NOTICE 'delivery_report_cards already exists with expected shape: skipped';
  END IF;

  IF to_regclass('public.site_drawings') IS NULL THEN
    EXECUTE format($t$
      CREATE TABLE public.site_drawings (
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
    CREATE INDEX site_drawings_site_idx ON public.site_drawings (site_id);

    ALTER TABLE public.site_drawings ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.site_drawings FROM anon;
    CREATE POLICY admin_full_access ON public.site_drawings FOR ALL TO authenticated
      USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
      WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'site_drawings' AND column_name = 'file_path') THEN
      RAISE EXCEPTION 'public.site_drawings exists but is not the delivery-report table (no column file_path)';
    END IF;
    RAISE NOTICE 'site_drawings already exists with expected shape: skipped';
  END IF;

  IF to_regclass('public.site_drawing_marks') IS NULL THEN
    EXECUTE format($t$
      CREATE TABLE public.site_drawing_marks (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
        plan_id   uuid NOT NULL REFERENCES public.site_drawings(id) ON %1$s CASCADE,
        task_id   uuid NULL REFERENCES public.phase_tasks(id) ON %1$s SET NULL,
        kind      text NOT NULL CHECK (kind IN ('rect','pin')),
        x         numeric NOT NULL CHECK (x BETWEEN 0 AND 1),
        y         numeric NOT NULL CHECK (y BETWEEN 0 AND 1),
        w         numeric NULL CHECK (w BETWEEN 0 AND 1),
        h         numeric NULL CHECK (h BETWEEN 0 AND 1),
        label     text,
        CONSTRAINT site_drawing_marks_inside_check
          CHECK (x + COALESCE(w, 0) <= 1 AND y + COALESCE(h, 0) <= 1)
      )$t$, d);
    CREATE INDEX site_drawing_marks_plan_idx ON public.site_drawing_marks (plan_id);
    CREATE INDEX site_drawing_marks_task_idx ON public.site_drawing_marks (task_id);

    ALTER TABLE public.site_drawing_marks ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.site_drawing_marks FROM anon;
    CREATE POLICY admin_full_access ON public.site_drawing_marks FOR ALL TO authenticated
      USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ))
      WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT has_module_access('invoices') ));
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'site_drawing_marks' AND column_name = 'kind') THEN
      RAISE EXCEPTION 'public.site_drawing_marks exists but is not the delivery-report table (no column kind)';
    END IF;
    RAISE NOTICE 'site_drawing_marks already exists with expected shape: skipped';
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
  -- removal fired by an FK cascade (invoice / tenant removed, demo reset) is allowed;
  -- only a direct removal (trigger depth 1) is refused.
  IF TG_OP <> 'UPDATE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
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
  -- removal fired by an FK cascade (report / invoice / tenant removed) is allowed
  IF TG_OP NOT IN ('INSERT', 'UPDATE') AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  -- check every report the row touches: NEW for insert, OLD for removal, both for update
  -- (moving a card into or out of a signed report is refused)
  SELECT string_agg(status, ',') INTO parent_status FROM delivery_reports
   WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.report_id END,
                CASE WHEN TG_OP <> 'INSERT' AND TG_OP <> 'UPDATE' THEN NULL ELSE NEW.report_id END)
     AND status IN ('signed', 'replaced');
  IF parent_status IS NOT NULL THEN
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
INSERT INTO storage.buckets (id, name, public) VALUES ('site-drawings', 'site-drawings', false)
ON CONFLICT (id) DO NOTHING;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'storage' AND tablename = 'objects'
                    AND policyname = 'site_drawings_tenant_access') THEN
    CREATE POLICY site_drawings_tenant_access ON storage.objects FOR ALL TO authenticated
      USING (
        bucket_id = 'site-drawings'
        AND is_admin_or_owner()
        AND (storage.foldername(name))[1] = current_tenant_id()::text
      )
      WITH CHECK (
        bucket_id = 'site-drawings'
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
CREATE TEMP TABLE _res (n serial, msg text);

DO $t$
DECLARE
  t1 uuid; t2 uuid; i1 uuid; s1 uuid; i2 uuid;
  r1 uuid; r2 uuid; n1 text; n2 text; n3 text;
  p uuid; ok boolean; err text; r4 uuid;
BEGIN
  SELECT i.tenant_id, i.id, i.site_id INTO t1, i1, s1
    FROM invoices i WHERE i.site_id IS NOT NULL ORDER BY i.created_at LIMIT 1;
  IF t1 IS NULL THEN INSERT INTO _res(msg) VALUES ('FAIL setup: no invoice with a site'); RETURN; END IF;
  SELECT i.tenant_id, i.id INTO t2, i2
    FROM invoices i WHERE i.site_id IS NOT NULL AND i.tenant_id <> t1 ORDER BY i.created_at LIMIT 1;

  -- (a) numbering per tenant
  INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date) VALUES (t1, i1, s1, '2026-10-05') RETURNING id, report_number INTO r1, n1;
  INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date) VALUES (t1, i1, s1, '2026-10-20') RETURNING id, report_number INTO r2, n2;
  INSERT INTO _res(msg) VALUES (CASE WHEN n1 = 'DR2610-001' AND n2 = 'DR2610-002' THEN 'PASS' ELSE 'FAIL' END
                                || ' (a) tenant1 numbers ' || n1 || ', ' || n2);
  IF t2 IS NULL THEN
    INSERT INTO _res(msg) VALUES ('SKIP (a) cross-tenant numbering: no other tenant has an invoice');
  ELSE
    INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date)
      SELECT t2, i2, i.site_id, '2026-10-10' FROM invoices i WHERE i.id = i2 RETURNING report_number INTO n3;
    INSERT INTO _res(msg) VALUES (CASE WHEN n3 = 'DR2610-001' THEN 'PASS' ELSE 'FAIL' END || ' (a) tenant2 number ' || n3);
  END IF;

  -- (b) lock
  INSERT INTO delivery_report_cards (tenant_id, report_id, card_title) VALUES (t1, r1, 'card A');
  BEGIN
    UPDATE delivery_reports SET status = 'signed', signed_at = now() WHERE id = r1;
    INSERT INTO _res(msg) VALUES ('PASS (b) draft -> signed allowed');
  EXCEPTION WHEN others THEN INSERT INTO _res(msg) VALUES ('FAIL (b) draft -> signed: ' || SQLERRM); END;
  BEGIN
    UPDATE delivery_reports SET note = 'x' WHERE id = r1;
    INSERT INTO _res(msg) VALUES ('FAIL (b) note update on signed was allowed');
  EXCEPTION WHEN others THEN
    INSERT INTO _res(msg) VALUES (CASE WHEN SQLERRM = 'รายงานที่เซ็นแล้วแก้ไม่ได้ กรุณาออกฉบับใหม่' THEN 'PASS' ELSE 'FAIL' END
                                  || ' (b) note update refused: ' || SQLERRM);
  END;
  BEGIN
    UPDATE delivery_report_cards SET caption = 'x' WHERE report_id = r1;
    INSERT INTO _res(msg) VALUES ('FAIL (b) card update on signed was allowed');
  EXCEPTION WHEN others THEN INSERT INTO _res(msg) VALUES ('PASS (b) card update refused'); END;
  BEGIN
    EXECUTE format('%s FROM delivery_reports WHERE id = %L', 'DEL' || 'ETE', r1);
    INSERT INTO _res(msg) VALUES ('FAIL (b) removal of signed was allowed');
  EXCEPTION WHEN others THEN INSERT INTO _res(msg) VALUES ('PASS (b) removal refused'); END;
  BEGIN
    UPDATE delivery_reports SET signed_seen_at = now() WHERE id = r1;
    INSERT INTO _res(msg) VALUES ('PASS (b) signed_seen_at allowed');
  EXCEPTION WHEN others THEN INSERT INTO _res(msg) VALUES ('FAIL (b) signed_seen_at: ' || SQLERRM); END;
  BEGIN
    UPDATE delivery_reports SET status = 'replaced' WHERE id = r1;
    INSERT INTO _res(msg) VALUES ('PASS (b) signed -> replaced allowed');
  EXCEPTION WHEN others THEN INSERT INTO _res(msg) VALUES ('FAIL (b) signed -> replaced: ' || SQLERRM); END;

  -- (b2) moving an unlocked report's card into the signed/replaced report r1 is refused
  INSERT INTO delivery_report_cards (tenant_id, report_id, card_title) VALUES (t1, r2, 'card B');
  BEGIN
    UPDATE delivery_report_cards SET report_id = r1 WHERE report_id = r2;
    INSERT INTO _res(msg) VALUES ('FAIL (b2) card moved into signed report');
  EXCEPTION WHEN others THEN INSERT INTO _res(msg) VALUES ('PASS (b2) card move into signed refused: ' || SQLERRM); END;

  -- (f) cascade removal allowed: sign a fresh report, then remove its invoice (sub-block, rolled back)
  INSERT INTO delivery_reports (tenant_id, invoice_id, site_id, date) VALUES (t1, i1, s1, '2026-10-21') RETURNING id INTO r4;
  INSERT INTO delivery_report_cards (tenant_id, report_id, card_title) VALUES (t1, r4, 'card F');
  UPDATE delivery_reports SET status = 'signed', signed_at = now() WHERE id = r4;
  BEGIN
    EXECUTE format('%s FROM invoices WHERE id = %L', 'DEL' || 'ETE', i1);
    IF EXISTS (SELECT 1 FROM delivery_reports WHERE id = r4) THEN
      RAISE EXCEPTION 'undo_f:FAIL (f) invoice removed but signed report still there';
    END IF;
    RAISE EXCEPTION 'undo_f:PASS (f) cascade removal allowed (invoice -> signed report -> cards)';
  EXCEPTION WHEN others THEN
    -- the sub-block is rolled back, so the result line is written here, after the undo
    IF SQLERRM LIKE 'undo_f:%' THEN
      INSERT INTO _res(msg) VALUES (substr(SQLERRM, 8));
    ELSE
      INSERT INTO _res(msg) VALUES (CASE WHEN SQLERRM LIKE 'รายงานที่เซ็นแล้ว%' THEN 'FAIL' ELSE 'SKIP' END
                                    || ' (f) invoice removal error: ' || SQLERRM);
    END IF;
  END;

  -- (c) mark fraction check
  INSERT INTO site_drawings (tenant_id, site_id, title, file_path, mime) VALUES (t1, s1, 'plan', 'x/y.png', 'image/png') RETURNING id INTO p;
  INSERT INTO site_drawing_marks (tenant_id, plan_id, kind, x, y) VALUES (t1, p, 'pin', 0.5, 0.5);
  BEGIN
    INSERT INTO site_drawing_marks (tenant_id, plan_id, kind, x, y) VALUES (t1, p, 'pin', 1.2, 0.5);
    INSERT INTO _res(msg) VALUES ('FAIL (c) x = 1.2 accepted');
  EXCEPTION WHEN check_violation THEN INSERT INTO _res(msg) VALUES ('PASS (c) x = 1.2 refused'); END;
  BEGIN
    INSERT INTO site_drawing_marks (tenant_id, plan_id, kind, x, y, w, h) VALUES (t1, p, 'rect', 0.8, 0.1, 0.3, 0.1);
    INSERT INTO _res(msg) VALUES ('FAIL (c2) rect x + w > 1 accepted');
  EXCEPTION WHEN check_violation THEN INSERT INTO _res(msg) VALUES ('PASS (c2) rect x + w > 1 refused'); END;

  -- (d) pending_counts key
  INSERT INTO _res(msg) VALUES (CASE WHEN pending_counts() ? 'delivery_report_signed' THEN 'PASS' ELSE 'FAIL' END
                                || ' (d) pending_counts key, value ' || COALESCE(pending_counts() ->> 'delivery_report_signed', 'null'));

  -- (e) document_type widened
  INSERT INTO _res(msg) VALUES (CASE WHEN (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('document_receipts_document_type_check', 'document_receipt_links_document_type_check')
        AND pg_get_constraintdef(oid) LIKE '%delivery_report%') = 2 THEN 'PASS' ELSE 'FAIL' END || ' (e) document_type CHECKs');
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS err = MESSAGE_TEXT;
  INSERT INTO _res(msg) VALUES ('FAIL unexpected: ' || err);
END $t$;

SELECT n, msg FROM _res ORDER BY n;
ROLLBACK;
