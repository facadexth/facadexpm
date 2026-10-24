-- Fix for 2026-10-24-01: a site started from an extra template (e.g. งานอลูมิเนียม) shares the prep phase
-- names with the company template, so the template total was > 0 and the site weights were never used
-- (demo tenant: 20/60/20/0/0/0 instead of 0/0/0/40/40/20). Rule now: when any non-VO phase name is
-- not in the company template and the site's own weights add up to more than 0, use the site weights.
CREATE OR REPLACE FUNCTION public.default_boq_phase_splits(p_site uuid)
  RETURNS TABLE(out_phase_id uuid, out_pct numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  WITH tpl AS (
    SELECT t.tpl_name, t.tpl_weight FROM phase_template_weights(v_tenant) t
  ), ph0 AS (
    SELECT sp.id, sp.sort_order, sp.created_at, sp.is_vo,
           CASE WHEN sp.is_vo THEN 0
                ELSE COALESCE((SELECT sum(t.tpl_weight) FROM tpl t WHERE t.tpl_name = btrim(sp.name)), 0) END AS tw,
           CASE WHEN sp.is_vo THEN 0 ELSE GREATEST(COALESCE(sp.billing_weight_pct, 0), 0) END AS sw,
           (NOT sp.is_vo AND NOT EXISTS (SELECT 1 FROM tpl t WHERE t.tpl_name = btrim(sp.name))) AS unmatched
      FROM site_phases sp
     WHERE sp.site_id = p_site AND sp.tenant_id = v_tenant AND NOT sp.is_issue_phase
  ), mode AS (
    SELECT (bool_or(ph0.unmatched) AND sum(ph0.sw) > 0) OR (sum(ph0.tw) = 0 AND sum(ph0.sw) > 0) AS use_site FROM ph0
  ), ph AS (
    SELECT ph0.id, ph0.sort_order, ph0.created_at, ph0.is_vo,
           CASE WHEN mode.use_site THEN ph0.sw ELSE ph0.tw END AS w
      FROM ph0 CROSS JOIN mode
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
