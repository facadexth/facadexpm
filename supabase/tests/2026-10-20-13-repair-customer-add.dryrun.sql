-- Self-contained dry run for 2026-10-20-13 repair customer add (no placeholders). Paste into the Supabase SQL Editor
-- or run through MCP in one go (this file has no row-removal statements); everything rolls back.
BEGIN;

-- ===== inlined migration 2026-10-20-13 =====
-- 2026-10-20-13: customers add photos / details to an existing open repair ticket from LINE.
-- repair_tickets.customer_update_at (set by customer-line-webhook on every addition in an add session) and
-- customer_update_seen_at (set when staff open the ticket) drive the board badge and the new
-- 'repair_customer_update' bell key. customer_line_repair_sessions gets mode ('new' = the session's own
-- new ticket, 'add' = adding to an existing one), started_at (this session's media are created at/after it)
-- and description_before / update_before (the ticket's description and customer_update_at, put back on ยกเลิก
-- in an add session).
-- pending_counts(): copied from 2026-10-20-11 (the LIVE definition), one new key only.
-- No view selects repair_tickets.* (checked 2026-10-20), so no view needs recreating for the new columns.
-- Apply BEFORE deploying customer-line-webhook with the add-session code (it falls back on 42703 anyway).

ALTER TABLE public.repair_tickets
  ADD COLUMN customer_update_at      timestamptz,
  ADD COLUMN customer_update_seen_at timestamptz;

ALTER TABLE public.customer_line_repair_sessions
  ADD COLUMN mode               text NOT NULL DEFAULT 'new' CHECK (mode IN ('new','add')),
  ADD COLUMN started_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN description_before text,
  ADD COLUMN update_before      timestamptz;

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
           ELSE 0 END
  );
$function$;

