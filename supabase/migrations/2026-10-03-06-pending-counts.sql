-- pending_counts(): how many things are waiting for someone to act, for the
-- notification badges and bell in the app header.
--
-- SECURITY INVOKER on purpose: it runs as the signed-in user, so row-level
-- security limits every count to that user's own tenant. Nothing here can see
-- another company's rows. The app decides which counts a given role may show
-- (it hides an item when the user cannot open the page it points to).
--
-- The "due" rules mirror the ones the app and the LINE reminders already use
-- (src/lib/lineNotifications.js): a cheque is due when its date is within
-- cheque_reminder_days (default 3) of today, past due included; a site's
-- invoice is due when it is Ongoing, under 100% billed, and has no
-- non-void invoice in the current calendar month; a quotation is due for
-- follow-up when it is 'sent' and follow_up_after_days have passed. Unlike the
-- LINE reminder, the quotation count does not stop once the reminder was
-- pushed: it stays until the quotation leaves the 'sent' status.
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
    'invoices_due',
      (SELECT count(*)
         FROM sites s
         JOIN site_financial_summary f ON f.id = s.id
         LEFT JOIN LATERAL (
           SELECT max(i.date) AS d FROM invoices i WHERE i.site_id = s.id AND i.status <> 'void'
         ) li ON true,
         today
        WHERE s.status = 'Ongoing'
          AND COALESCE(f.billing_pct, 0) < 100
          AND (li.d IS NULL OR date_trunc('month', li.d) < date_trunc('month', today.d))),
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
