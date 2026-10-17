-- PM role, part 2: price-free read RPCs, a whitelisted site edit RPC and the
-- team-policy fix. PM never reads money tables directly (Task 1 keeps their
-- RLS admin-only); these SECURITY DEFINER functions return only non-money
-- columns, filter tenant_id = current_tenant_id() themselves and return
-- nothing unless is_site_staff() (OWNER/ADMIN/PM).
-- Depends on: 2026-10-17-05-pm-role.sql (is_site_staff, can_manage_teams).
-- Rolled-back check: supabase/tests/2026-10-17-06-pm-ops-rpcs.test.sql
-- RETURNS TABLE types follow information_schema.columns (read 2026-10-17):
-- sites.travel_minutes, workers.annual_leave_days and
-- workers.annual_sick_leave_days are integer.
BEGIN;

CREATE OR REPLACE FUNCTION public.pm_sites()
RETURNS TABLE(id uuid, site_number text, name text, short_name text, status text, start_date date, end_date date,
              client_id uuid, client_name text, location text, map_url text, lat numeric, lng numeric,
              distance_km numeric, travel_minutes integer, is_default boolean, notes text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.site_number, s.name, s.short_name, s.status, s.start_date, s.end_date,
         s.client_id, COALESCE(c.name, s.client_name), s.location, s.map_url, s.lat, s.lng,
         s.distance_km, s.travel_minutes, s.is_default, s.notes, s.created_at
  FROM sites s LEFT JOIN clients c ON c.id = s.client_id
  WHERE s.tenant_id = current_tenant_id() AND is_site_staff()
  ORDER BY s.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.pm_update_site(p_site_id uuid, p_patch jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE k text;
  allowed text[] := ARRAY['name','short_name','status','start_date','end_date','location','map_url','lat','lng','distance_km','travel_minutes','notes'];
BEGIN
  IF NOT is_site_staff() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT k = ANY (allowed) THEN RAISE EXCEPTION 'field not allowed: %', k USING ERRCODE = '22023'; END IF;
  END LOOP;
  -- Finishing a site moves leftover stock and stamps end_date (the OWNER/ADMIN
  -- finish flow), so a PM may not set Completed; an already-Completed site may stay so.
  IF p_patch->>'status' = 'Completed'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Completed') THEN
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
    updated_at     = now()
  WHERE s.id = p_site_id AND s.tenant_id = current_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found' USING ERRCODE = 'P0002'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pm_workers()
RETURNS TABLE(id uuid, name text, nickname text, "position" text, status text, email text, show_in_assign boolean,
              line_user_id text, annual_leave_days integer, annual_sick_leave_days integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT w.id, w.name, w.nickname, w.position, w.status, w.email, w.show_in_assign,
         w.line_user_id, w.annual_leave_days, w.annual_sick_leave_days
  FROM workers w
  WHERE w.tenant_id = current_tenant_id() AND is_site_staff()
  ORDER BY w.name
$$;

CREATE OR REPLACE FUNCTION public.pm_purchase_orders()
RETURNS TABLE(id uuid, po_number text, site_id uuid, supplier_id uuid, supplier_name text, date date, status text,
              notes text, received_date date, ordered_by text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT po.id, po.po_number, po.site_id, po.supplier_id, sp.name, po.date, po.status,
         po.notes, po.received_date, po.ordered_by, po.created_at
  FROM purchase_orders po LEFT JOIN suppliers sp ON sp.id = po.supplier_id
  WHERE po.tenant_id = current_tenant_id() AND is_site_staff() AND has_module_access('purchase_orders')
  ORDER BY po.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.pm_purchase_order_items(p_po_id uuid)
RETURNS TABLE(id uuid, po_id uuid, description text, quantity numeric, unit text, sort_order integer,
              inventory_item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i.id, i.po_id, i.description, i.quantity, i.unit, i.sort_order, i.inventory_item_id
  FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
  WHERE i.po_id = p_po_id
    AND po.tenant_id = current_tenant_id() AND i.tenant_id = current_tenant_id()
    AND is_site_staff() AND has_module_access('purchase_orders')
  ORDER BY i.sort_order, i.id
$$;

CREATE OR REPLACE FUNCTION public.pm_inventory_on_hand(p_site_id uuid DEFAULT NULL)
RETURNS TABLE(inventory_item_id uuid, code text, name text, base_unit text, site_id uuid,
              quantity_on_hand numeric, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT b.inventory_item_id, it.code, it.name, it.base_unit, b.site_id, b.quantity_on_hand, b.updated_at
  FROM inventory_stock_balances b JOIN inventory_items it ON it.id = b.inventory_item_id
  WHERE b.tenant_id = current_tenant_id() AND it.tenant_id = current_tenant_id()
    AND (p_site_id IS NULL OR b.site_id = p_site_id)
    AND is_site_staff() AND has_module_access('purchase_orders')
  ORDER BY it.name, b.site_id
$$;

-- Used by the worker_team_members policy: a PM cannot SELECT workers.
CREATE OR REPLACE FUNCTION public.worker_in_my_tenant(p_worker_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM workers WHERE id = p_worker_id AND tenant_id = current_tenant_id()) $$;

REVOKE ALL ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb), public.pm_workers(),
  public.pm_purchase_orders(), public.pm_purchase_order_items(uuid), public.pm_inventory_on_hand(uuid),
  public.worker_in_my_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb), public.pm_workers(),
  public.pm_purchase_orders(), public.pm_purchase_order_items(uuid), public.pm_inventory_on_hand(uuid),
  public.worker_in_my_tenant(uuid) TO authenticated;

-- Teams: OWNER or PM manage them (was is_owner()). The live worker_team_members
-- with_check (read 2026-10-17) checked the worker with EXISTS on workers, which a
-- PM cannot read, so it now calls worker_in_my_tenant().
ALTER POLICY owner_writes ON worker_teams
  USING (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ))
  WITH CHECK (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
ALTER POLICY owner_writes ON worker_team_members
  USING (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ))
  WITH CHECK (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() )
    AND EXISTS (SELECT 1 FROM worker_teams t WHERE t.id = worker_team_members.team_id AND t.tenant_id = ( SELECT current_tenant_id() ))
    AND worker_in_my_tenant(worker_id));

COMMIT;
