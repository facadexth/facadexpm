-- Quotation price validity (valid_until):
--   * 7 days before valid_until a SENT quotation is flagged (bell / row mark / LINE / device push)
--   * "เลื่อน 7 วัน" in the row menu moves valid_until 7 days later (done by the app)
--   * once valid_until has passed and the quotation is still 'sent', a nightly job puts it ON HOLD
--     (quotations.on_hold); "ยกเลิกพัก" in the row menu releases it and gives it 7 more days
-- Replaces the earlier days-after-sending follow-up (nothing in the app used it).

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS on_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ;
-- The valid_until date the "expiring soon" notice was already sent for. A snooze changes
-- valid_until, so the next notice goes out again at the new 7-days-before point.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS expiry_notified_for DATE;

CREATE OR REPLACE FUNCTION hold_expired_quotations() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INT;
BEGIN
  UPDATE quotations
     SET on_hold = true, held_at = now()
   WHERE status = 'sent' AND NOT on_hold
     AND valid_until IS NOT NULL
     AND valid_until < (now() AT TIME ZONE 'Asia/Bangkok')::date;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION hold_expired_quotations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hold_expired_quotations() TO service_role;

-- 00:05 Bangkok every day (pg_cron runs on UTC).
SELECT cron.schedule('hold-expired-quotations', '5 17 * * *', $$SELECT public.hold_expired_quotations()$$);

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
        WHERE q.status = 'sent' AND NOT q.on_hold
          AND q.valid_until IS NOT NULL
          AND q.valid_until <= today.d + 7)
  );
$$;
REVOKE ALL ON FUNCTION pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pending_counts() TO authenticated;
