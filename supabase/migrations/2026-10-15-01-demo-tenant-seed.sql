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
CREATE OR REPLACE FUNCTION demo_m(k INT) RETURNS DATE LANGUAGE sql STABLE AS $$
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

-- ── sales: quotations, invoices, receipts, incomes ───────────
-- One quotation with items. p_lines: [{"name":..,"qty":..,"price":..} | {"desc":..} | {"note":..}]
CREATE OR REPLACE FUNCTION demo_quotation(p_tenant UUID, p_site_name TEXT, p_client_name TEXT, p_date DATE, p_seq INT,
                                          p_status TEXT, p_lines JSONB, p_opts JSONB DEFAULT '{}'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_q UUID; v_site UUID; v_client UUID; v_bank UUID; l JSONB; i INT := 0; v_cat UUID; v_unit TEXT; v_item UUID;
  v_qty NUMERIC; v_price NUMERIC; v_snapshot JSONB; v_qseq INT;
BEGIN
  SELECT id INTO v_client FROM clients WHERE tenant_id = p_tenant AND name = p_client_name;
  IF v_client IS NULL THEN RAISE EXCEPTION 'demo_quotation: client % not found', p_client_name; END IF;
  IF p_site_name IS NOT NULL AND NOT COALESCE((p_opts->>'site_name_only')::boolean, false) THEN
    SELECT id INTO v_site FROM sites WHERE tenant_id = p_tenant AND name = p_site_name;
    IF v_site IS NULL THEN RAISE EXCEPTION 'demo_quotation: site % not found', p_site_name; END IF;
  END IF;
  SELECT id INTO v_bank FROM bank_accounts WHERE tenant_id = p_tenant AND is_default LIMIT 1;
  -- demo is reset on arbitrary dates; literal seqs collided, so compute the next number per month
  v_qseq := COALESCE((SELECT max(substring(quotation_number from '-(\d{3})$')::int) FROM quotations WHERE tenant_id = p_tenant AND quotation_number LIKE 'QT' || to_char(p_date, 'YYMM') || '-%'), 0) + 1;
  INSERT INTO quotations (tenant_id, quotation_number, client_id, site_id, site_name, date, valid_until, status, has_vat, price_includes_vat,
                          payment_terms, notes, revision, ever_sent, bank_account_id, pricing_mode, created_by, sent_at, follow_up_after_days, on_hold, held_at)
  VALUES (p_tenant, 'QT' || to_char(p_date, 'YYMM') || '-' || lpad(v_qseq::text, 3, '0'), v_client, v_site, p_site_name, p_date,
          COALESCE((p_opts->>'valid_until')::date, p_date + 30), p_status, true, false,
          'ชำระมัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน', 'ราคานี้ยังไม่รวมค่าขออนุญาตก่อสร้าง',
          CASE WHEN COALESCE((p_opts->>'revision_snapshot')::boolean, false) THEN 2 ELSE 1 END,
          p_status <> 'draft', v_bank, 'combined', demo_owner_email(p_tenant),
          CASE WHEN p_status <> 'draft' THEN (p_date + 1)::timestamptz ELSE NULL END, 7,
          COALESCE((p_opts->>'on_hold')::boolean, false), CASE WHEN COALESCE((p_opts->>'on_hold')::boolean, false) THEN now() - interval '3 days' ELSE NULL END)
  RETURNING id INTO v_q;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF l ? 'name' THEN
      SELECT id, unit INTO v_cat, v_unit FROM catalog_items WHERE tenant_id = p_tenant AND name = l->>'name';
      IF v_cat IS NULL THEN RAISE EXCEPTION 'demo_quotation: catalog item % not found', l->>'name'; END IF;
      v_qty := (l->>'qty')::numeric; v_price := (l->>'price')::numeric;
      INSERT INTO quotation_items (tenant_id, quotation_id, catalog_item_id, description, unit, quantity, unit_price, line_total, sort_order, item_type)
      VALUES (p_tenant, v_q, v_cat, l->>'name', v_unit, v_qty, v_price, v_qty * v_price, i, 'item') RETURNING id INTO v_item;
      -- units exactly as src/lib/invoiceCalc.js buildUnitSeedRows: integer qty 1..20 → one unit each, else one unit of the whole qty
      IF v_qty = trunc(v_qty) AND v_qty > 0 AND v_qty <= 20 THEN
        INSERT INTO quotation_item_units (tenant_id, quotation_item_id, unit_index, unit_qty, cumulative_pct)
        SELECT p_tenant, v_item, g, 1, 0 FROM generate_series(0, v_qty::int - 1) g;
      ELSE
        INSERT INTO quotation_item_units (tenant_id, quotation_item_id, unit_index, unit_qty, cumulative_pct) VALUES (p_tenant, v_item, 0, v_qty, 0);
      END IF;
    ELSIF l ? 'desc' THEN
      INSERT INTO quotation_items (tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order, item_type)
      VALUES (p_tenant, v_q, l->>'desc', 0, 0, 0, i, 'item_description');
    ELSE
      INSERT INTO quotation_items (tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order, item_type)
      VALUES (p_tenant, v_q, l->>'note', 0, 0, 0, i, 'note');
    END IF;
    i := i + 1;
  END LOOP;
  IF COALESCE((p_opts->>'revision_snapshot')::boolean, false) THEN
    -- revision 1 snapshot: same lines, first item 10% cheaper (what the client negotiated away)
    SELECT jsonb_build_object('client_id', v_client, 'client_name', p_client_name, 'date', p_date - 7, 'valid_until', p_date + 23,
      'has_vat', true, 'price_includes_vat', false, 'discount_amount', 0, 'discount_pct', 0, 'pricing_mode', 'combined',
      'payment_terms', 'ชำระมัดจำ 30% เมื่อเซ็นสัญญา', 'notes', NULL, 'bank_account', NULL,
      'items', jsonb_agg(jsonb_build_object('description', x.description, 'unit', x.unit, 'quantity', x.quantity,
                 'unit_price', CASE WHEN x.sort_order = 0 THEN round(x.unit_price * 1.1, 2) ELSE x.unit_price END,
                 'unit_price_material', NULL, 'unit_price_labor', NULL,
                 'line_total', CASE WHEN x.sort_order = 0 THEN round(x.line_total * 1.1, 2) ELSE x.line_total END,
                 'item_type', x.item_type) ORDER BY x.sort_order))
    INTO v_snapshot FROM quotation_items x WHERE x.quotation_id = v_q;
    INSERT INTO quotation_revisions (tenant_id, quotation_id, revision, snapshot, created_at) VALUES (p_tenant, v_q, 1, v_snapshot, (p_date + 3)::timestamptz);
  END IF;
  IF v_site IS NOT NULL AND p_status = 'accepted' THEN
    UPDATE sites SET contract_value_no_vat = (SELECT sum(line_total) FROM quotation_items WHERE quotation_id = v_q AND item_type = 'item'),
                     contract_value = (SELECT sum(line_total) * 1.07 FROM quotation_items WHERE quotation_id = v_q AND item_type = 'item')
    WHERE id = v_site;
  END IF;
  RETURN v_q;
END $$;
REVOKE ALL ON FUNCTION demo_quotation(UUID, TEXT, TEXT, DATE, INT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- One invoice from a quotation: either a deposit invoice (opts.deposit_pct) or a progress draw
-- moving every unit from p_prior% to p_target% (mirrors Invoices.jsx handleSave + handleMarkPaid).
CREATE OR REPLACE FUNCTION demo_invoice(p_tenant UUID, p_quotation UUID, p_date DATE, p_seq INT, p_prior NUMERIC, p_target NUMERIC,
                                        p_paid DATE, p_opts JSONB DEFAULT '{}'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q RECORD; v_inv UUID; v_item UUID; v_sub NUMERIC := 0; v_line NUMERIC; v_draw NUMERIC; u RECORD; qi RECORD; i INT := 0;
  v_dep_pct NUMERIC := (p_opts->>'deposit_pct')::numeric; v_dep_ded NUMERIC := COALESCE((p_opts->>'deposit_deduction')::numeric, 0);
  v_void BOOLEAN := COALESCE((p_opts->>'void')::boolean, false); v_vat NUMERIC; v_total NUMERIC; v_num TEXT;
  v_tax NUMERIC; v_ret NUMERIC; v_income UUID; v_received NUMERIC; v_client TEXT; v_qsub NUMERIC; v_seq INT; v_rseq INT; v_tseq INT; v_iseq INT;
BEGIN
  SELECT qu.*, s.default_tax_withheld_pct, s.default_retention_pct, c.name AS client_name
    INTO q FROM quotations qu JOIN sites s ON s.id = qu.site_id JOIN clients c ON c.id = qu.client_id WHERE qu.id = p_quotation;
  IF q.id IS NULL THEN RAISE EXCEPTION 'demo_invoice: quotation % has no site', p_quotation; END IF;
  -- demo is reset on arbitrary dates; literal seqs collided, so compute the next number per month
  v_seq := COALESCE((SELECT max(substring(invoice_number from '-(\d{3})$')::int) FROM invoices WHERE tenant_id = p_tenant AND invoice_number LIKE 'IN' || to_char(p_date, 'YYMM') || '-%'), 0) + 1;
  v_num := 'IN' || to_char(p_date, 'YYMM') || '-' || lpad(v_seq::text, 3, '0');
  SELECT sum(line_total) INTO v_qsub FROM quotation_items WHERE quotation_id = p_quotation AND item_type = 'item';
  INSERT INTO invoices (tenant_id, invoice_number, quotation_id, site_id, date, status, has_vat, price_includes_vat, subtotal, vat, total,
                        bank_account_id, wht_pct, is_deposit, deposit_pct, deposit_deduction_amount, deposit_deduction_pct, notes)
  VALUES (p_tenant, v_num, p_quotation, q.site_id, p_date, 'unpaid', true, false, 0, 0, 0, q.bank_account_id, 3,
          v_dep_pct IS NOT NULL, v_dep_pct, NULLIF(v_dep_ded, 0), NULL,
          CASE WHEN COALESCE((p_opts->>'due_days')::int, 0) > 0 THEN 'ครบกำหนดชำระ ' || to_char(p_date + (p_opts->>'due_days')::int, 'DD/MM/YYYY') ELSE NULL END)
  RETURNING id INTO v_inv;
  IF v_dep_pct IS NOT NULL THEN
    v_line := round(v_qsub * v_dep_pct / 100, 2);
    INSERT INTO invoice_items (tenant_id, invoice_id, description, unit, unit_price, draw_qty, line_total, sort_order, item_type)
    VALUES (p_tenant, v_inv, 'เงินมัดจำ ' || v_dep_pct || '% ของมูลค่างานตามใบเสนอราคา ' || q.quotation_number, 'งวด', v_line, 1, v_line, 0, 'item');
    v_sub := v_line;
  ELSE
    FOR qi IN SELECT * FROM quotation_items WHERE quotation_id = p_quotation AND item_type = 'item' ORDER BY sort_order LOOP
      v_line := 0; v_draw := 0;
      FOR u IN SELECT * FROM quotation_item_units WHERE quotation_item_id = qi.id ORDER BY unit_index LOOP
        v_line := v_line + round((p_target - p_prior) / 100 * u.unit_qty * qi.unit_price, 2);
        v_draw := v_draw + (p_target - p_prior) / 100 * u.unit_qty;
      END LOOP;
      INSERT INTO invoice_items (tenant_id, invoice_id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order, item_type)
      VALUES (p_tenant, v_inv, qi.id, qi.description, qi.unit, qi.unit_price, v_draw, v_line, i, 'item') RETURNING id INTO v_item;
      i := i + 1;
      FOR u IN SELECT * FROM quotation_item_units WHERE quotation_item_id = qi.id ORDER BY unit_index LOOP
        INSERT INTO invoice_item_draws (tenant_id, invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount)
        VALUES (p_tenant, v_item, u.id, p_prior, p_target, round((p_target - p_prior) / 100 * u.unit_qty * qi.unit_price, 2));
        IF NOT v_void THEN
          UPDATE quotation_item_units SET cumulative_pct = p_target, updated_at = p_date::timestamptz WHERE id = u.id;
        END IF;
      END LOOP;
      v_sub := v_sub + v_line;
    END LOOP;
  END IF;
  v_vat := round(v_sub * 0.07, 2); v_total := v_sub + v_vat;
  UPDATE invoices SET subtotal = v_sub, vat = v_vat, total = v_total, status = CASE WHEN v_void THEN 'void' ELSE 'unpaid' END WHERE id = v_inv;
  IF p_paid IS NOT NULL AND NOT v_void THEN
    -- demo is reset on arbitrary dates; literal seqs collided, so compute the next number per month
    v_rseq := COALESCE((SELECT max(substring(receipt_number from '-(\d{3})$')::int) FROM receipts WHERE tenant_id = p_tenant AND receipt_number LIKE 'RE' || to_char(p_paid, 'YYMM') || '-%'), 0) + 1;
    v_tseq := COALESCE((SELECT max(substring(tax_invoice_number from '-(\d{3})$')::int) FROM receipts WHERE tenant_id = p_tenant AND tax_invoice_number LIKE 'TR' || to_char(p_paid, 'YYMM') || '-%'), 0) + 1;
    INSERT INTO receipts (tenant_id, receipt_number, tax_invoice_number, invoice_id, date, amount)
    VALUES (p_tenant, 'RE' || to_char(p_paid, 'YYMM') || '-' || lpad(v_rseq::text, 3, '0'),
            'TR' || to_char(p_paid, 'YYMM') || '-' || lpad(v_tseq::text, 3, '0'), v_inv, p_paid, v_total);
    v_tax := round(greatest(0, v_sub - v_dep_ded) * 3 / 100, 2);
    v_ret := CASE WHEN v_dep_pct IS NOT NULL THEN 0 ELSE round(v_sub * COALESCE(q.default_retention_pct, 0) / 100, 2) END;
    v_received := round(v_sub + v_vat - v_tax - v_ret - v_dep_ded, 2);
    -- demo is reset on arbitrary dates; literal seqs collided, so compute the next number per month
    v_iseq := COALESCE((SELECT max(substring(invoice_no from '-(\d{3})$')::int) FROM incomes WHERE tenant_id = p_tenant AND invoice_no LIKE 'IV' || to_char(p_paid, 'YYMM') || '-%'), 0) + 1;
    INSERT INTO incomes (tenant_id, invoice_no, source_invoice_id, date, site_id, client_name, description, amount_no_vat, vat,
                         tax_withheld, retention, income_type, deposit_deduction, received_amount)
    VALUES (p_tenant, 'IV' || to_char(p_paid, 'YYMM') || '-' || lpad(v_iseq::text, 3, '0'), v_inv, p_paid, q.site_id, q.client_name,
            v_num || ' — ' || q.quotation_number, v_sub, v_vat, v_tax, v_ret,
            CASE WHEN v_dep_pct IS NOT NULL THEN 'มัดจำ' ELSE 'ปกติ' END, v_dep_ded, v_received)
    RETURNING id INTO v_income;
    UPDATE invoices SET status = 'paid', paid_date = p_paid, income_id = v_income WHERE id = v_inv;
  END IF;
  RETURN v_inv;
END $$;
REVOKE ALL ON FUNCTION demo_invoice(UUID, UUID, DATE, INT, NUMERIC, NUMERIC, DATE, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION demo_seed_sales(p_tenant UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q UUID; s RECORD; v_sub NUMERIC; v_dep NUMERIC; v_seq INT; v_m0 DATE := demo_m(0);
  -- standard line sets by site size
  L_HOUSE JSONB := '[{"name":"งานฐานรากและเสาเข็ม","qty":1,"price":380000},{"desc":"เสาเข็มเจาะ ขนาด 0.35 ม. ลึก 21 ม. จำนวน 24 ต้น"},{"name":"งานโครงสร้าง ค.ส.ล.","qty":280,"price":4200},{"name":"งานก่ออิฐฉาบปูน","qty":620,"price":650},{"name":"งานโครงหลังคาและมุงหลังคา","qty":210,"price":1850},{"desc":"กระเบื้องหลังคาคอนกรีต สีเทาเข้ม พร้อมฉนวนกันความร้อน"},{"name":"งานระบบไฟฟ้า","qty":48,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":22,"price":1500},{"name":"งานทาสีภายใน-ภายนอก","qty":900,"price":180},{"name":"งานปูกระเบื้อง","qty":260,"price":550},{"name":"งานประตู-หน้าต่าง","qty":18,"price":8500},{"note":"ระยะเวลาก่อสร้าง 180 วัน นับจากวันเซ็นสัญญา"}]'::jsonb;
  L_COMM JSONB := '[{"name":"งานรื้อถอน","qty":1,"price":45000},{"name":"งานฐานรากและเสาเข็ม","qty":1,"price":520000},{"name":"งานโครงสร้าง ค.ส.ล.","qty":540,"price":4200},{"desc":"พื้น post-tension ชั้น 2-3 รับน้ำหนัก 400 กก./ตร.ม."},{"name":"งานก่ออิฐฉาบปูน","qty":1100,"price":650},{"name":"งานระบบไฟฟ้า","qty":96,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":36,"price":1500},{"name":"งานฝ้าเพดาน","qty":500,"price":420},{"name":"งานทาสีภายใน-ภายนอก","qty":1600,"price":180},{"name":"งานปูกระเบื้อง","qty":520,"price":550},{"name":"งานประตู-หน้าต่าง","qty":20,"price":8500},{"name":"งานรั้วและประตูรั้ว","qty":40,"price":3200},{"name":"งานถนนและลานจอดรถ","qty":300,"price":950},{"note":"ผู้ว่าจ้างเป็นผู้ขออนุญาตก่อสร้าง"}]'::jsonb;
  L_SMALL JSONB := '[{"name":"งานรื้อถอน","qty":1,"price":25000},{"name":"งานโครงสร้าง ค.ส.ล.","qty":40,"price":4200},{"name":"งานก่ออิฐฉาบปูน","qty":90,"price":650},{"desc":"ผนังก่ออิฐมวลเบา หนา 7.5 ซม."},{"name":"งานระบบไฟฟ้า","qty":12,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":6,"price":1500},{"name":"งานปูกระเบื้อง","qty":45,"price":550},{"name":"งานทาสีภายใน-ภายนอก","qty":180,"price":180},{"name":"งานประตู-หน้าต่าง","qty":3,"price":8500}]'::jsonb;
  L_RENO JSONB := '[{"name":"งานรื้อถอน","qty":1,"price":60000},{"desc":"รื้อพื้น ผนังเบา ฝ้า และระบบไฟเดิมทั้งชั้น 1"},{"name":"งานก่ออิฐฉาบปูน","qty":150,"price":650},{"name":"งานระบบไฟฟ้า","qty":30,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":10,"price":1500},{"name":"งานฝ้าเพดาน","qty":120,"price":420},{"name":"งานปูกระเบื้อง","qty":140,"price":550},{"name":"งานทาสีภายใน-ภายนอก","qty":400,"price":180},{"name":"งานสุขภัณฑ์","qty":2,"price":12000},{"name":"งานประตู-หน้าต่าง","qty":6,"price":8500}]'::jsonb;
BEGIN
  -- accepted quotations, one per non-cancelled site (9). Sequence numbers restart per month;
  -- dates are the site's start month so the QT prefix matches.
  FOR s IN SELECT name, start_date, status, default_deposit_pct, (row_number() OVER (ORDER BY start_date))::int AS rn,
                  (SELECT c.name FROM clients c WHERE c.id = x.client_id) AS client
           FROM sites x WHERE tenant_id = p_tenant AND NOT is_default AND status <> 'Cancelled' ORDER BY start_date LOOP
    q := demo_quotation(p_tenant, s.name, s.client, s.start_date - 14, s.rn,
           'accepted',
           CASE WHEN s.name IN ('อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน','โกดังสินค้า บางบัวทอง','สำนักงานขาย โครงการเดอะพาร์ค') THEN L_COMM
                WHEN s.name IN ('ต่อเติมครัว คุณสมศักดิ์','ร้านกาแฟ เดอะ การ์เด้น') THEN L_SMALL
                WHEN s.name = 'รีโนเวทบ้าน คุณนภา' THEN L_RENO ELSE L_HOUSE END,
           CASE WHEN s.name IN ('บ้านคุณวิชัย ลาดพร้าว','คลับเฮาส์ หมู่บ้านพฤกษา') THEN '{"revision_snapshot":true}'::jsonb ELSE '{}'::jsonb END);
    SELECT sum(line_total) INTO v_sub FROM quotation_items WHERE quotation_id = q AND item_type = 'item';
    v_dep := CASE WHEN s.default_deposit_pct > 0 THEN round(v_sub * s.default_deposit_pct / 100, 2) ELSE 0 END;
    -- invoices per site status. Sequence numbers: 10 + rn keeps them unique inside a month across sites.
    IF s.status = 'Completed' THEN
      PERFORM demo_invoice(p_tenant, q, s.start_date + 20, 10 + s.rn, 0, 40, s.start_date + 35);
      PERFORM demo_invoice(p_tenant, q, s.start_date + 65, 10 + s.rn, 40, 80, s.start_date + 80);
      PERFORM demo_invoice(p_tenant, q, s.start_date + 110, 10 + s.rn, 80, 100, s.start_date + 125);
    ELSIF s.status = 'On Hold' THEN
      PERFORM demo_invoice(p_tenant, q, s.start_date + 20, 10 + s.rn, 0, 20, s.start_date + 40);
    ELSE -- Ongoing: progress decides how many draws exist and which are still unpaid
      IF s.default_deposit_pct > 0 THEN
        PERFORM demo_invoice(p_tenant, q, s.start_date + 2, 10 + s.rn, 0, 0, s.start_date + 5, jsonb_build_object('deposit_pct', s.default_deposit_pct));
      END IF;
      IF s.name = 'บ้านคุณวิชัย ลาดพร้าว' THEN            -- 85%: 3 paid draws, 4th unpaid and overdue, deposit deducted on the last
        PERFORM demo_invoice(p_tenant, q, s.start_date + 30, 10 + s.rn, 0, 30, s.start_date + 45);
        PERFORM demo_invoice(p_tenant, q, s.start_date + 75, 10 + s.rn, 30, 55, s.start_date + 90);
        PERFORM demo_invoice(p_tenant, q, s.start_date + 120, 10 + s.rn, 55, 75, s.start_date + 135);
        PERFORM demo_invoice(p_tenant, q, current_date - 25, 20 + s.rn, 75, 85, NULL, jsonb_build_object('due_days', 15, 'deposit_deduction', v_dep));
      ELSIF s.name = 'อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน' THEN -- 70%: 2 paid, 1 unpaid overdue, plus 1 void (re-issued)
        PERFORM demo_invoice(p_tenant, q, s.start_date + 40, 10 + s.rn, 0, 35, s.start_date + 55);
        PERFORM demo_invoice(p_tenant, q, s.start_date + 95, 10 + s.rn, 35, 60, s.start_date + 110);
        PERFORM demo_invoice(p_tenant, q, current_date - 40, 20 + s.rn, 60, 70, NULL, '{"void":true}'::jsonb);
        PERFORM demo_invoice(p_tenant, q, current_date - 35, 30 + s.rn, 60, 70, NULL, '{"due_days":30}'::jsonb);
      ELSIF s.name = 'คลับเฮาส์ หมู่บ้านพฤกษา' THEN        -- 45%: 1 paid, 1 unpaid (not yet due)
        PERFORM demo_invoice(p_tenant, q, s.start_date + 35, 10 + s.rn, 0, 30, s.start_date + 50);
        PERFORM demo_invoice(p_tenant, q, current_date - 5, 20 + s.rn, 30, 45, NULL, '{"due_days":30}'::jsonb);
      ELSIF s.name = 'โกดังสินค้า บางบัวทอง' THEN          -- 30%: 1 paid draw
        PERFORM demo_invoice(p_tenant, q, s.start_date + 40, 10 + s.rn, 0, 30, s.start_date + 55);
      ELSE                                                  -- รีโนเวท 15%: 1 unpaid (fresh)
        PERFORM demo_invoice(p_tenant, q, current_date - 3, 20 + s.rn, 0, 15, NULL, '{"due_days":15}'::jsonb);
      END IF;
    END IF;
  END LOOP;

  -- open pipeline: 3 drafts, 4 sent (one about to expire, one on hold), 2 rejected -- no site link
  PERFORM demo_quotation(p_tenant, 'บ้านพักอาศัย 2 ชั้น บางใหญ่', 'คุณอรุณ ตั้งใจดี', current_date - 2, 30, 'draft', L_HOUSE, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'ต่อเติมโรงจอดรถ คุณวิชัย', 'คุณวิชัย ศรีสุข', current_date - 1, 31, 'draft', L_SMALL, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'ปรับปรุงสำนักงาน ชั้น 2', 'บจก. งามวงศ์วาน เทรดดิ้ง', current_date, 32, 'draft', L_RENO, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'บ้านแฝด 2 หลัง โครงการพฤกษา', 'บจก. พฤกษา พร็อพเพอร์ตี้', current_date - 25, 33, 'sent', L_HOUSE, jsonb_build_object('site_name_only', true, 'valid_until', current_date + 5));
  PERFORM demo_quotation(p_tenant, 'คลังสินค้าหลัง 2 บางบัวทอง', 'หจก. บางบัวทอง โลจิสติกส์', current_date - 12, 34, 'sent', L_COMM, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'ร้านอาหารริมน้ำ ปากเกร็ด', 'คุณสมศักดิ์ มั่นคง', current_date - 40, 35, 'sent', L_SMALL, jsonb_build_object('site_name_only', true, 'on_hold', true, 'valid_until', current_date - 10));
  PERFORM demo_quotation(p_tenant, 'รีโนเวทคอนโด คุณนภา', 'คุณนภา พงศ์ไพบูลย์', current_date - 8, 36, 'sent', L_RENO, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'อาคารสำนักงานขาย เฟส 2', 'บจก. เดอะพาร์ค ดีเวลลอปเมนท์', demo_m(2) + 10, 40, 'rejected', L_COMM, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'บ้านพักตากอากาศ', 'คุณอรุณ ตั้งใจดี', demo_m(3) + 15, 41, 'rejected', L_HOUSE, '{"site_name_only":true}');

  RETURN jsonb_build_object(
    'quotations', (SELECT count(*) FROM quotations WHERE tenant_id = p_tenant),
    'revisions', (SELECT count(*) FROM quotation_revisions WHERE tenant_id = p_tenant),
    'invoices', (SELECT count(*) FROM invoices WHERE tenant_id = p_tenant),
    'invoices_paid', (SELECT count(*) FROM invoices WHERE tenant_id = p_tenant AND status = 'paid'),
    'receipts', (SELECT count(*) FROM receipts WHERE tenant_id = p_tenant),
    'incomes', (SELECT count(*) FROM incomes WHERE tenant_id = p_tenant));
END $$;
REVOKE ALL ON FUNCTION demo_seed_sales(UUID) FROM PUBLIC, anon, authenticated;


-- ── seed entry point (sections are added by later tasks) ───────
CREATE OR REPLACE FUNCTION seed_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_claims TEXT := current_setting('request.jwt.claims', true); v_out JSONB := '{}'::jsonb;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM setseed(0.42);
  PERFORM demo_impersonate(p_tenant_id);
  v_out := v_out || demo_seed_core(p_tenant_id);
  v_out := v_out || demo_seed_sales(p_tenant_id);
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
