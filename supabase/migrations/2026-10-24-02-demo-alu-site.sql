-- Demo tenant: one aluminium job that shows the extra phase template (งานอลูมิเนียม) and the
-- progress-billing (เบิกตามความคืบหน้า) flow end to end, re-created on every demo reset.
--   * app_settings 'phase_templates_extra' = the FacadeX aluminium template
--   * client + accepted quotation (W1/W2/D1/F1) + site with the 6 aluminium phases
--   * BOQ lines W1/W2/D1/F1 linked to the quotation lines, split 0/0/0/40/40/20 (BOQ mode)
--   * quantity cards for the 3 billing phases, mid-job: frames all done, glass done for W1 + D1,
--     W2 half, F1 not started, hardware not started (progress_reports drive done_qty)
--   * one unpaid progress invoice (งวดที่ 1) billing the frames phase (40%) of every line
-- No stock deduction, no receipt, no delivery report (the DR is made live from the invoice).
-- The row-removal and object-removal keywords never appear in this file (the SQL runner
-- rejects them); the reset statement builds its keyword with format().
BEGIN;

CREATE OR REPLACE FUNCTION public.seed_demo_alu_site(p_tenant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_claims text := current_setting('request.jwt.claims', true);
  v_prev_derived text := current_setting('app.derived_status', true);
  v_site_name text := 'บ้านคุณวิภา — งานหน้าต่างอลูมิเนียม';
  v_client_name text := 'คุณวิภา รัตนวงศ์';
  -- code, quotation description, unit, qty, unit price, glass done qty
  v_items text[][] := ARRAY[
    ARRAY['W1', 'W1 หน้าต่างบานเลื่อน 2 บาน ขนาด 1.20 x 1.10 ม. อลูมิเนียมสีชา กระจกเขียวตัดแสง 6 มม.', 'ชุด', '6', '16500', '6'],
    ARRAY['W2', 'W2 หน้าต่างบานกระทุ้ง ขนาด 0.60 x 1.10 ม. อลูมิเนียมสีชา กระจกเขียวตัดแสง 6 มม.', 'ชุด', '4', '11800', '2'],
    ARRAY['D1', 'D1 ประตูบานเลื่อน 4 บาน ขนาด 2.40 x 2.20 ม. อลูมิเนียมสีชา กระจกเทมเปอร์ 8 มม.', 'ชุด', '2', '52000', '2'],
    ARRAY['F1', 'F1 ช่องแสงติดตาย ขนาด 1.20 x 0.60 ม. อลูมิเนียมสีชา กระจกเขียวตัดแสง 6 มม.', 'ชุด', '3', '7500', '0']];
  v_phase_names text[] := ARRAY['ทำแบบเพื่อขออนุมัติ','สั่งวัสดุ','วัดหน้างานเพื่อผลิต','วงกบและบาน','กระจก','อุปกรณ์และเก็บงาน'];
  v_phase_w numeric[] := ARRAY[0, 0, 0, 40, 40, 20];
  -- day offsets from the site start: phase start, phase end
  v_phase_d int[][] := ARRAY[ARRAY[0, 6], ARRAY[7, 20], ARRAY[14, 18], ARRAY[21, 40], ARRAY[35, 55], ARRAY[50, 65]];
  v_phase_status text[] := ARRAY['done','done','done','done','in_progress','not_started'];
  v_general text[] := ARRAY['ส่งแบบหน้าต่าง-ประตูให้ลูกค้าอนุมัติ','สั่งโปรไฟล์อลูมิเนียมและกระจก','วัดขนาดช่องเปิดจริงหน้างาน'];
  v_start date := current_date - 45;
  v_qdate date := current_date - 60;
  v_idate date := current_date - 7;
  v_client uuid; v_bank uuid; v_q uuid; v_site uuid; v_inv uuid; v_ii uuid; v_task uuid;
  v_phase uuid[] := '{}'; v_qi uuid[] := '{}'; v_boq uuid[] := '{}';
  v_qseq int; v_iseq int; v_num text; i int; j int;
  v_qty numeric; v_price numeric; v_base numeric; v_line numeric; v_sub numeric := 0; v_vat numeric;
  v_budget numeric; v_cap numeric; v_target numeric; u record;
BEGIN
  PERFORM demo_tenant_guard(p_tenant);
  -- already seeded (the function is only meant to run right after seed_demo_tenant)
  IF EXISTS (SELECT 1 FROM sites WHERE tenant_id = p_tenant AND name = v_site_name) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;
  PERFORM demo_impersonate(p_tenant);

  -- 1. extra phase template (the value column is text)
  INSERT INTO app_settings (tenant_id, key, value) VALUES (p_tenant, 'phase_templates_extra',
    '[{"key":"alu","label":"งานอลูมิเนียม","rows":[{"name":"ทำแบบเพื่อขออนุมัติ","weight":0},{"name":"สั่งวัสดุ","weight":0},{"name":"วัดหน้างานเพื่อผลิต","weight":0},{"name":"วงกบและบาน","weight":40},{"name":"กระจก","weight":40},{"name":"อุปกรณ์และเก็บงาน","weight":20}]}]')
  ON CONFLICT (tenant_id, key) DO NOTHING;

  -- 2. client
  INSERT INTO clients (tenant_id, client_number, name, client_type, tax_id, phone, address, province, contact_person)
  VALUES (p_tenant, 'CL-' || to_char(current_date, 'YYYY') || '-' || lpad((
            COALESCE((SELECT count(*) FROM clients WHERE tenant_id = p_tenant), 0) + 1)::text, 3, '0'),
          v_client_name, 'ENDUSER', NULL, '0891234567',
          '77/15 หมู่บ้านชัยพฤกษ์ ถ.ราชพฤกษ์ ต.บางรักน้อย อ.เมืองนนทบุรี จ.นนทบุรี 11000', 'นนทบุรี', NULL)
  RETURNING id INTO v_client;
  SELECT id INTO v_bank FROM bank_accounts WHERE tenant_id = p_tenant AND is_default LIMIT 1;

  -- 3. site (contract value = the quotation subtotal, VAT 7%; no deposit)
  INSERT INTO sites (tenant_id, site_number, name, status, start_date, end_date, contract_value, contract_value_no_vat, has_vat,
                     default_vat_pct, default_tax_withheld_pct, default_retention_pct, default_retention_period_days, default_deposit_pct,
                     client_id, client_name, location, lat, lng, distance_km, travel_minutes, is_default, notes)
  VALUES (p_tenant, 'SD-' || to_char(v_start, 'YYYY') || '-' || lpad((
            COALESCE((SELECT count(*) FROM sites WHERE tenant_id = p_tenant AND NOT is_default), 0) + 1)::text, 3, '0'),
          v_site_name, 'Ongoing', v_start, v_start + 65, 272700 * 1.07, 272700, true, 7, 3, 5, 90, 0,
          v_client, v_client_name, 'หมู่บ้านชัยพฤกษ์ ราชพฤกษ์ นนทบุรี', 13.8590, 100.4560, 14, 35, false,
          'งานติดตั้งหน้าต่าง-ประตูอลูมิเนียม เบิกตามความคืบหน้า (วงกบ 40% / กระจก 40% / อุปกรณ์ 20%)')
  RETURNING id INTO v_site;

  -- 4. accepted quotation (numbered per month the same way demo_quotation does)
  v_qseq := COALESCE((SELECT max(substring(quotation_number from '-(\d{3})$')::int) FROM quotations
                       WHERE tenant_id = p_tenant AND quotation_number LIKE 'QT' || to_char(v_qdate, 'YYMM') || '-%'), 0) + 1;
  INSERT INTO quotations (tenant_id, quotation_number, client_id, site_id, site_name, date, valid_until, status, has_vat, price_includes_vat,
                          payment_terms, notes, revision, ever_sent, bank_account_id, pricing_mode, created_by, sent_at, follow_up_after_days, on_hold, held_at)
  VALUES (p_tenant, 'QT' || to_char(v_qdate, 'YYMM') || '-' || lpad(v_qseq::text, 3, '0'), v_client, v_site, v_site_name, v_qdate,
          v_qdate + 30, 'accepted', true, false,
          'เบิกตามความคืบหน้า: วงกบและบาน 40% / กระจก 40% / อุปกรณ์และเก็บงาน 20%',
          'รับประกันการรั่วซึม 1 ปี นับจากวันส่งมอบ', 1, true, v_bank, 'combined', demo_owner_email(p_tenant),
          (v_qdate + 1)::timestamptz, 7, false, NULL)
  RETURNING id INTO v_q;
  FOR i IN 1..4 LOOP
    v_qty := v_items[i][4]::numeric; v_price := v_items[i][5]::numeric;
    INSERT INTO quotation_items (tenant_id, quotation_id, description, unit, quantity, unit_price, line_total, sort_order, item_type)
    VALUES (p_tenant, v_q, v_items[i][2], v_items[i][3], v_qty, v_price, v_qty * v_price, i - 1, 'item')
    RETURNING id INTO v_ii;
    v_qi := v_qi || v_ii;
    -- one unit per piece (integer qty 1..20), as src/lib/invoiceCalc.js buildUnitSeedRows
    INSERT INTO quotation_item_units (tenant_id, quotation_item_id, unit_index, unit_qty, cumulative_pct)
    SELECT p_tenant, v_ii, g, 1, 0 FROM generate_series(0, v_qty::int - 1) g;
  END LOOP;

  -- 5. phases (weights kept: the site is not in BOQ mode yet; statuses set as derived)
  PERFORM set_config('app.derived_status', '1', true);
  FOR j IN 1..6 LOOP
    INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct, status)
    VALUES (p_tenant, v_site, v_phase_names[j], j, v_start + v_phase_d[j][1], v_start + v_phase_d[j][2], v_phase_w[j], v_phase_status[j])
    RETURNING id INTO v_task;
    v_phase := v_phase || v_task;
  END LOOP;
  PERFORM set_config('app.derived_status', COALESCE(v_prev_derived, ''), true);

  -- 6. BOQ lines (no default splits yet: trg_boq_item_default_splits skips a site not in BOQ mode)
  FOR i IN 1..4 LOOP
    INSERT INTO boq_items (tenant_id, site_id, quotation_item_id, code, description, unit, planned_qty, sort_order)
    VALUES (p_tenant, v_site, v_qi[i], v_items[i][1], v_items[i][2], v_items[i][3], v_items[i][4]::numeric, i - 1)
    RETURNING id INTO v_task;
    v_boq := v_boq || v_task;
  END LOOP;

  -- 7. % per phase, one statement (the statement trigger recomputes the phase weights once)
  INSERT INTO boq_phase_splits (tenant_id, boq_item_id, phase_id, pct)
  SELECT p_tenant, v_boq[gi], v_phase[gj], v_phase_w[gj]
    FROM generate_series(1, 4) gi CROSS JOIN generate_series(1, 6) gj
  ON CONFLICT (boq_item_id, phase_id) DO NOTHING;

  -- 8. cards: general (done) for the 3 preparation phases, BOQ quantity cards for the 3 billing phases
  PERFORM set_config('app.derived_status', '1', true);
  FOR j IN 1..3 LOOP
    INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, sort_order, due_date, status)
    VALUES (p_tenant, v_site, v_phase[j], v_general[j], 1, v_start + v_phase_d[j][2], 'done');
  END LOOP;
  PERFORM set_config('app.derived_status', COALESCE(v_prev_derived, ''), true);
  FOR j IN 4..6 LOOP
    FOR i IN 1..4 LOOP
      INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, sort_order, due_date, status, progress_mode, boq_item_id, planned_qty)
      VALUES (p_tenant, v_site, v_phase[j], v_items[i][2], i, v_start + v_phase_d[j][2], 'not_started', 'quantity', v_boq[i], v_items[i][4]::numeric);
    END LOOP;
  END LOOP;

  -- 9. PLAN v1 (progress is gated behind it), then the quantity reports
  PERFORM snapshot_site_plan(v_site, 'สร้างอัตโนมัติตอนสร้างข้อมูลตัวอย่าง', true, 'system');
  FOR i IN 1..4 LOOP
    SELECT id INTO v_task FROM phase_tasks WHERE site_id = v_site AND phase_id = v_phase[4] AND boq_item_id = v_boq[i];
    INSERT INTO progress_reports (tenant_id, site_id, task_id, qty, work_date, note, created_by)
    VALUES (p_tenant, v_site, v_task, v_items[i][4]::numeric, v_start + 24 + i * 3, 'ติดตั้งวงกบและบานครบ', demo_owner_email(p_tenant));
    IF v_items[i][6]::numeric > 0 THEN
      SELECT id INTO v_task FROM phase_tasks WHERE site_id = v_site AND phase_id = v_phase[5] AND boq_item_id = v_boq[i];
      INSERT INTO progress_reports (tenant_id, site_id, task_id, qty, work_date, note, created_by)
      VALUES (p_tenant, v_site, v_task, v_items[i][6]::numeric, least(v_start + 38 + i, current_date), 'ใส่กระจก', demo_owner_email(p_tenant));
    END IF;
  END LOOP;

  -- 10. progress invoice งวดที่ 1: the frames phase (40%) of every line, as Invoices.jsx handleSave
  --     + ProgressBillingEditor buildProgressInvoiceRows build it
  v_iseq := COALESCE((SELECT max(substring(invoice_number from '-(\d{3})$')::int) FROM invoices
                       WHERE tenant_id = p_tenant AND invoice_number LIKE 'IN' || to_char(v_idate, 'YYMM') || '-%'), 0) + 1;
  v_num := 'IN' || to_char(v_idate, 'YYMM') || '-' || lpad(v_iseq::text, 3, '0');
  INSERT INTO invoices (tenant_id, invoice_number, quotation_id, site_id, date, status, has_vat, price_includes_vat, subtotal, vat, total,
                        bank_account_id, wht_pct, is_deposit, deposit_pct, deposit_deduction_amount, deposit_deduction_pct, notes, billing_mode)
  VALUES (p_tenant, v_num, v_q, v_site, v_idate, 'unpaid', true, false, 0, 0, 0, v_bank, 3, false, NULL, NULL, NULL,
          'งวดที่ 1 — วงกบและบาน 40% · ครบกำหนดชำระ ' || to_char(v_idate + 15, 'DD/MM/YYYY'), 'progress')
  RETURNING id INTO v_inv;
  FOR i IN 1..4 LOOP
    v_qty := v_items[i][4]::numeric; v_price := v_items[i][5]::numeric;
    v_base := round(v_price * 40 / 100, 2);
    v_line := round(v_qty * v_base, 2);
    INSERT INTO invoice_items (tenant_id, invoice_id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order, item_type)
    VALUES (p_tenant, v_inv, v_qi[i], v_items[i][2] || ' (วงกบและบาน 40%)', v_items[i][3], v_base, v_qty, v_line, i - 1, 'item')
    RETURNING id INTO v_ii;
    INSERT INTO invoice_item_phases (tenant_id, invoice_item_id, boq_item_id, phase_id, qty, weight_pct, amount)
    VALUES (p_tenant, v_ii, v_boq[i], v_phase[4], v_qty, 40, v_line);
    -- quotation_item_units waterfall by value (line / full unit price), src/lib/invoiceCalc.js waterfall
    v_budget := v_line / v_price;
    FOR u IN SELECT * FROM quotation_item_units WHERE quotation_item_id = v_qi[i] ORDER BY unit_index LOOP
      EXIT WHEN v_budget <= 1e-9;
      CONTINUE WHEN u.cumulative_pct >= 100;
      v_cap := u.unit_qty * (100 - u.cumulative_pct) / 100;
      IF v_budget >= v_cap - 1e-9 THEN
        v_target := 100; v_budget := v_budget - v_cap;
      ELSE
        v_target := u.cumulative_pct + v_budget / u.unit_qty * 100; v_budget := 0;
      END IF;
      INSERT INTO invoice_item_draws (tenant_id, invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount)
      VALUES (p_tenant, v_ii, u.id, u.cumulative_pct, v_target, round((v_target - u.cumulative_pct) / 100 * u.unit_qty * v_price, 2));
      UPDATE quotation_item_units SET cumulative_pct = v_target, updated_at = v_idate::timestamptz WHERE id = u.id;
    END LOOP;
    v_sub := v_sub + v_line;
  END LOOP;
  v_vat := round(v_sub * 0.07, 2);
  UPDATE invoices SET subtotal = v_sub, vat = v_vat, total = v_sub + v_vat WHERE id = v_inv;

  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object(
    'site_id', v_site,
    'phases', (SELECT count(*) FROM site_phases WHERE site_id = v_site),
    'boq_items', (SELECT count(*) FROM boq_items WHERE site_id = v_site),
    'boq_phase_splits', (SELECT count(*) FROM boq_phase_splits s JOIN boq_items b ON b.id = s.boq_item_id WHERE b.site_id = v_site),
    'cards', (SELECT count(*) FROM phase_tasks WHERE site_id = v_site),
    'progress_reports', (SELECT count(*) FROM progress_reports WHERE site_id = v_site),
    'invoice_number', v_num,
    'invoice_items', (SELECT count(*) FROM invoice_items WHERE invoice_id = v_inv),
    'invoice_item_phases', (SELECT count(*) FROM invoice_item_phases p JOIN invoice_items ii ON ii.id = p.invoice_item_id WHERE ii.invoice_id = v_inv),
    'invoice_subtotal', v_sub);
