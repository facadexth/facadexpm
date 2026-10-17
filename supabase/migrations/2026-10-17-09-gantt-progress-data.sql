-- Gantt weighted progress: progress maths, daily snapshots, cron and data migration.
-- Spec docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §3, §8, §10.
-- Needs migrations 07 and 08. The JS mirror src/pages/sites/progressCalc.js follows the
-- same rules; both are checked against src/pages/sites/progressCalc.fixtures.json.
-- Rules (0-1):
--   card:  quantity -> least(done_qty / planned_qty, 1); parent -> Σ(child pts × child) / parent pts
--          (mean of the children when the parent has 0 pts); status -> done 1, else 0.
--   node (phase or subtask): child subtasks -> Σ(billing_weight_pct × child) / Σ billing_weight_pct
--          (plain mean when Σ is 0); else top-level non-issue cards -> Σ(pts × card) / 100;
--          else node status done 1, else 0.
--   site:  % ตามสัญญา = Σ(w × phase) / Σ w over phases neither VO nor issue (plain mean when
--          Σ w is 0, 0 with no such phase); % รวม VO only when contract_value > 0 and a VO phase exists.
-- The data steps at the end set card weights only: no status, quantity or mode changes.
-- Also: demo_seed_core gains a final step (equal weights + auto PLAN v1), and boq_items
-- planned_qty can no longer drop below what its cards already hold.
-- Rolled-back check: supabase/tests/2026-10-17-09-gantt-progress-data.test.sql
BEGIN;

-- ===== progress maths (SECURITY INVOKER: RLS applies to the caller) =====
CREATE OR REPLACE FUNCTION public.task_progress(p_task_id uuid) RETURNS numeric
  LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE; v_n int; v_wp numeric; v_avg numeric;
BEGIN
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.progress_mode = 'quantity' THEN
    RETURN least(t.done_qty / t.planned_qty, 1);
  END IF;
  SELECT count(*), sum(c.w * c.p), avg(c.p) INTO v_n, v_wp, v_avg
    FROM (SELECT weight_pts AS w, task_progress(id) AS p FROM phase_tasks
           WHERE tenant_id = t.tenant_id AND parent_task_id = t.id) c;
  IF v_n > 0 THEN
    RETURN CASE WHEN t.weight_pts > 0 THEN v_wp / t.weight_pts ELSE v_avg END;
  END IF;
  RETURN CASE WHEN t.status = 'done' THEN 1 ELSE 0 END;
