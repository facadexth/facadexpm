-- 2026-10-21-03: greet each customer LINE user once, ever (owner: "คนเก่า ไม่ต้องต้อนรับแล้ว").
-- claim_customer_welcome now only succeeds the first time; grants are unchanged (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.claim_customer_welcome(p_tenant uuid, p_line_user_id text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH claimed AS (
    INSERT INTO public.customer_line_welcomes (tenant_id, line_user_id, last_welcomed_on)
    VALUES (p_tenant, p_line_user_id, (now() AT TIME ZONE 'Asia/Bangkok')::date)
    ON CONFLICT (tenant_id, line_user_id) DO NOTHING
    RETURNING true AS ok
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