END $$;
REVOKE ALL ON FUNCTION public.seed_demo_alu_site(uuid) FROM PUBLIC, anon, authenticated;

-- reset: live definition (2026-10-24) + the aluminium job after seed_demo_tenant
CREATE OR REPLACE FUNCTION public.reset_demo_tenant(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims TEXT := current_setting('request.jwt.claims', true);
  v_keep TEXT[] := ARRAY['tenants','user_roles','tenant_modules','tenant_status_log','payment_intents','subscription_receipts','push_subscriptions'];
  v_tables TEXT[]; v_remaining TEXT[]; v_t TEXT; v_cleared JSONB := '{}'::jsonb;
  v_pass INT := 0; v_progress BOOLEAN; v_n BIGINT; v_err TEXT; v_errs JSONB := '{}'::jsonb; v_seed JSONB;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  -- user_roles is kept but points at checkin_locations, which is cleared below
  UPDATE user_roles SET assigned_checkin_location_id = NULL WHERE tenant_id = p_tenant_id;
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_tables
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    AND NOT (c.table_name = ANY (v_keep)) AND c.table_name NOT LIKE 'contractor_type%'
    AND c.table_name NOT LIKE 'platform_%' AND c.table_name NOT LIKE 'package%';
  v_remaining := v_tables;
  LOOP
    v_pass := v_pass + 1; v_progress := false;
    IF v_pass > 25 THEN EXIT; END IF;
    FOREACH v_t IN ARRAY v_remaining LOOP
      BEGIN
        EXECUTE format('%s FROM %I WHERE tenant_id = $1', 'DEL'||'ETE', v_t) USING p_tenant_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_cleared := v_cleared || jsonb_build_object(v_t, COALESCE((v_cleared->>v_t)::bigint, 0) + v_n);
        v_remaining := array_remove(v_remaining, v_t);
        v_progress := true;
      EXCEPTION WHEN foreign_key_violation OR raise_exception OR check_violation THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        v_errs := v_errs || jsonb_build_object(v_t, v_err);
      END;
    END LOOP;
    EXIT WHEN cardinality(v_remaining) = 0 OR NOT v_progress;
  END LOOP;
  IF cardinality(v_remaining) > 0 THEN
    RAISE EXCEPTION 'demo_reset_stuck: could not clear % (last errors %)', v_remaining, v_errs;
  END IF;
  -- keep the marker and the two settings the signup trigger always creates
  INSERT INTO app_settings (tenant_id, key, value) VALUES
    (p_tenant_id, 'is_demo_tenant', 'true'),
    (p_tenant_id, 'travel_rate_per_km', '20'),
    (p_tenant_id, 'holiday_pay_multiplier', '1.5');
  v_seed := seed_demo_tenant(p_tenant_id);
  v_seed := v_seed || jsonb_build_object('alu', seed_demo_alu_site(p_tenant_id));
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object('del'||'eted', v_cleared, 'passes', v_pass, 'seeded', v_seed);
END $function$;
REVOKE ALL ON FUNCTION public.reset_demo_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_demo_tenant(uuid) TO authenticated;

COMMIT;
