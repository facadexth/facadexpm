-- LINE salary advance request: token type, command keys, original-request
-- columns, approve-with-changes RPC, bell count.
-- The CHECK lists and pending_counts() body are the LIVE definitions on CHANG
-- (pulled 2026-10-18), extended only.

-- 1. token action type: + 'advance'
ALTER TABLE line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance']));

-- 2. command keys: + advance_request, advance_status, request_menu, request_status
ALTER TABLE line_command_settings DROP CONSTRAINT line_command_settings_command_key_check;
ALTER TABLE line_command_settings ADD CONSTRAINT line_command_settings_command_key_check
  CHECK (command_key = ANY (ARRAY['today_job','tomorrow_job','this_week_job','next_week_job','issue_report','material_request','leave','check_in','check_out','site_photo','job_done_start','advance_request','advance_status','request_menu','request_status']));

-- 3. keep the worker's original numbers when the owner edits on approval
ALTER TABLE salary_advances
  ADD COLUMN requested_amount       NUMERIC,
  ADD COLUMN requested_installments INT;

-- 4. owner approves with changes
CREATE OR REPLACE FUNCTION approve_salary_advance_edit(
  p_id UUID, p_amount NUMERIC, p_installments INT, p_start_year INT, p_start_month INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'อนุมัติได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'จำนวนเงินต้องมากกว่า 0' USING ERRCODE = 'check_violation';
  END IF;
  IF p_installments IS NULL OR p_installments NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'จำนวนงวดต้องอยู่ระหว่าง 1 ถึง 60' USING ERRCODE = 'check_violation';
  END IF;
  IF p_start_year IS NULL OR p_start_month IS NULL OR p_start_month NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'เดือนที่เริ่มหักไม่ถูกต้อง' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM payroll_periods
              WHERE tenant_id = current_tenant_id() AND year = p_start_year AND month = p_start_month
                AND status IN ('confirmed','closed')) THEN
    RAISE EXCEPTION 'เดือนที่เริ่มหักยืนยันหรือปิดงวดแล้ว เลือกเดือนถัดไป' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE salary_advances
     SET requested_amount       = COALESCE(requested_amount, amount),
         requested_installments = COALESCE(requested_installments, installments),
         amount = p_amount, installments = p_installments,
         start_year = p_start_year, start_month = p_start_month,
         status = 'approved', approved_by = auth.email(), approved_at = now()
   WHERE id = p_id AND tenant_id = current_tenant_id() AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอที่รออนุมัติ'; END IF;
END $$;
REVOKE ALL ON FUNCTION approve_salary_advance_edit(UUID, NUMERIC, INT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_salary_advance_edit(UUID, NUMERIC, INT, INT, INT) TO authenticated;

-- 5. bell count: + advances_pending (live body otherwise unchanged)
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
           ELSE 0 END
  );
$function$;
