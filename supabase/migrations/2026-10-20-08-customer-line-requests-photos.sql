-- 2026-10-20-08: customer LINE requests (ring the in-app bell) and the customer_visible photo flag.
-- Requests are inserted only by the service role (the customer webhook, a later task); the owner/admin
-- can read them and mark them handled. pending_counts() is copied from the LIVE definition (2026-10-19)
-- with one new key, customer_requests_open.

CREATE TABLE public.customer_line_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  client_id    uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('quote','repair')),
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  handled_by   text
);

-- At most one open request per person per kind.
CREATE UNIQUE INDEX customer_line_requests_open_one
  ON public.customer_line_requests (tenant_id, line_user_id, kind)
  WHERE handled_at IS NULL;

ALTER TABLE public.customer_line_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer_line_requests FROM anon, authenticated;
GRANT SELECT ON public.customer_line_requests TO authenticated;
GRANT UPDATE (handled_at, handled_by) ON public.customer_line_requests TO authenticated;

CREATE POLICY admin_select ON public.customer_line_requests
  FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY admin_update ON public.customer_line_requests
  FOR UPDATE TO authenticated
  USING ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id())
         AND (SELECT tenant_can_write()))
  WITH CHECK ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id())
         AND (SELECT tenant_can_write()));

-- Photos the customer may see in their LINE (Phase 1b reads this flag).
ALTER TABLE public.line_site_photos ADD COLUMN customer_visible boolean NOT NULL DEFAULT false;
ALTER TABLE public.site_attachments ADD COLUMN customer_visible boolean NOT NULL DEFAULT false;

-- Only PM/admin/owner may change the flag. Workers can insert/update their own line_site_photos
-- through RLS, so without this they could set customer_visible directly via PostgREST.
-- Same convention as scn_block_edit_when_posted: the rule binds direct client access only
-- (current_user authenticated/anon). SECURITY DEFINER RPCs (set_customer_visible, which checks
-- the role itself) run as the function owner, and the service role is not restricted.
-- Moving a row to another site always clears the flag, for every caller.
CREATE OR REPLACE FUNCTION public.guard_customer_visible()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    NEW.customer_visible := false;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.customer_visible)
     OR (TG_OP = 'UPDATE' AND NEW.customer_visible IS DISTINCT FROM OLD.customer_visible
         AND NOT (NEW.site_id IS DISTINCT FROM OLD.site_id)) THEN
    IF current_user = 'anon' THEN
      RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
    ELSIF current_user = 'authenticated' THEN
      IF NOT ((SELECT is_admin_or_owner()) OR (SELECT is_pm())) THEN
        RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_customer_visible() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER line_site_photos_guard_customer_visible
  BEFORE INSERT OR UPDATE ON public.line_site_photos
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_visible();

CREATE TRIGGER site_attachments_guard_customer_visible
  BEFORE INSERT OR UPDATE ON public.site_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_visible();

CREATE OR REPLACE FUNCTION public.set_customer_visible(p_kind text, p_id uuid, p_visible boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := current_tenant_id();
BEGIN
  IF v_tenant IS NULL
     OR NOT (is_admin_or_owner() OR is_pm())
     OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  IF p_kind = 'line_site_photo' THEN
    UPDATE public.line_site_photos SET customer_visible = p_visible
     WHERE id = p_id AND tenant_id = v_tenant;
  ELSIF p_kind = 'site_attachment' THEN
    UPDATE public.site_attachments SET customer_visible = p_visible
     WHERE id = p_id AND tenant_id = v_tenant;
  ELSE
    RAISE EXCEPTION 'bad_kind';
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_customer_visible(text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_visible(text, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.pending_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
  ),
  cheque_window AS (
    SELECT COALESCE(
      (SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int END
         FROM app_settings WHERE key = 'cheque_reminder_days' LIMIT 1),
      3) AS n
  )
  SELECT jsonb_build_object(
    'leave_pending',
      (SELECT count(*) FROM leave_requests WHERE status = 'pending'),
    'po_draft',
      (SELECT count(*) FROM purchase_orders WHERE status = 'draft'),
    'issues_open',
      (SELECT count(*) FROM line_issue_reports WHERE status = 'open'),
    'cheques_due',
      (SELECT count(*) FROM cheques c, today, cheque_window w
        WHERE c.status <> 'cashed' AND c.check_date <= today.d + w.n),
    'quotations_followup',
      (SELECT count(*) FROM quotations q, today
        WHERE q.status = 'sent' AND NOT q.on_hold
          AND q.valid_until IS NOT NULL
          AND q.valid_until <= today.d + 7),
    'offboarded_in_group',
      (SELECT count(*) FROM workers w
        WHERE w.status = 'inactive' AND w.line_offboarding_alerted_at IS NOT NULL
          AND (w.line_group_removed_at IS NULL OR w.line_group_removed_at < w.line_offboarding_alerted_at)),
    'advances_pending',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM salary_advances
                  WHERE tenant_id = current_tenant_id() AND status = 'pending')
           ELSE 0 END,
    'customer_requests_open',
      CASE WHEN is_owner()
           THEN (SELECT count(*) FROM customer_line_requests
                  WHERE tenant_id = current_tenant_id() AND handled_at IS NULL)
           ELSE 0 END
  );
$function$;
