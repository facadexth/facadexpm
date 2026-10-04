-- pending_counts(): drop the "invoices due this month" count. It was one number per Ongoing
-- site that stayed up until every site had an invoice in the current month, which buried the
-- items that need an actual decision (leave requests, draft purchase orders, ...). Nothing
-- else changes; the function keeps running as the signed-in user so RLS still limits every
-- count to their own company.
CREATE OR REPLACE FUNCTION pending_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
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
        WHERE q.status = 'sent'
          AND q.follow_up_after_days IS NOT NULL
          AND q.sent_at IS NOT NULL
          AND today.d - (q.sent_at AT TIME ZONE 'Asia/Bangkok')::date >= q.follow_up_after_days)
  );
$$;

REVOKE ALL ON FUNCTION pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pending_counts() TO authenticated;
