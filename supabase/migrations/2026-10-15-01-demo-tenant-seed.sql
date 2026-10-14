-- ================================================================
-- Demo tenant: marker-guarded seed + reset for customer demos.
-- Design: docs/superpowers/specs/2026-10-14-demo-tenant-seed-design.md
-- Plan:   docs/superpowers/plans/2026-10-14-demo-tenant-seed.md
-- Both public entry points refuse to run unless (a) the caller is a
-- platform admin and (b) the tenant carries app_settings
-- is_demo_tenant='true'. (b) is the only thing between "reset the demo"
-- and "wipe a paying customer", so it is checked inside the functions.
-- ================================================================

-- ── guard + helpers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION demo_tenant_guard(p_tenant UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'demo_not_platform_admin' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE tenant_id = p_tenant AND key = 'is_demo_tenant' AND value = 'true') THEN
    RAISE EXCEPTION 'demo_marker_missing: tenant % is not flagged is_demo_tenant', p_tenant USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION demo_tenant_guard(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION demo_owner_email(p_tenant UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT user_email FROM user_roles WHERE tenant_id = p_tenant AND role = 'OWNER' ORDER BY created_at LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION demo_worker_email(p_tenant UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT user_email FROM user_roles WHERE tenant_id = p_tenant AND role = 'WORKER' ORDER BY created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION demo_owner_email(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION demo_worker_email(UUID) FROM PUBLIC, anon, authenticated;

-- Triggers (numbering, seat limits, created_by defaults) read auth.email()
-- and current_tenant_id(); impersonating the demo owner for the rest of
-- the transaction makes them behave as if the owner typed the data in.
-- Same pattern as supabase/tests/*.sql. The caller's claims are restored
-- by the public entry points before they return.
CREATE OR REPLACE FUNCTION demo_impersonate(p_tenant UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email TEXT := demo_owner_email(p_tenant); v_uid UUID;
BEGIN
  IF v_email IS NULL THEN RAISE EXCEPTION 'demo_no_owner: tenant % has no OWNER role', p_tenant; END IF;
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_email, 'role', 'authenticated', 'sub', COALESCE(v_uid::text, ''))::text, true);
END $$;
REVOKE ALL ON FUNCTION demo_impersonate(UUID) FROM PUBLIC, anon, authenticated;

-- first day of the month k months ago (k=0 → this month)
CREATE OR REPLACE FUNCTION demo_m(k INT) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT (date_trunc('month', current_date) - make_interval(months => k))::date;
$$;

CREATE OR REPLACE FUNCTION demo_seed_core(p_tenant UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bank UUID; v_client UUID; v_site UUID; v_phase UUID; i INT; j INT; k INT;
  v_phase_names TEXT[] := ARRAY['งานเตรียมการและฐานราก','งานโครงสร้าง','งานสถาปัตย์และระบบ','งานตกแต่งและส่งมอบ'];
  v_task_names TEXT[][] := ARRAY[
    ARRAY['รังวัดและวางผัง','ขุดดินและเทฐานราก','ตอกเข็ม/คานคอดิน'],
    ARRAY['เสาและคาน ชั้น 1','พื้นและเสา ชั้น 2','โครงหลังคา'],
    ARRAY['ก่ออิฐฉาบปูน','เดินระบบไฟฟ้า-ประปา','มุงหลังคา/ฝ้า'],
    ARRAY['ปูกระเบื้องและทาสี','ติดตั้งประตู-หน้าต่าง','ทำความสะอาดและส่งมอบ']];
  -- name, status, start month-offset, duration months, contract, client idx, lat, lng, location, deposit_pct, progress(0..1)
  v_sites TEXT[][] := ARRAY[
    ARRAY['บ้านคุณวิชัย ลาดพร้าว','Ongoing','5','7','4850000','1','13.8166','100.5972','ลาดพร้าว 71 กรุงเทพฯ','30','0.85'],
    ARRAY['อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน','Ongoing','4','8','7200000','6','13.8520','100.5450','งามวงศ์วาน นนทบุรี','30','0.70'],
    ARRAY['คลับเฮาส์ หมู่บ้านพฤกษา','Ongoing','3','6','3600000','4','13.9120','100.4210','บางบัวทอง นนทบุรี','0','0.45'],
    ARRAY['โกดังสินค้า บางบัวทอง','Ongoing','2','6','5900000','7','13.9350','100.3980','บางบัวทอง นนทบุรี','30','0.30'],
    ARRAY['รีโนเวทบ้าน คุณนภา','Ongoing','1','3','1250000','2','13.8880','100.4890','เมืองนนทบุรี','0','0.15'],
    ARRAY['บ้านพักอาศัย 2 ชั้น ปากเกร็ด','Completed','8','6','3900000','3','13.9100','100.5000','ปากเกร็ด นนทบุรี','0','1'],
    ARRAY['ร้านกาแฟ เดอะ การ์เด้น','Completed','7','4','1850000','8','13.8700','100.5200','รัตนาธิเบศร์ นนทบุรี','0','1'],
    ARRAY['ต่อเติมครัว คุณสมศักดิ์','Completed','6','2','480000','1','13.8300','100.5700','ลาดพร้าว กรุงเทพฯ','0','1'],
    ARRAY['สำนักงานขาย โครงการเดอะพาร์ค','On Hold','3','5','2900000','5','13.9600','100.4500','ไทรน้อย นนทบุรี','0','0.20'],
    ARRAY['ศาลาริมน้ำ วัดบางพูด','Cancelled','4','3','650000','2','13.9300','100.5100','ปากเกร็ด นนทบุรี','0','0']];
  v_client_names TEXT[] := ARRAY['คุณวิชัย ศรีสุข','คุณนภา พงศ์ไพบูลย์','คุณอรุณ ตั้งใจดี','บจก. พฤกษา พร็อพเพอร์ตี้','บจก. เดอะพาร์ค ดีเวลลอปเมนท์','บจก. งามวงศ์วาน เทรดดิ้ง','หจก. บางบัวทอง โลจิสติกส์','คุณสมศักดิ์ มั่นคง'];
  v_client_types TEXT[] := ARRAY['ENDUSER','ENDUSER','ENDUSER','DEVELOPER','DEVELOPER','ENDUSER','ENDUSER','ENDUSER'];
  v_client_tax TEXT[] := ARRAY[NULL,NULL,NULL,'0105540000011','0105550000022','0125560000033','0123570000044',NULL];
  v_sup TEXT[][] := ARRAY[
    ARRAY['บจก. ไทยวัสดุก่อสร้าง','ปูน/ทราย/หิน','30','transfer'],
    ARRAY['ร้านเจริญเหล็ก','เหล็กเส้น/เหล็กรูปพรรณ','0','transfer'],
    ARRAY['หจก. ปูนดี ซัพพลาย','ปูนซีเมนต์','15','check'],
    ARRAY['ร้านไฟฟ้าสมบูรณ์','อุปกรณ์ไฟฟ้า','0','transfer'],
    ARRAY['บจก. สุขภัณฑ์ไทย','สุขภัณฑ์/ท่อ','30','transfer'],
    ARRAY['ร้านสีสวย','สี/เคมีภัณฑ์','0','transfer'],
    ARRAY['บจก. เครื่องมือช่าง โปร','เครื่องมือ','0','check'],
    ARRAY['ร้านอิฐบล็อก บางใหญ่','อิฐ/บล็อก','7','transfer']];
  v_cat TEXT[][] := ARRAY[
    ARRAY['งานโครงสร้าง (ปูน/เหล็ก)','#8B5E3C','STR','t'],
    ARRAY['งานสถาปัตย์','#C9A227','ARC','t'],
    ARRAY['ไฟฟ้า/ประปา','#2E7D9A','MEP','t'],
    ARRAY['วัสดุสิ้นเปลือง','#7A7A7A','SUP','t'],
    ARRAY['ค่าแรง','#B23A48','', 'f'],
    ARRAY['ค่าเดินทาง','#4F7942','', 'f'],
    ARRAY['เครื่องมือ','#5A4E8C','', 'f'],
    ARRAY['เบ็ดเตล็ด','#999999','', 'f']];
  v_catalog TEXT[][] := ARRAY[
    ARRAY['งานฐานรากและเสาเข็ม','งาน','380000'], ARRAY['งานโครงสร้าง ค.ส.ล.','ตร.ม.','4200'],
    ARRAY['งานก่ออิฐฉาบปูน','ตร.ม.','650'], ARRAY['งานโครงหลังคาและมุงหลังคา','ตร.ม.','1850'],
    ARRAY['งานระบบไฟฟ้า','จุด','1200'], ARRAY['งานระบบประปา-สุขาภิบาล','จุด','1500'],
    ARRAY['งานทาสีภายใน-ภายนอก','ตร.ม.','180'], ARRAY['งานปูกระเบื้อง','ตร.ม.','550'],
    ARRAY['งานฝ้าเพดาน','ตร.ม.','420'], ARRAY['งานประตู-หน้าต่าง','ชุด','8500'],
    ARRAY['งานสุขภัณฑ์','ชุด','12000'], ARRAY['งานรั้วและประตูรั้ว','เมตร','3200'],
    ARRAY['งานถนนและลานจอดรถ','ตร.ม.','950'], ARRAY['งานรื้อถอน','งาน','45000'],
    ARRAY['ค่าดำเนินการและกำไร','งาน','1']];
  v_start DATE; v_end DATE; v_status TEXT; v_prog NUMERIC; v_dur INT;
BEGIN
  -- default site: the T1 reset deletes it, later sections need it (signup trigger creates it with no status)
  IF NOT EXISTS (SELECT 1 FROM sites WHERE tenant_id = p_tenant AND is_default) THEN
    INSERT INTO sites (tenant_id, site_number, name, is_default) VALUES (p_tenant, 'SD-0000-000', 'ส่วนกลาง', true);
  END IF;

  -- company profile
  UPDATE tenants SET
    address = '99/12 หมู่ 5 ถ.รัตนาธิเบศร์ ต.บางกระสอ อ.เมืองนนทบุรี จ.นนทบุรี 11000',
    tax_id = '0125599000001', phone = '02-000-0000', website = 'www.sangdee-demo.co.th',
    default_payment_terms = 'ชำระมัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน หักประกันผลงาน 5% คืนภายใน 90 วันหลังส่งมอบ',
    default_notes = 'ราคานี้ยังไม่รวมค่าขออนุญาตก่อสร้างและค่าธรรมเนียมราชการ',
    document_template_key = 'classic'
  WHERE id = p_tenant;

  INSERT INTO bank_accounts (tenant_id, bank_name, account_name, account_no, vat_category, is_default, active)
  VALUES (p_tenant, 'ธนาคารกสิกรไทย', 'บจก. สร้างดี คอนสตรัคชั่น', '012-3-45678-9', 'vat', true, true) RETURNING id INTO v_bank;

  -- replace the signup defaults (aluminium-flavoured) with contractor categories
  DELETE FROM expense_categories WHERE tenant_id = p_tenant;
  FOR i IN 1..8 LOOP
    INSERT INTO expense_categories (tenant_id, name, color, sort_order, use_for_cost_deduction, code_prefix)
    VALUES (p_tenant, v_cat[i][1], v_cat[i][2], i, v_cat[i][4] = 't', NULLIF(v_cat[i][3], ''));
  END LOOP;
  INSERT INTO units (tenant_id, name) SELECT p_tenant, u FROM unnest(ARRAY['งาน','ตร.ม.','จุด','ชุด','เมตร','ถุง','เส้น','ก้อน','คิว','กล่อง']) u;

  FOR i IN 1..8 LOOP
    INSERT INTO clients (tenant_id, name, client_type, tax_id, phone, address, province, contact_person)
    VALUES (p_tenant, v_client_names[i], v_client_types[i], v_client_tax[i], '08' || lpad((10000000 + i * 1234567)::text, 8, '0'),
            (ARRAY['12/3 ซ.ลาดพร้าว 71 แขวงวังทองหลาง กรุงเทพฯ 10310','45 ม.2 ต.บางกระสอ อ.เมืองนนทบุรี 11000','88/9 ม.7 ต.บางพูด อ.ปากเกร็ด นนทบุรี 11120','1 อาคารพฤกษา ถ.แจ้งวัฒนะ ปากเกร็ด นนทบุรี 11120','55 ถ.บางกรวย-ไทรน้อย อ.ไทรน้อย นนทบุรี 11150','210 ถ.งามวงศ์วาน อ.เมืองนนทบุรี 11000','9/9 ม.4 ต.ละหาร อ.บางบัวทอง นนทบุรี 11110','23 ซ.ลาดพร้าว 101 แขวงคลองจั่น กรุงเทพฯ 10240'])[i],
            (ARRAY['กรุงเทพมหานคร','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','กรุงเทพมหานคร'])[i],
            CASE WHEN v_client_types[i] = 'DEVELOPER' THEN 'คุณประสิทธิ์ (ฝ่ายจัดซื้อ)' ELSE NULL END);
  END LOOP;

  FOR i IN 1..8 LOOP
    INSERT INTO suppliers (tenant_id, name, category, credit_days, default_payment_method, phone, payment_terms, tax_id)
    VALUES (p_tenant, v_sup[i][1], to_jsonb(ARRAY[v_sup[i][2]]), v_sup[i][3]::int, v_sup[i][4], '02-5' || lpad((10000 + i * 777)::text, 5, '0'),
            CASE WHEN v_sup[i][3]::int > 0 THEN 'เครดิต ' || v_sup[i][3] || ' วัน' ELSE 'เงินสด' END,
            '01255' || lpad((60000000 + i * 1111)::text, 8, '0'));
  END LOOP;

  FOR i IN 1..15 LOOP
    INSERT INTO catalog_items (tenant_id, name, unit, default_unit_price, active)
    VALUES (p_tenant, v_catalog[i][1], v_catalog[i][2], v_catalog[i][3]::numeric, true);
  END LOOP;

  -- sites, phases, tasks
  FOR i IN 1..10 LOOP
    v_status := v_sites[i][2]; v_dur := v_sites[i][4]::int; v_prog := v_sites[i][11]::numeric;
    v_start := demo_m(v_sites[i][3]::int) + (i * 3);
    v_end := (v_start + make_interval(months => v_dur))::date;
    SELECT id INTO v_client FROM clients WHERE tenant_id = p_tenant AND name = v_client_names[v_sites[i][6]::int];
    INSERT INTO sites (tenant_id, site_number, name, status, start_date, end_date, contract_value, contract_value_no_vat, has_vat,
                       default_vat_pct, default_tax_withheld_pct, default_retention_pct, default_retention_period_days, default_deposit_pct,
                       retention_released, retention_released_date, client_id, client_name, location, lat, lng, distance_km, travel_minutes, is_default, notes)
    VALUES (p_tenant, 'SD-' || to_char(v_start, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_sites[i][1], v_status, v_start,
            CASE WHEN v_status = 'Cancelled' THEN NULL ELSE v_end END,
            v_sites[i][5]::numeric * 1.07, v_sites[i][5]::numeric, true, 7, 3, 5, 90, v_sites[i][10]::numeric,
            (i = 8), CASE WHEN i = 8 THEN (v_end + 90) ELSE NULL END,
            v_client, v_client_names[v_sites[i][6]::int], v_sites[i][9], v_sites[i][7]::numeric, v_sites[i][8]::numeric,
            8 + i * 2.5, 20 + i * 4, false,
            CASE v_status WHEN 'On Hold' THEN 'ลูกค้าขอชะลอรอใบอนุญาต' WHEN 'Cancelled' THEN 'ลูกค้ายกเลิกก่อนเริ่มงาน' ELSE NULL END)
    RETURNING id INTO v_site;
    FOR j IN 1..4 LOOP
      INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct, status)
      VALUES (p_tenant, v_site, v_phase_names[j], j,
              (v_start + ((j - 1) * v_dur * 30 / 4))::date, (v_start + (j * v_dur * 30 / 4) - 1)::date, 25,
              CASE WHEN v_prog >= j * 0.25 THEN 'done' WHEN v_prog > (j - 1) * 0.25 THEN 'in_progress' ELSE 'not_started' END)
      RETURNING id INTO v_phase;
      FOR k IN 1..3 LOOP
        INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, sort_order, due_date, status)
        VALUES (p_tenant, v_site, v_phase, v_task_names[j][k], k, (v_start + ((j - 1) * v_dur * 30 / 4) + k * v_dur * 10 / 4)::date,
                CASE WHEN v_prog >= (j - 1) * 0.25 + k * 0.25 / 3 THEN 'done'
                     WHEN v_prog > (j - 1) * 0.25 + (k - 1) * 0.25 / 3 THEN 'in_progress' ELSE 'not_started' END);
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'clients', (SELECT count(*) FROM clients WHERE tenant_id = p_tenant),
    'suppliers', (SELECT count(*) FROM suppliers WHERE tenant_id = p_tenant),
    'catalog_items', (SELECT count(*) FROM catalog_items WHERE tenant_id = p_tenant),
    'expense_categories', (SELECT count(*) FROM expense_categories WHERE tenant_id = p_tenant),
    'sites', (SELECT count(*) FROM sites WHERE tenant_id = p_tenant AND NOT is_default),
    'site_phases', (SELECT count(*) FROM site_phases WHERE tenant_id = p_tenant),
    'phase_tasks', (SELECT count(*) FROM phase_tasks WHERE tenant_id = p_tenant));
END $$;
REVOKE ALL ON FUNCTION demo_seed_core(UUID) FROM PUBLIC, anon, authenticated;

-- ── seed entry point (sections are added by later tasks) ───────
CREATE OR REPLACE FUNCTION seed_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_claims TEXT := current_setting('request.jwt.claims', true); v_out JSONB := '{}'::jsonb;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM setseed(0.42);
  PERFORM demo_impersonate(p_tenant_id);
  v_out := v_out || demo_seed_core(p_tenant_id);
  -- sections: ... (Tasks 3-5)
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION seed_demo_tenant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION seed_demo_tenant(UUID) TO authenticated;

-- ── reset ───────────────────────────────────────────────────────
-- Deletes every row of the tenant in every public table that has a
-- tenant_id column, except the kept list. Order is discovered at run
-- time by retrying: a DELETE that hits a foreign key (or a "has children"
-- trigger such as expenses_block_receipt_bill_delete) is caught in a
-- sub-transaction and retried on the next pass once its children are
-- gone. A pass that deletes nothing while rows remain means a real
-- cycle or an unknown blocker: the function raises with the table list
-- and the whole transaction rolls back, so the demo is never half-empty.
CREATE OR REPLACE FUNCTION reset_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claims TEXT := current_setting('request.jwt.claims', true);
  v_keep TEXT[] := ARRAY['tenants','user_roles','tenant_modules','tenant_status_log','platform_admins','packages','package_modules'];
  v_tables TEXT[]; v_remaining TEXT[]; v_t TEXT; v_deleted JSONB := '{}'::jsonb;
  v_pass INT := 0; v_progress BOOLEAN; v_n BIGINT; v_err TEXT; v_errs JSONB := '{}'::jsonb; v_seed JSONB;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_tables
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    AND NOT (c.table_name = ANY (v_keep)) AND c.table_name NOT LIKE 'contractor_type%';
  v_remaining := v_tables;
  LOOP
    v_pass := v_pass + 1; v_progress := false;
    IF v_pass > 25 THEN EXIT; END IF;
    FOREACH v_t IN ARRAY v_remaining LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_t) USING p_tenant_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_deleted := v_deleted || jsonb_build_object(v_t, COALESCE((v_deleted->>v_t)::bigint, 0) + v_n);
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
    RAISE EXCEPTION 'demo_reset_stuck: could not delete from % (last errors %)', v_remaining, v_errs;
  END IF;
  -- keep the marker and the two settings the signup trigger always creates
  INSERT INTO app_settings (tenant_id, key, value) VALUES
    (p_tenant_id, 'is_demo_tenant', 'true'),
    (p_tenant_id, 'travel_rate_per_km', '20'),
    (p_tenant_id, 'holiday_pay_multiplier', '1.5');
  v_seed := seed_demo_tenant(p_tenant_id);
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object('deleted', v_deleted, 'passes', v_pass, 'seeded', v_seed);
END $$;
REVOKE ALL ON FUNCTION reset_demo_tenant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reset_demo_tenant(UUID) TO authenticated;

-- ── platform_list_tenants gains is_demo ─────────────────────────
DROP FUNCTION IF EXISTS platform_list_tenants();
CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ, plan_expires_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, price_monthly NUMERIC, price_yearly NUMERIC, created_at TIMESTAMPTZ,
  is_demo BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.plan_expires_at, t.package_id, p.name,
         p.price_monthly, p.price_yearly, t.created_at,
         EXISTS (SELECT 1 FROM app_settings a WHERE a.tenant_id = t.id AND a.key = 'is_demo_tenant' AND a.value = 'true') AS is_demo
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;
REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
