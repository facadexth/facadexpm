BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_line_welcomes (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  last_welcomed_on date NOT NULL,
  PRIMARY KEY (tenant_id, line_user_id)
);

ALTER TABLE public.customer_line_welcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_line_welcomes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_customer_welcome(p_tenant uuid, p_line_user_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    INSERT INTO public.customer_line_welcomes AS w (tenant_id, line_user_id, last_welcomed_on)
    VALUES (p_tenant, p_line_user_id, (now() AT TIME ZONE 'Asia/Bangkok')::date)
    ON CONFLICT (tenant_id, line_user_id) DO UPDATE SET last_welcomed_on = EXCLUDED.last_welcomed_on
      WHERE w.last_welcomed_on < EXCLUDED.last_welcomed_on
    RETURNING true AS ok
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.claim_customer_welcome(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_customer_welcome(uuid, text) TO service_role;

DO $t$
DECLARE
  r boolean;
  other uuid;
BEGIN
  SELECT id INTO other FROM public.tenants WHERE id <> '8b61c890-0a90-4223-91d3-b5f8f4e89908' LIMIT 1;
  IF other IS NULL THEN RAISE EXCEPTION 'need a second tenant'; END IF;
  r := public.claim_customer_welcome('8b61c890-0a90-4223-91d3-b5f8f4e89908', 'U_zz_welcome');
  IF r IS NOT TRUE THEN RAISE EXCEPTION 'a: first claim should be true, got %', r; END IF;
  r := public.claim_customer_welcome('8b61c890-0a90-4223-91d3-b5f8f4e89908', 'U_zz_welcome');
  IF r IS NOT FALSE THEN RAISE EXCEPTION 'b: second same-day claim should be false, got %', r; END IF;
  UPDATE public.customer_line_welcomes SET last_welcomed_on = last_welcomed_on - 1
    WHERE tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908' AND line_user_id = 'U_zz_welcome';
  r := public.claim_customer_welcome('8b61c890-0a90-4223-91d3-b5f8f4e89908', 'U_zz_welcome');
  IF r IS NOT TRUE THEN RAISE EXCEPTION 'c: claim after yesterday should be true, got %', r; END IF;
  r := public.claim_customer_welcome(other, 'U_zz_welcome');
  IF r IS NOT TRUE THEN RAISE EXCEPTION 'd: other tenant should be independent, got %', r; END IF;
  IF has_function_privilege('anon', 'public.claim_customer_welcome(uuid, text)', 'EXECUTE') THEN RAISE EXCEPTION 'e: anon can execute'; END IF;
  IF has_function_privilege('authenticated', 'public.claim_customer_welcome(uuid, text)', 'EXECUTE') THEN RAISE EXCEPTION 'e: authenticated can execute'; END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_customer_welcome(uuid, text)', 'EXECUTE') THEN RAISE EXCEPTION 'e: service_role cannot execute'; END IF;
  IF has_table_privilege('authenticated', 'public.customer_line_welcomes', 'SELECT') THEN RAISE EXCEPTION 'f: authenticated can select'; END IF;
END
$t$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
