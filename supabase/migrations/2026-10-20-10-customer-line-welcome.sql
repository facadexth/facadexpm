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
