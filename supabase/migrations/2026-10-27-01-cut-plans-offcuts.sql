-- 2026-10-27-01: cut sheet, offcut stock and stickers (plan docs/superpowers/plans/2026-10-27-cut-sheet-stickers-offcuts.md)
BEGIN;

ALTER TABLE estimation_settings
  ADD COLUMN custom_len_min_m  NUMERIC NOT NULL DEFAULT 4.0  CHECK (custom_len_min_m > 0),
  ADD COLUMN custom_len_max_m  NUMERIC NOT NULL DEFAULT 7.0  CHECK (custom_len_max_m > 0),
  ADD COLUMN custom_len_step_m NUMERIC NOT NULL DEFAULT 0.05 CHECK (custom_len_step_m > 0),
  ADD COLUMN custom_moq_kg     NUMERIC NOT NULL DEFAULT 1000 CHECK (custom_moq_kg >= 0),
  ADD CONSTRAINT estimation_settings_custom_range CHECK (custom_len_max_m >= custom_len_min_m);

-- 'stock' = normal job, market bar only; 'custom' = project job, custom lengths allowed
ALTER TABLE estimation_projects
  ADD COLUMN cut_mode TEXT NOT NULL DEFAULT 'stock' CHECK (cut_mode IN ('stock','custom'));

CREATE TABLE alu_cut_plans (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id  UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  signature   TEXT NOT NULL,           -- planSignature() of the items the plan was made from
  plan        JSONB NOT NULL,          -- frozen plan: groups, bars, pieces, offcuts (see src/lib/cutPlan.js)
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by   UUID DEFAULT auth.uid(),
  voided_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX alu_cut_plans_one_issued ON alu_cut_plans(project_id) WHERE status = 'issued';
CREATE INDEX idx_alu_cut_plans_project_id ON alu_cut_plans(project_id);

CREATE TABLE alu_offcuts (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  code              TEXT NOT NULL,                       -- OC-0001, per tenant
  profile_id        UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE RESTRICT,
  finish_id         UUID REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  length_m          NUMERIC NOT NULL CHECK (length_m > 0),
  end_a             TEXT NOT NULL DEFAULT 'square' CHECK (end_a IN ('square','miter45','notch')), -- the end the last piece left
  status            TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','used','discarded')),
  source_project_id UUID REFERENCES estimation_projects(id) ON DELETE SET NULL,
  source_plan_id    UUID REFERENCES alu_cut_plans(id) ON DELETE SET NULL,
  plan_key          TEXT,                                -- cutPlan.js newOffcuts key in source_plan_id's plan (sticker ↔ code after reload)
  used_plan_id      UUID REFERENCES alu_cut_plans(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_alu_offcuts_profile_finish ON alu_offcuts(profile_id, finish_id) WHERE status = 'in_stock';
CREATE INDEX idx_alu_offcuts_source_plan ON alu_offcuts(source_plan_id);
CREATE INDEX idx_alu_offcuts_used_plan ON alu_offcuts(used_plan_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_cut_plans','alu_offcuts'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('estimation')))
      WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('estimation')))$p$, t);
  END LOOP;
END $$;

-- Issue: freeze the plan, consume the stock offcuts it uses, stock the kept new offcuts. All or nothing.
-- SECURITY INVOKER: RLS above is the access check; the function only adds the concurrency rules.
CREATE FUNCTION issue_cut_plan(p_project_id UUID, p_signature TEXT, p_plan JSONB, p_used_offcut_ids UUID[], p_new_offcuts JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_plan UUID; v_n INT; v_next INT; v_out JSONB := '[]'::jsonb; r JSONB; v_id UUID; v_code TEXT;
BEGIN
  -- per-tenant serialisation of offcut stock changes (running OC code, used/void); UNIQUE(tenant_id, code) is the backstop
  PERFORM pg_advisory_xact_lock(hashtext('alu_offcuts:' || v_tenant::text));
  -- lock the project row so the already-issued check below cannot race
  PERFORM 1 FROM estimation_projects WHERE id = p_project_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบโปรเจกต์' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM alu_cut_plans WHERE project_id = p_project_id AND status = 'issued') THEN
    RAISE EXCEPTION 'โปรเจกต์นี้มีใบตัดที่ยืนยันแล้ว ยกเลิกใบเดิมก่อน' USING ERRCODE = 'P0001';
  END IF;
  -- lock the offcuts this plan uses; every one must still be in stock
  SELECT count(*) INTO v_n FROM (
    SELECT id FROM alu_offcuts WHERE id = ANY(COALESCE(p_used_offcut_ids, '{}')) AND tenant_id = v_tenant AND status = 'in_stock' FOR UPDATE
  ) x;
  IF v_n <> (SELECT count(DISTINCT u) FROM unnest(COALESCE(p_used_offcut_ids, '{}')) u) THEN
    RAISE EXCEPTION 'เศษบางชิ้นถูกใช้หรือทิ้งไปแล้ว คำนวณใบตัดใหม่แล้วลองอีกครั้ง' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    INSERT INTO alu_cut_plans (tenant_id, project_id, signature, plan) VALUES (v_tenant, p_project_id, p_signature, p_plan) RETURNING id INTO v_plan;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'โปรเจกต์นี้มีใบตัดที่ยืนยันแล้ว ยกเลิกใบเดิมก่อน' USING ERRCODE = 'P0001';
  END;
  UPDATE alu_offcuts SET status = 'used', used_plan_id = v_plan, status_at = now() WHERE id = ANY(COALESCE(p_used_offcut_ids, '{}'));
  -- per-tenant running code (serialised by the advisory lock above)
  SELECT COALESCE(max(substring(code FROM 4)::int), 0) INTO v_next FROM alu_offcuts WHERE tenant_id = v_tenant AND code ~ '^OC-[0-9]+$';
  FOR r IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_offcuts, '[]'::jsonb)) LOOP
    v_next := v_next + 1;
    v_code := 'OC-' || lpad(v_next::text, greatest(4, length(v_next::text)), '0');
    INSERT INTO alu_offcuts (tenant_id, code, profile_id, finish_id, length_m, end_a, source_project_id, source_plan_id, plan_key)
      VALUES (v_tenant, v_code, (r->>'profile_id')::uuid, NULLIF(r->>'finish_id','')::uuid, (r->>'length_m')::numeric,
              COALESCE(r->>'end_a','square'), p_project_id, v_plan, r->>'key')
      RETURNING id INTO v_id;
    v_out := v_out || jsonb_build_object('key', r->>'key', 'id', v_id, 'code', v_code);
  END LOOP;
  RETURN jsonb_build_object('plan_id', v_plan, 'offcuts', v_out);