-- ===== assertions =====
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_other uuid;
  v_site uuid; v_site2 uuid;
  v_ta uuid; v_tb uuid; v_tc uuid; v_td uuid; v_te uuid; v_tf uuid; v_tx uuid;
  k text; n int; cnt0 jsonb; cnt jsonb; base int; base_pending int;
  sess customer_line_repair_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  -- (a) the five new columns exist with the right types / defaults
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'repair_tickets'
     AND column_name IN ('customer_update_at','customer_update_seen_at') AND data_type = 'timestamp with time zone';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL (a): repair_tickets new columns %', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'customer_line_repair_sessions'
     AND ((column_name = 'mode' AND data_type = 'text' AND is_nullable = 'NO')
       OR (column_name = 'started_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO')
       OR (column_name = 'description_before' AND data_type = 'text' AND is_nullable = 'YES')
       OR (column_name = 'update_before' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'));
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL (a): session new columns %', n; END IF;
  RAISE NOTICE 'PASS (a)';

  SELECT t.id INTO v_other FROM tenants t JOIN user_roles ur ON ur.tenant_id = t.id AND ur.role = 'OWNER'
   WHERE t.id <> v_tenant LIMIT 1;
  IF v_other IS NULL THEN RAISE EXCEPTION 'SETUP: no second tenant with an owner'; END IF;

  -- Baseline as the demo owner (the demo tenant may already have live repair tickets).
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  cnt0 := pending_counts();
  EXECUTE 'RESET ROLE';
  base := (cnt0->>'repair_customer_update')::int;
  base_pending := (cnt0->>'repair_pending')::int;
  IF base IS NULL THEN RAISE EXCEPTION 'FAIL (c): repair_customer_update missing from baseline %', cnt0; END IF;

  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_tenant, 'ZZR13-A', 'ZZ repair13 A') RETURNING id INTO v_site;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_other, 'ZZR13-B', 'ZZ repair13 B') RETURNING id INTO v_site2;

  -- (b) session mode: default 'new' + started_at filled; 'add' accepted; 'x' refused by the CHECK
  INSERT INTO repair_tickets (tenant_id, site_id, status) VALUES (v_tenant, v_site, 'received') RETURNING id INTO v_tx;
  INSERT INTO customer_line_repair_sessions (tenant_id, line_user_id, ticket_id, expires_at)
    VALUES (v_tenant, 'ZZ-dryrun-13-new', v_tx, now() + interval '30 minutes');
  SELECT * INTO sess FROM customer_line_repair_sessions WHERE tenant_id = v_tenant AND line_user_id = 'ZZ-dryrun-13-new';
  IF sess.mode <> 'new' OR sess.started_at IS NULL OR sess.description_before IS NOT NULL OR sess.update_before IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (b): defaults mode=% started_at=% before=%', sess.mode, sess.started_at, sess.description_before;
  END IF;
  INSERT INTO customer_line_repair_sessions (tenant_id, line_user_id, ticket_id, expires_at, mode, description_before, update_before)
    VALUES (v_tenant, 'ZZ-dryrun-13-add', v_tx, now() + interval '30 minutes', 'add', 'old text', now() - interval '1 day');
  BEGIN
    INSERT INTO customer_line_repair_sessions (tenant_id, line_user_id, ticket_id, expires_at, mode)
      VALUES (v_tenant, 'ZZ-dryrun-13-bad', v_tx, now() + interval '30 minutes', 'x');
    RAISE EXCEPTION 'FAIL (b): mode x accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS (b)';

  -- (c) fixtures: only (a) received + unseen and (b) scheduled + seen before the update count.
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_at)
    VALUES (v_tenant, v_site, 'received', v_now) RETURNING id INTO v_ta;
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_at, customer_update_seen_at)
    VALUES (v_tenant, v_site, 'scheduled', v_now, v_now - interval '1 hour') RETURNING id INTO v_tb;
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_at, customer_update_seen_at)
    VALUES (v_tenant, v_site, 'in_progress', v_now, v_now) RETURNING id INTO v_tc;          -- seen exactly at the update
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_at)
    VALUES (v_tenant, v_site, 'pending_review', v_now) RETURNING id INTO v_td;              -- counted by repair_pending
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_at)
    VALUES (v_tenant, v_site, 'done', v_now) RETURNING id INTO v_te;                        -- closed
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_seen_at)
    VALUES (v_tenant, v_site, 'in_progress', v_now) RETURNING id INTO v_tf;                 -- never updated
  INSERT INTO repair_tickets (tenant_id, site_id, status, customer_update_at)
    VALUES (v_other, v_site2, 'received', v_now);                                           -- other tenant

  EXECUTE 'SET LOCAL role authenticated';
  cnt := pending_counts();
  EXECUTE 'RESET ROLE';
  IF (cnt->>'repair_customer_update')::int <> base + 2 THEN
    RAISE EXCEPTION 'FAIL (c): repair_customer_update % expected % + 2', cnt->>'repair_customer_update', base;
  END IF;
  IF (cnt->>'repair_pending')::int <> base_pending + 1 THEN
    RAISE EXCEPTION 'FAIL (c): repair_pending % expected % + 1', cnt->>'repair_pending', base_pending;
  END IF;
  RAISE NOTICE 'PASS (c)';

  -- (d) every earlier key is still there, plus the new one
  FOREACH k IN ARRAY ARRAY['leave_pending','po_draft','issues_open','cheques_due','quotations_followup','offboarded_in_group','advances_pending','customer_requests_open','warranty_followup','repair_pending','repair_customer_update'] LOOP
    IF NOT (cnt ? k) THEN RAISE EXCEPTION 'FAIL (d): missing key %', k; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM jsonb_object_keys(cnt);
  IF n <> 11 THEN RAISE EXCEPTION 'FAIL (d): % keys, expected 11', n; END IF;
  RAISE NOTICE 'PASS (d)';

  -- (e) the modal's plain UPDATE (as the demo owner, through RLS) marks (a) seen and the count drops by one
  EXECUTE 'SET LOCAL role authenticated';
  UPDATE repair_tickets SET customer_update_seen_at = customer_update_at WHERE id = v_ta;
  GET DIAGNOSTICS n = ROW_COUNT;
  cnt := pending_counts();
  EXECUTE 'RESET ROLE';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (e): owner update touched % rows', n; END IF;
  IF (cnt->>'repair_customer_update')::int <> base + 1 THEN
    RAISE EXCEPTION 'FAIL (e): after seen % expected % + 1', cnt->>'repair_customer_update', base;
  END IF;
  RAISE NOTICE 'PASS (e)';
END $$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
