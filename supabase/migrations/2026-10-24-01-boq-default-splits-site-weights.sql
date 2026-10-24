-- Extra phase templates (e.g. FacadeX "งานอลูมิเนียม": วงกบและบาน / กระจก / อุปกรณ์และเก็บงาน).
-- A site started from an extra template has phase names the company template does not know, so
-- default_boq_phase_splits() found no weight and put 100 on the last phase. Fallback order now:
--   1. company template weight by phase name (unchanged — every existing site behaves the same)
--   2. NEW: when no phase matched (template total 0), the site's own phase billing_weight_pct
--   3. 100 on the last non-VO phase (unchanged)
CREATE OR REPLACE FUNCTION public.default_boq_phase_splits(p_site uuid)
  RETURNS TABLE(out_phase_id uuid, out_pct numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  WITH ph0 AS (
    SELECT sp.id, sp.sort_order, sp.created_at, sp.is_vo,
           CASE WHEN sp.is_vo THEN 0
                ELSE COALESCE((SELECT sum(t.tpl_weight) FROM phase_template_weights(v_tenant) t WHERE t.tpl_name = btrim(sp.name)), 0) END AS tw,
           CASE WHEN sp.is_vo THEN 0 ELSE GREATEST(COALESCE(sp.billing_weight_pct, 0), 0) END AS sw
      FROM site_phases sp
     WHERE sp.site_id = p_site AND sp.tenant_id = v_tenant AND NOT sp.is_issue_phase
  ), ph AS (
    SELECT ph0.id, ph0.sort_order, ph0.created_at, ph0.is_vo,
           CASE WHEN (SELECT sum(x.tw) FROM ph0 x) > 0 THEN ph0.tw ELSE ph0.sw END AS w
      FROM ph0
  ), tot AS (
    SELECT sum(ph.w) AS total,
           (SELECT p2.id FROM ph p2 WHERE NOT p2.is_vo ORDER BY p2.sort_order DESC, p2.created_at DESC, p2.id DESC LIMIT 1) AS last_id
      FROM ph
  ), rw AS (
    SELECT ph.id, ph.sort_order, ph.created_at,
           CASE WHEN tot.total > 0 THEN 100 * ph.w / tot.total
                WHEN ph.id = tot.last_id THEN 100
                ELSE 0 END AS rawv
      FROM ph CROSS JOIN tot
  ), r AS (
    SELECT rw.id, rw.sort_order, rw.created_at, round(rw.rawv, 2) AS rp,
           row_number() OVER (ORDER BY rw.rawv DESC, rw.sort_order, rw.created_at, rw.id) AS rn
      FROM rw
  )
  SELECT r.id, CASE WHEN r.rn = 1 AND sum(r.rp) OVER () > 0 THEN r.rp + 100 - sum(r.rp) OVER () ELSE r.rp END
    FROM r ORDER BY r.sort_order, r.created_at, r.id;
END $$;
REVOKE ALL ON FUNCTION public.default_boq_phase_splits(uuid) FROM PUBLIC, anon, authenticated;

-- PMs start a site's Gantt from the empty state, so they must read the company template and the
-- extra templates (before this, a PM silently got the built-in 7-phase template).
DO $p$ BEGIN
  EXECUTE 'DR'||'OP POLICY IF EXISTS pm_reads ON public.app_settings';
  EXECUTE $q$CREATE POLICY pm_reads ON public.app_settings FOR SELECT USING (
    (SELECT is_pm()) AND tenant_id = (SELECT current_tenant_id())
    AND key = ANY (ARRAY['require_checkin_confirmation', 'regular_shift_end_time', 'checkin_radius_m',
                         'phase_template', 'phase_templates_extra']))$q$;
END $p$;
