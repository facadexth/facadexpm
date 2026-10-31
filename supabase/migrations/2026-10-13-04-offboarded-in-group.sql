-- Bell item "ช่างพ้นสภาพ รอลบออกจากกลุ่ม LINE" (LINE pushes are off, so the owner is told
-- inside the app instead). The bot already stamps workers.line_offboarding_alerted_at when it
-- notices an inactive worker still in the group; this adds the owner's "removed" mark.
-- A worker is waiting when inactive, noticed, and not marked removed AFTER the latest notice.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS line_group_removed_at TIMESTAMPTZ;

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
          AND q.valid_until <= today.d + 7),
    'offboarded_in_group',
      (SELECT count(*) FROM workers w
        WHERE w.status = 'inactive' AND w.line_offboarding_alerted_at IS NOT NULL
          AND (w.line_group_removed_at IS NULL OR w.line_group_removed_at < w.line_offboarding_alerted_at))
  );
$$;
REVOKE ALL ON FUNCTION pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pending_counts() TO authenticated;