END $$;

-- Void: only while none of the offcuts this plan created has been used by another plan.
CREATE FUNCTION void_cut_plan(p_plan_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_tenant UUID := current_tenant_id();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('alu_offcuts:' || v_tenant::text));
  PERFORM 1 FROM alu_cut_plans WHERE id = p_plan_id AND tenant_id = v_tenant AND status = 'issued' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบตัดที่ยืนยันแล้ว' USING ERRCODE = 'P0002'; END IF;
  -- lock this plan's offcuts so no other plan can take one between the check and the delete
  PERFORM 1 FROM alu_offcuts WHERE source_plan_id = p_plan_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM alu_offcuts WHERE source_plan_id = p_plan_id AND status = 'used') THEN
    RAISE EXCEPTION 'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว ยกเลิกไม่ได้' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM alu_offcuts WHERE source_plan_id = p_plan_id AND status <> 'used';
  UPDATE alu_offcuts SET status = 'in_stock', used_plan_id = NULL, status_at = now() WHERE used_plan_id = p_plan_id;
  UPDATE alu_cut_plans SET status = 'void', voided_at = now() WHERE id = p_plan_id;
END $$;

-- Deleting a plan row (e.g. project delete cascade) returns the offcuts it consumed to stock instead of stranding them as 'used'.
CREATE FUNCTION alu_cut_plans_release_used_offcuts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE alu_offcuts SET status = 'in_stock', used_plan_id = NULL, status_at = now() WHERE used_plan_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_alu_cut_plans_release_used_offcuts BEFORE DELETE ON alu_cut_plans
  FOR EACH ROW EXECUTE FUNCTION alu_cut_plans_release_used_offcuts();

REVOKE ALL ON FUNCTION issue_cut_plan(UUID, TEXT, JSONB, UUID[], JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION void_cut_plan(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION issue_cut_plan(UUID, TEXT, JSONB, UUID[], JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION void_cut_plan(UUID) TO authenticated;

COMMIT;
