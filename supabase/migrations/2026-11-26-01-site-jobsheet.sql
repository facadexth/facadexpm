-- 2026-11-26-01: crew daily job sheet (ใบงานประจำวัน, CRM G) — schema only.
-- 1) line_deep_link_tokens: new action_type 'site_jobsheet' (a crew member's link to one site's job sheet for
--    today). The site is carried in the existing site_id column (2026-10-20-03); a new CHECK makes a
--    site_jobsheet token always carry it. Other token kinds keep site_id optional (check-in/out use it, others
--    don't), so the CHECK is one-way. All 8 live action types are kept (live constraint name
--    line_deep_link_tokens_action_type_check, last redefined in 2026-11-25-03-repair-workorder.sql).
--    line_deep_link_tokens_repair_ticket_check (2026-11-25-03) already forces repair_ticket_id NULL on a
--    site_jobsheet token; nothing here conflicts with it.
-- 2) sites.safety_note: per-site safety text shown on the job sheet (fallback: tenant setting
--    site_safety_note_default, then the built-in default). At most 500 characters.
-- 3) PM RPCs (ruling R11): pm_sites() also returns safety_note and pm_update_site accepts it (blank -> NULL;
--    the column CHECK caps it at 500). Both copied from 2026-10-17-06-pm-ops-rpcs.sql, the only definition in
--    supabase/ (grep 2026-11-26), with only those changes. pm_sites' RETURNS TABLE changes, so it is dropped
--    and recreated (CREATE OR REPLACE cannot change a return type); its REVOKE/GRANT are restated. Nothing in
--    supabase/ depends on pm_sites (no view or BEGIN ATOMIC body calls it; a dependent object would make the
--    DROP fail, not cascade).
-- 4) app_settings pm_reads: + 'site_safety_note_default' (PMs see the company default on the form and sheet).
-- DROP CONSTRAINT has no IF EXISTS on purpose: a missing name means live drifted from this file — stop.
-- No view selects line_deep_link_tokens.* or sites.* (grep of supabase/ 2026-11-26; the only x.* views are
-- expenses_view e.*), so no view to recreate.

BEGIN;

-- ---------------------------------------------------------------- line_deep_link_tokens
ALTER TABLE public.line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock',
                                  'repair_workorder','site_jobsheet']));

ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_site_jobsheet_check
  CHECK (action_type <> 'site_jobsheet' OR site_id IS NOT NULL);

-- ---------------------------------------------------------------- sites.safety_note
ALTER TABLE public.sites ADD COLUMN safety_note text NULL;
ALTER TABLE public.sites ADD CONSTRAINT sites_safety_note_length_check
  CHECK (char_length(safety_note) <= 500);

-- ---------------------------------------------------------------- PM RPCs (R11)
DROP FUNCTION public.pm_sites();
CREATE FUNCTION public.pm_sites()
RETURNS TABLE(id uuid, site_number text, name text, short_name text, status text, start_date date, end_date date,
              client_id uuid, client_name text, location text, map_url text, lat numeric, lng numeric,
              distance_km numeric, travel_minutes integer, is_default boolean, notes text, created_at timestamptz,
              safety_note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.site_number, s.name, s.short_name, s.status, s.start_date, s.end_date,
         s.client_id, COALESCE(c.name, s.client_name), s.location, s.map_url, s.lat, s.lng,
         s.distance_km, s.travel_minutes, s.is_default, s.notes, s.created_at,
         s.safety_note
  FROM sites s LEFT JOIN clients c ON c.id = s.client_id
  WHERE s.tenant_id = current_tenant_id() AND is_site_staff()
  ORDER BY s.created_at DESC, s.id
$$;

CREATE OR REPLACE FUNCTION public.pm_update_site(p_site_id uuid, p_patch jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE k text;
  allowed text[] := ARRAY['name','short_name','status','start_date','end_date','location','map_url','lat','lng','distance_km','travel_minutes','notes','safety_note'];
BEGIN
  IF NOT is_site_staff() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT k = ANY (allowed) THEN RAISE EXCEPTION 'field not allowed: %', k USING ERRCODE = '22023'; END IF;
  END LOOP;
  -- Unknown or other-tenant site: P0002 before any status guard, so the error
  -- code says nothing about another tenant's site status.
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'site not found' USING ERRCODE = 'P0002';
  END IF;
  -- Finishing a site moves leftover stock and stamps end_date (the OWNER/ADMIN
  -- finish flow), so a PM may not set Completed; an already-Completed site may stay so.
  IF p_patch->>'status' = 'Completed'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Completed' AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'PM cannot complete a site' USING ERRCODE = '22023';
  END IF;
  -- Ongoing seat rule from the sites admin_updates policy
  IF p_patch ? 'status' AND p_patch->>'status' = 'Ongoing'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Ongoing' AND tenant_id = current_tenant_id())
     AND NOT tenant_under_seat_limit('sites') THEN
    RAISE EXCEPTION 'site seat limit reached' USING ERRCODE = '54000';
  END IF;
  UPDATE sites s SET
    name           = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE s.name END,
    short_name     = CASE WHEN p_patch ? 'short_name' THEN NULLIF(p_patch->>'short_name','') ELSE s.short_name END,
    status         = CASE WHEN p_patch ? 'status' THEN p_patch->>'status' ELSE s.status END,
    start_date     = CASE WHEN p_patch ? 'start_date' THEN (p_patch->>'start_date')::date ELSE s.start_date END,
    end_date       = CASE WHEN p_patch ? 'end_date' THEN (p_patch->>'end_date')::date ELSE s.end_date END,
    location       = CASE WHEN p_patch ? 'location' THEN p_patch->>'location' ELSE s.location END,
    map_url        = CASE WHEN p_patch ? 'map_url' THEN p_patch->>'map_url' ELSE s.map_url END,
    lat            = CASE WHEN p_patch ? 'lat' THEN (p_patch->>'lat')::numeric ELSE s.lat END,
    lng            = CASE WHEN p_patch ? 'lng' THEN (p_patch->>'lng')::numeric ELSE s.lng END,
    distance_km    = CASE WHEN p_patch ? 'distance_km' THEN (p_patch->>'distance_km')::numeric ELSE s.distance_km END,
    travel_minutes = CASE WHEN p_patch ? 'travel_minutes' THEN (p_patch->>'travel_minutes')::integer ELSE s.travel_minutes END,
    notes          = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE s.notes END,
    safety_note    = CASE WHEN p_patch ? 'safety_note' THEN NULLIF(btrim(p_patch->>'safety_note'),'') ELSE s.safety_note END,
    updated_at     = now()
  WHERE s.id = p_site_id AND s.tenant_id = current_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found' USING ERRCODE = 'P0002'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------- app_settings pm_reads (PM reads the default)
-- Live definition from 2026-10-24-01-boq-default-splits-site-weights.sql, one key appended so a PM's
-- site form and job sheet read site_safety_note_default. The DROP keyword is built by concatenation
-- (same as 2026-10-24-01; the dry-run tool rejects it written out).
DO $p$ BEGIN
  EXECUTE 'DR'||'OP POLICY IF EXISTS pm_reads ON public.app_settings';
  EXECUTE $q$CREATE POLICY pm_reads ON public.app_settings FOR SELECT USING (
    (SELECT is_pm()) AND tenant_id = (SELECT current_tenant_id())
    AND key = ANY (ARRAY['require_checkin_confirmation', 'regular_shift_end_time', 'checkin_radius_m',
                         'phase_template', 'phase_templates_extra', 'site_safety_note_default']))$q$;
END $p$;

COMMIT;
