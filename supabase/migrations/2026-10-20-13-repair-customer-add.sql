-- 2026-10-20-13: customers add photos / details to an existing open repair ticket from LINE.
-- repair_tickets.customer_update_at (set by customer-line-webhook on every addition in an add session) and
-- customer_update_seen_at (set when staff open the ticket) drive the board badge and the new
-- 'repair_customer_update' bell key. customer_line_repair_sessions gets mode ('new' = the session's own
-- new ticket, 'add' = adding to an existing one), started_at (this session's media are created at/after it)
-- and description_before (restored on ยกเลิก in an add session).
-- pending_counts(): copied from 2026-10-20-11 (the LIVE definition), one new key only.
-- No view selects repair_tickets.* (checked 2026-10-20), so no view needs recreating for the new columns.
-- Apply BEFORE deploying customer-line-webhook with the add-session code (it falls back on 42703 anyway).

ALTER TABLE public.repair_tickets
  ADD COLUMN customer_update_at      timestamptz,
  ADD COLUMN customer_update_seen_at timestamptz;

ALTER TABLE public.customer_line_repair_sessions
  ADD COLUMN mode               text NOT NULL DEFAULT 'new' CHECK (mode IN ('new','add')),
  ADD COLUMN started_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN description_before text;

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
