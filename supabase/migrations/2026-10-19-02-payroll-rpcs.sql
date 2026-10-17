-- supabase/migrations/2026-10-19-02-payroll-rpcs.sql
-- Payroll rework, part 2: the only write paths for salary_records / lines /
-- period state / advance approval. Each checks role + tenant itself.

CREATE OR REPLACE FUNCTION payroll_require_admin()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'ต้องเป็นแอดมินหรือเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN current_tenant_id();
END $$;
REVOKE ALL ON FUNCTION payroll_require_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION save_payroll_draft(p_year INT, p_month INT, p_records JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant UUID := payroll_require_admin();
  v_period UUID; v_status TEXT; v_rec JSONB; v_line JSONB; v_record_id UUID; v_n INT := 0;
  v_workers UUID[] := '{}';
BEGIN
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'ไม่มีรายชื่อพนักงานที่จะบันทึก';
  END IF;
  v_period := payroll_period_for(v_tenant, p_year, p_month);
  SELECT status INTO v_status FROM payroll_periods WHERE id = v_period FOR UPDATE;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'เงินเดือนเดือนนี้ยืนยันหรือปิดงวดแล้ว แก้ไขไม่ได้' USING ERRCODE = 'check_violation';
  END IF;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(p_records) LOOP
    IF NOT EXISTS (SELECT 1 FROM workers WHERE id = (v_rec->>'worker_id')::uuid AND tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'ไม่พบพนักงาน %', v_rec->>'worker_id';
    END IF;
    IF (v_rec->>'worker_id')::uuid = ANY (v_workers) THEN
      RAISE EXCEPTION 'พนักงานซ้ำในรายการ %', v_rec->>'worker_id';
    END IF;
    v_workers := v_workers || (v_rec->>'worker_id')::uuid;

    INSERT INTO salary_records (tenant_id, worker_id, year, month, facts)
    VALUES (v_tenant, (v_rec->>'worker_id')::uuid, p_year, p_month, COALESCE(v_rec->'facts', '{}'::jsonb))
    ON CONFLICT (worker_id, month, year) DO UPDATE SET facts = EXCLUDED.facts
    RETURNING id INTO v_record_id;

    DELETE FROM salary_record_lines WHERE salary_record_id = v_record_id;
    FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(v_rec->'lines', '[]'::jsonb)) LOOP
      INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, advance_id, name, side, sort_order, amount, quantity, rate, note, is_manual)
      SELECT v_tenant, v_record_id,
             (SELECT id FROM pay_items WHERE id = NULLIF(v_line->>'pay_item_id','')::uuid AND tenant_id = v_tenant),
             (SELECT id FROM salary_advances WHERE id = NULLIF(v_line->>'advance_id','')::uuid AND tenant_id = v_tenant
                 AND worker_id = (v_rec->>'worker_id')::uuid),
             v_line->>'name', v_line->>'side', COALESCE((v_line->>'sort_order')::int, 0),
             round((v_line->>'amount')::numeric, 2),
             NULLIF(v_line->>'quantity','')::numeric, NULLIF(v_line->>'rate','')::numeric,
             v_line->>'note', COALESCE((v_line->>'is_manual')::boolean, false);
    END LOOP;
    v_n := v_n + 1;
  END LOOP;

  -- workers no longer in the run (inactive) drop out of this draft month
  DELETE FROM salary_records WHERE period_id = v_period AND NOT (worker_id = ANY (v_workers));
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION save_payroll_draft(INT, INT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_payroll_draft(INT, INT, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION set_payroll_manual_line(p_record_id UUID, p_pay_item_id UUID, p_advance_id UUID, p_amount NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant UUID := payroll_require_admin(); v_item pay_items; v_note TEXT; v_status TEXT;
BEGIN
  SELECT p.status INTO v_status FROM payroll_periods p JOIN salary_records r ON r.period_id = p.id
   WHERE r.id = p_record_id AND r.tenant_id = v_tenant FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการเงินเดือน'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'เงินเดือนเดือนนี้ยืนยันหรือปิดงวดแล้ว แก้ไขไม่ได้' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_item FROM pay_items WHERE id = p_pay_item_id AND tenant_id = v_tenant;
  IF v_item.id IS NULL OR v_item.method NOT IN ('manual_monthly','advances') THEN
    RAISE EXCEPTION 'รายการนี้กรอกเองไม่ได้';
  END IF;
  IF v_item.method = 'advances' AND p_advance_id IS NULL THEN RAISE EXCEPTION 'ต้องระบุรายการเบิก'; END IF;
  IF p_advance_id IS NOT NULL AND v_item.method <> 'advances' THEN
    RAISE EXCEPTION 'รายการนี้ไม่ใช่รายการเบิกล่วงหน้า';
  END IF;
  IF p_advance_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM salary_advances a JOIN salary_records r ON r.worker_id = a.worker_id
        WHERE a.id = p_advance_id AND a.tenant_id = v_tenant AND r.id = p_record_id
          AND a.status IN ('approved','settled')) THEN
    RAISE EXCEPTION 'ไม่พบรายการเบิกของพนักงานคนนี้';
  END IF;

  SELECT note INTO v_note FROM salary_record_lines
   WHERE salary_record_id = p_record_id AND pay_item_id = p_pay_item_id
     AND advance_id IS NOT DISTINCT FROM p_advance_id LIMIT 1;
  DELETE FROM salary_record_lines
   WHERE salary_record_id = p_record_id AND pay_item_id = p_pay_item_id
     AND advance_id IS NOT DISTINCT FROM p_advance_id;
  IF p_amount IS NOT NULL THEN
    INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, advance_id, name, side, sort_order, amount, note, is_manual)
    VALUES (v_tenant, p_record_id, p_pay_item_id, p_advance_id, v_item.name, v_item.side, v_item.sort_order, round(p_amount, 2), v_note, true);
  END IF;
END $$;
REVOKE ALL ON FUNCTION set_payroll_manual_line(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_payroll_manual_line(UUID, UUID, UUID, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION payroll_transition(p_year INT, p_month INT, p_from TEXT, p_to TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant UUID := current_tenant_id(); v_id UUID; v_status TEXT;
BEGIN
  SELECT id, status INTO v_id, v_status FROM payroll_periods
   WHERE tenant_id = v_tenant AND year = p_year AND month = p_month FOR UPDATE;
  IF v_id IS NULL THEN RAISE EXCEPTION 'ยังไม่มีเงินเดือนของเดือนนี้'; END IF;
  IF v_status <> p_from THEN
    RAISE EXCEPTION 'สถานะตอนนี้คือ % ทำรายการนี้ไม่ได้', v_status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE payroll_periods SET status = p_to WHERE id = v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION payroll_transition(INT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION confirm_payroll_period(p_year INT, p_month INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  PERFORM payroll_require_admin();
  IF NOT EXISTS (SELECT 1 FROM salary_records r JOIN payroll_periods p ON p.id = r.period_id
                  WHERE p.tenant_id = current_tenant_id() AND p.year = p_year AND p.month = p_month) THEN
    RAISE EXCEPTION 'ยังไม่ได้คำนวณเงินเดือนเดือนนี้';
  END IF;
  v_id := payroll_transition(p_year, p_month, 'draft', 'confirmed');
  UPDATE payroll_periods SET confirmed_by = auth.email(), confirmed_at = now() WHERE id = v_id;
END $$;
REVOKE ALL ON FUNCTION confirm_payroll_period(INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_payroll_period(INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION unconfirm_payroll_period(p_year INT, p_month INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  PERFORM payroll_require_admin();
  v_id := payroll_transition(p_year, p_month, 'confirmed', 'draft');
  UPDATE payroll_periods SET confirmed_by = NULL, confirmed_at = NULL WHERE id = v_id;
END $$;
REVOKE ALL ON FUNCTION unconfirm_payroll_period(INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION unconfirm_payroll_period(INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION advance_deducted_closed(p_advance UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(l.amount), 0) FROM salary_record_lines l
  JOIN salary_records r ON r.id = l.salary_record_id
  JOIN payroll_periods p ON p.id = r.period_id
  WHERE l.advance_id = p_advance AND p.status = 'closed'
    AND l.tenant_id = current_tenant_id() AND p.tenant_id = current_tenant_id();
$$;
-- internal: only called from close/reopen (SECURITY DEFINER)
REVOKE ALL ON FUNCTION advance_deducted_closed(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION close_payroll_period(p_year INT, p_month INT, p_paid_date DATE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID; v_tenant UUID := payroll_require_admin();
BEGIN
  IF p_paid_date IS NULL THEN RAISE EXCEPTION 'ใส่วันที่จ่ายก่อนปิดงวด'; END IF;
  v_id := payroll_transition(p_year, p_month, 'confirmed', 'closed');
  UPDATE payroll_periods SET closed_by = auth.email(), closed_at = now(), paid_date = p_paid_date WHERE id = v_id;
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  UPDATE salary_records SET paid_date = p_paid_date WHERE period_id = v_id;
  PERFORM set_config('chang.payroll_bypass', '', true);
  UPDATE salary_advances a SET status = 'settled'
   WHERE a.tenant_id = v_tenant AND a.status = 'approved' AND advance_deducted_closed(a.id) >= a.amount;
END $$;
REVOKE ALL ON FUNCTION close_payroll_period(INT, INT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_payroll_period(INT, INT, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION reopen_payroll_period(p_year INT, p_month INT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID; v_tenant UUID := current_tenant_id(); v_old JSONB;
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'เปิดงวดใหม่ได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'ใส่เหตุผลที่เปิดงวด'; END IF;
  SELECT to_jsonb(p) INTO v_old FROM payroll_periods p WHERE tenant_id = v_tenant AND year = p_year AND month = p_month;
  v_id := payroll_transition(p_year, p_month, 'closed', 'draft');
  UPDATE payroll_periods SET reopen_reason = p_reason, confirmed_by = NULL, confirmed_at = NULL,
                             closed_by = NULL, closed_at = NULL, paid_date = NULL WHERE id = v_id;
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  UPDATE salary_records SET paid_date = NULL WHERE period_id = v_id;
  PERFORM set_config('chang.payroll_bypass', '', true);
  INSERT INTO audit_logs (tenant_id, table_name, record_id, action, user_email, old_values, new_values)
  VALUES (v_tenant, 'payroll_periods', v_id, 'UPDATE', auth.email(), v_old,
          jsonb_build_object('status', 'draft', 'reopen_reason', p_reason));
  UPDATE salary_advances a SET status = 'approved'
   WHERE a.tenant_id = v_tenant AND a.status = 'settled' AND advance_deducted_closed(a.id) < a.amount;
END $$;
REVOKE ALL ON FUNCTION reopen_payroll_period(INT, INT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reopen_payroll_period(INT, INT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION approve_salary_advance(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'อนุมัติได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE salary_advances SET status = 'approved', approved_by = auth.email(), approved_at = now()
   WHERE id = p_id AND tenant_id = current_tenant_id() AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอที่รออนุมัติ'; END IF;
END $$;
REVOKE ALL ON FUNCTION approve_salary_advance(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_salary_advance(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION reject_salary_advance(p_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (is_owner() AND has_module_access('payroll')) THEN
    RAISE EXCEPTION 'ไม่อนุมัติได้เฉพาะเจ้าของ' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE salary_advances SET status = 'rejected', approved_by = auth.email(), approved_at = now(), reject_reason = p_reason
   WHERE id = p_id AND tenant_id = current_tenant_id() AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอที่รออนุมัติ'; END IF;
END $$;
REVOKE ALL ON FUNCTION reject_salary_advance(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_salary_advance(UUID, TEXT) TO authenticated;