END $$;
REVOKE ALL ON FUNCTION public.task_progress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_progress(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.node_progress(p_node_id uuid) RETURNS numeric
  LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE v_tenant uuid; v_status text; v_is_phase boolean := true; v_n int; v_w numeric; v_wp numeric; v_avg numeric;
BEGIN
  SELECT tenant_id, status INTO v_tenant, v_status FROM site_phases WHERE id = p_node_id;
  IF NOT FOUND THEN
    v_is_phase := false;
    SELECT tenant_id, status INTO v_tenant, v_status FROM phase_subtasks WHERE id = p_node_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  -- child subtasks: a phase's top-level subtasks, or a subtask's children
  SELECT count(*), sum(c.w), sum(c.w * c.p), avg(c.p) INTO v_n, v_w, v_wp, v_avg
    FROM (SELECT billing_weight_pct AS w, node_progress(id) AS p FROM phase_subtasks
           WHERE tenant_id = v_tenant
             AND CASE WHEN v_is_phase THEN phase_id = p_node_id AND parent_subtask_id IS NULL
                      ELSE parent_subtask_id = p_node_id END) c;
  IF v_n > 0 THEN
    RETURN CASE WHEN v_w > 0 THEN v_wp / v_w ELSE v_avg END;
  END IF;
  -- top-level cards that are not issue cards (unallocated points count as 0)
  SELECT count(*), sum(c.w * c.p) INTO v_n, v_wp
    FROM (SELECT weight_pts AS w, task_progress(id) AS p FROM phase_tasks
           WHERE tenant_id = v_tenant AND parent_task_id IS NULL AND issue_report_id IS NULL
             AND CASE WHEN v_is_phase THEN phase_id = p_node_id AND subtask_id IS NULL
                      ELSE subtask_id = p_node_id END) c;
  IF v_n > 0 THEN
    RETURN v_wp / 100;
  END IF;
  RETURN CASE WHEN v_status = 'done' THEN 1 ELSE 0 END;
END $$;
REVOKE ALL ON FUNCTION public.node_progress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.node_progress(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.site_progress_pct(p_site_id uuid)
  RETURNS TABLE(contract_pct numeric, total_pct numeric)
  LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE v_tenant uuid; v_cv numeric; v_n int; v_w numeric; v_wp numeric; v_avg numeric; v_contract numeric;
        v_vo_n int; v_vo_sum numeric; v_vo_wp numeric;
BEGIN
  SELECT tenant_id, contract_value INTO v_tenant, v_cv FROM sites WHERE id = p_site_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*), sum(c.w), sum(c.w * c.p), avg(c.p) INTO v_n, v_w, v_wp, v_avg
    FROM (SELECT billing_weight_pct AS w, node_progress(id) AS p FROM site_phases
           WHERE site_id = p_site_id AND tenant_id = v_tenant AND NOT is_vo AND NOT is_issue_phase) c;
  v_contract := CASE WHEN v_w > 0 THEN v_wp / v_w WHEN v_n > 0 THEN v_avg ELSE 0 END;
  SELECT count(*), COALESCE(sum(c.v), 0), COALESCE(sum(c.v * c.p), 0) INTO v_vo_n, v_vo_sum, v_vo_wp
    FROM (SELECT COALESCE(vo_value, 0) AS v, node_progress(id) AS p FROM site_phases
           WHERE site_id = p_site_id AND tenant_id = v_tenant AND is_vo AND NOT is_issue_phase) c;
  contract_pct := round(v_contract * 100, 2);
  total_pct := CASE WHEN COALESCE(v_cv, 0) > 0 AND v_vo_n > 0
                    THEN round((v_cv * v_contract + v_vo_wp) / (v_cv + v_vo_sum) * 100, 2) END;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.site_progress_pct(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_progress_pct(uuid) TO authenticated;

-- ===== daily snapshots (S-curve actual line) =====
CREATE TABLE public.site_progress_daily (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  day date NOT NULL,
  contract_pct numeric,
  total_pct numeric,
  PRIMARY KEY (site_id, day)
);
ALTER TABLE site_progress_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_staff_reads ON site_progress_daily FOR SELECT
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON site_progress_daily FROM authenticated, anon;

-- today's row (Asia/Bangkok date) for every site with a phase that is not an issue phase
CREATE OR REPLACE FUNCTION public.snapshot_site_progress() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE n int;
BEGIN
  INSERT INTO site_progress_daily (site_id, tenant_id, day, contract_pct, total_pct)
  SELECT s.id, s.tenant_id, (now() AT TIME ZONE 'Asia/Bangkok')::date, p.contract_pct, p.total_pct
    FROM sites s CROSS JOIN LATERAL site_progress_pct(s.id) p
   WHERE EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND ph.tenant_id = s.tenant_id AND NOT ph.is_issue_phase)
  ON CONFLICT (site_id, day) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id, contract_pct = EXCLUDED.contract_pct, total_pct = EXCLUDED.total_pct;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.snapshot_site_progress() FROM PUBLIC, anon, authenticated;

-- 23:55 Asia/Bangkok = 16:55 UTC. cron.schedule with an existing name replaces that job.
SELECT cron.schedule('site-progress-snapshot', '55 16 * * *', $cron$SELECT public.snapshot_site_progress()$cron$);

-- ===== BOQ line cannot drop below what its cards already hold (controller ruling) =====
CREATE OR REPLACE FUNCTION public.check_boq_planned_qty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sum numeric;
BEGIN
  SELECT COALESCE(sum(planned_qty), 0) INTO v_sum FROM phase_tasks
   WHERE tenant_id = NEW.tenant_id AND boq_item_id = NEW.id;
  IF NEW.planned_qty < v_sum THEN
    RAISE EXCEPTION 'จำนวน BOQ น้อยกว่าที่แจกให้การ์ดแล้ว' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_planned_qty() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_boq_planned_qty BEFORE UPDATE OF planned_qty ON boq_items
  FOR EACH ROW WHEN (NEW.planned_qty IS DISTINCT FROM OLD.planned_qty) EXECUTE FUNCTION check_boq_planned_qty();

-- ===== equal card points per node (data migration and demo seed) =====
-- Top-level, non-issue cards outside issue phases get round(100/n, 2); the first card by
-- (sort_order, created_at) takes the remainder so the node sums to exactly 100. One UPDATE,
-- so check_node_weights (AFTER, per row, end of statement) sees whole nodes. Only nodes whose
-- cards all still have 0 points are touched, so a re-run never overwrites weights set by a PM.
-- Issue cards keep their default 0. p_tenant_id NULL = every tenant.
CREATE OR REPLACE FUNCTION public.set_equal_card_weights(p_tenant_id uuid) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE n int;
BEGIN
  WITH c AS (
    SELECT t.id,
           count(*) OVER w AS n,
           row_number() OVER (w ORDER BY t.sort_order, t.created_at, t.id) AS rn,
           sum(t.weight_pts) OVER w AS node_sum
      FROM phase_tasks t JOIN site_phases ph ON ph.id = t.phase_id AND ph.tenant_id = t.tenant_id
     WHERE (p_tenant_id IS NULL OR t.tenant_id = p_tenant_id)
       AND t.parent_task_id IS NULL AND t.issue_report_id IS NULL AND NOT ph.is_issue_phase
    WINDOW w AS (PARTITION BY t.tenant_id, COALESCE(t.subtask_id, t.phase_id))
  )
  UPDATE phase_tasks t
     SET weight_pts = CASE WHEN c.rn = 1 THEN 100 - (c.n - 1) * round(100.0 / c.n, 2)
                           ELSE round(100.0 / c.n, 2) END
    FROM c
   WHERE t.id = c.id AND c.node_sum = 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.set_equal_card_weights(uuid) FROM PUBLIC, anon, authenticated;

-- ===== demo seed: live definition (2026-10-15-01) + one final step =====
CREATE OR REPLACE FUNCTION public.demo_seed_core(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    trial_ends_at = least(trial_ends_at, now() - interval '1 day'),   -- never show the free-trial banner
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
    INSERT INTO clients (tenant_id, client_number, name, client_type, tax_id, phone, address, province, contact_person)
    VALUES (p_tenant, 'CL-' || to_char(current_date, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_client_names[i], v_client_types[i], v_client_tax[i], '08' || lpad((10000000 + i * 1234567)::text, 8, '0'),
            (ARRAY['12/3 ซ.ลาดพร้าว 71 แขวงวังทองหลาง กรุงเทพฯ 10310','45 ม.2 ต.บางกระสอ อ.เมืองนนทบุรี 11000','88/9 ม.7 ต.บางพูด อ.ปากเกร็ด นนทบุรี 11120','1 อาคารพฤกษา ถ.แจ้งวัฒนะ ปากเกร็ด นนทบุรี 11120','55 ถ.บางกรวย-ไทรน้อย อ.ไทรน้อย นนทบุรี 11150','210 ถ.งามวงศ์วาน อ.เมืองนนทบุรี 11000','9/9 ม.4 ต.ละหาร อ.บางบัวทอง นนทบุรี 11110','23 ซ.ลาดพร้าว 101 แขวงคลองจั่น กรุงเทพฯ 10240'])[i],
            (ARRAY['กรุงเทพมหานคร','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','กรุงเทพมหานคร'])[i],
            CASE WHEN v_client_types[i] = 'DEVELOPER' THEN 'คุณประสิทธิ์ (ฝ่ายจัดซื้อ)' ELSE NULL END);
  END LOOP;

  FOR i IN 1..8 LOOP
    INSERT INTO suppliers (tenant_id, supplier_number, name, category, credit_days, default_payment_method, phone, payment_terms, tax_id)
    VALUES (p_tenant, 'SP-' || to_char(current_date, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_sup[i][1], to_jsonb(ARRAY[v_sup[i][2]]), v_sup[i][3]::int, v_sup[i][4], '02-5' || lpad((10000 + i * 777)::text, 5, '0'),
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

  -- Gantt weighted progress (2026-10-17-09): equal card points per node, then an auto PLAN v1
  -- per seeded site, so a demo reset is never stuck behind the PLAN gate
  PERFORM set_equal_card_weights(p_tenant);
  PERFORM snapshot_site_plan(s.id, 'สร้างอัตโนมัติตอนสร้างข้อมูลตัวอย่าง', true, 'system')
     FROM sites s
    WHERE s.tenant_id = p_tenant
      AND EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND NOT ph.is_issue_phase)
      AND NOT EXISTS (SELECT 1 FROM site_plans sp WHERE sp.site_id = s.id);

  RETURN jsonb_build_object(
    'clients', (SELECT count(*) FROM clients WHERE tenant_id = p_tenant),
    'suppliers', (SELECT count(*) FROM suppliers WHERE tenant_id = p_tenant),
    'catalog_items', (SELECT count(*) FROM catalog_items WHERE tenant_id = p_tenant),
    'expense_categories', (SELECT count(*) FROM expense_categories WHERE tenant_id = p_tenant),
    'sites', (SELECT count(*) FROM sites WHERE tenant_id = p_tenant AND NOT is_default),
    'site_phases', (SELECT count(*) FROM site_phases WHERE tenant_id = p_tenant),
    'phase_tasks', (SELECT count(*) FROM phase_tasks WHERE tenant_id = p_tenant));
END $function$;
REVOKE ALL ON FUNCTION public.demo_seed_core(uuid) FROM PUBLIC, anon, authenticated;

-- ===== data migration (runs as the table owner; weights only, no status changes) =====
-- 1. equal points per node
SELECT set_equal_card_weights(NULL);

-- 2. BOQ backfill from accepted quotations, 3. PLAN v1 for every site with a non-issue phase
DO $$
DECLARE q record;
BEGIN
  FOR q IN SELECT id FROM quotations WHERE status = 'accepted' AND site_id IS NOT NULL ORDER BY created_at, id LOOP
    PERFORM boq_insert_for_quotation(q.id);
  END LOOP;
  FOR q IN SELECT s.id FROM sites s
            WHERE EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND NOT ph.is_issue_phase)
              AND NOT EXISTS (SELECT 1 FROM site_plans sp WHERE sp.site_id = s.id)
            ORDER BY s.created_at, s.id LOOP
    PERFORM snapshot_site_plan(q.id, 'สร้างอัตโนมัติตอนเปิดใช้ระบบ ' || to_char(current_date, 'YYYY-MM-DD'), true, 'system');
  END LOOP;
END $$;

-- 4. first snapshot
SELECT snapshot_site_progress();
COMMIT;
