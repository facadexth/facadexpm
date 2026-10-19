-- 2026-10-20-09: site warranty. Adds warranty_months / handover_date / warranty_followup_at to sites,
-- backfills handover_date for Completed sites, makes the retention due date = warranty end date, and adds the
-- 'warranty_followup' key to pending_counts(). The view and pending_counts() are copied from the LIVE
-- definitions (2026-10-19); only due_date and the one new key changed.

ALTER TABLE public.sites
  ADD COLUMN warranty_months integer NOT NULL DEFAULT 12 CHECK (warranty_months BETWEEN 0 AND 120),
  ADD COLUMN handover_date date,
  ADD COLUMN warranty_followup_at timestamptz;

UPDATE public.sites SET handover_date = end_date
 WHERE status = 'Completed' AND handover_date IS NULL AND end_date IS NOT NULL;

UPDATE public.sites SET handover_date = DATE '2025-10-14'
 WHERE status = 'Completed' AND handover_date IS NULL;

CREATE OR REPLACE FUNCTION public.sites_warranty_followup_reset_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.handover_date IS DISTINCT FROM OLD.handover_date
     OR NEW.warranty_months IS DISTINCT FROM OLD.warranty_months THEN
    NEW.warranty_followup_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sites_warranty_followup_reset
  BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.sites_warranty_followup_reset_fn();

CREATE OR REPLACE VIEW public.site_retention_summary WITH (security_invoker = true) AS
 SELECT s.id AS site_id,
    s.site_number,
    s.name,
    s.end_date,
    s.default_retention_period_days,
    s.retention_released,
    s.retention_released_date,
    COALESCE(sum(i.retention), 0::numeric) AS total_retention,
        CASE
            WHEN s.handover_date IS NOT NULL AND s.warranty_months > 0 THEN (s.handover_date + make_interval(months => s.warranty_months))::date
            ELSE NULL::date
        END AS due_date
   FROM sites s
     LEFT JOIN incomes i ON i.site_id = s.id
  GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days, s.retention_released, s.retention_released_date;

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
           ELSE 0 END
  );
$function$;
