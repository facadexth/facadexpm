-- supabase/migrations/2026-10-10-01-document-templates.sql
-- Quotation templates (phase 1: data + admin RPCs, no UI).
-- Spec: docs/superpowers/specs/2026-10-10-document-templates-design.md
-- Templates apply to the QUOTATION only. A template is invisible to tenants
-- until a platform admin publishes it. NOT applied to the live DB yet.

-- 1. Platform-owned templates (3 rows) ------------------------------------
CREATE TABLE document_templates (
  key            TEXT PRIMARY KEY CHECK (key IN ('classic','modern','premium')),
  layout         TEXT NOT NULL CHECK (layout IN ('classic','modern','premium')),
  name_th        TEXT NOT NULL,
  description_th TEXT NOT NULL DEFAULT '',
  style          JSONB NOT NULL DEFAULT '{}'::jsonb,
  style_prev     JSONB,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(style) = 'object'),
  CHECK (key <> 'classic' OR status = 'published')
);

-- accent values below are starting points; the platform admin polishes them
INSERT INTO document_templates (key, layout, name_th, description_th, style, status) VALUES
  ('classic', 'classic', 'คลาสสิก', 'แบบเรียบ อ่านง่าย ใช้ได้กับทุกงาน', '{}'::jsonb, 'published'),
  ('modern',  'modern',  'โมเดิร์นมีภาพ', 'แถบหัวสีเข้ม ภาพปก แกลเลอรีผลงาน และแถบจุดเด่น', '{"accent":"#1e3a5f"}'::jsonb, 'draft'),
  ('premium', 'premium', 'พรีเมียมหรูหรา', 'กระดาษโทนครีม ตัวอักษรมีหัว ภาพปกพร้อมคำโปรย', '{"accent":"#7a4b2a"}'::jsonb, 'draft');

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
-- no INSERT/UPDATE/DELETE policy: writes only through the RPCs below
CREATE POLICY document_templates_read ON document_templates FOR SELECT TO authenticated
  USING (status = 'published'
         OR EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

-- 2. Platform-owned default image packs -----------------------------------
CREATE TABLE document_image_packs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_th     TEXT NOT NULL,
  hero_path   TEXT NOT NULL,
  gallery     JSONB NOT NULL DEFAULT '[]'::jsonb,
  features_th TEXT[] NOT NULL DEFAULT '{}',
  tagline_th  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(gallery) = 'array' AND jsonb_array_length(gallery) <= 4),
  CHECK (cardinality(features_th) <= 3)
);

ALTER TABLE document_image_packs ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_image_packs_read ON document_image_packs FOR SELECT TO authenticated
  USING (status = 'published'
         OR EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY document_image_packs_admin_write ON document_image_packs FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

-- 3. Tenant choice ---------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN document_template_key TEXT REFERENCES document_templates(key),
  ADD COLUMN document_accent       TEXT CHECK (document_accent ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN document_content      JSONB CHECK (document_content IS NULL OR jsonb_typeof(document_content) = 'object');
-- document_content: { pack_id, pack_terms_accepted_at, hero_path,
--   gallery:[{path,caption}] (max 4), features:[text] (max 3), tagline, thanks }

-- 4. Buckets ---------------------------------------------------------------
-- public: html2canvas loads images by URL, so images are readable by anyone with the URL
INSERT INTO storage.buckets (id, name, public) VALUES ('tenant-doc-images', 'tenant-doc-images', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('document-defaults', 'document-defaults', true)
ON CONFLICT (id) DO NOTHING;

-- one FOR ALL policy per bucket (a split INSERT/UPDATE/DELETE set once broke uploads, see 2026-09-02-03)
CREATE POLICY tenant_doc_images_owner_access ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'tenant-doc-images' AND is_owner() AND (storage.foldername(name))[1] = current_tenant_id()::text)
  WITH CHECK (bucket_id = 'tenant-doc-images' AND is_owner() AND (storage.foldername(name))[1] = current_tenant_id()::text);

CREATE POLICY document_defaults_admin_access ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'document-defaults' AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (bucket_id = 'document-defaults' AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

-- 5. Admin RPCs ------------------------------------------------------------
-- Save style and/or status. Keeps one step of rollback (style_prev) whenever the style changes.
CREATE FUNCTION platform_save_document_template(p_key TEXT, p_style JSONB, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;
  IF p_style IS NULL OR jsonb_typeof(p_style) <> 'object' THEN
    RAISE EXCEPTION 'style must be a JSON object';
  END IF;
  IF p_status NOT IN ('draft','published') THEN
    RAISE EXCEPTION 'status must be draft or published';
  END IF;
  IF p_key = 'classic' AND p_status <> 'published' THEN
    RAISE EXCEPTION 'classic template must stay published';
  END IF;

  UPDATE document_templates
  SET style_prev = CASE WHEN style IS DISTINCT FROM p_style THEN style ELSE style_prev END,
      style      = p_style,
      status     = p_status,
      updated_by = auth.email(),
      updated_at = now()
  WHERE key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown template %', p_key;
  END IF;
END;
$$;

-- One-step rollback: swap back to style_prev.
CREATE FUNCTION platform_rollback_document_template(p_key TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;
  UPDATE document_templates
  SET style = style_prev, style_prev = style, updated_by = auth.email(), updated_at = now()
  WHERE key = p_key AND style_prev IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing to roll back for %', p_key;
  END IF;
END;
$$;

-- How many tenants use each template (for the publish confirmation).
CREATE FUNCTION platform_document_template_usage()
RETURNS TABLE (template_key TEXT, tenant_count BIGINT)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT t.document_template_key, count(*)
  FROM tenants t
  WHERE t.document_template_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  GROUP BY t.document_template_key;
$$;

REVOKE ALL ON FUNCTION platform_save_document_template(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION platform_rollback_document_template(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION platform_document_template_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_save_document_template(TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION platform_rollback_document_template(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION platform_document_template_usage() TO authenticated;
