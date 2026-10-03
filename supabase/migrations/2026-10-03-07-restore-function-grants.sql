-- Restore who may EXECUTE the SECURITY DEFINER functions in public.
--
-- The 2026-10-03 move from the Tokyo project to CHANG lost the REVOKEs that the
-- earlier migrations had applied, so anon (not signed in) could call functions
-- that were meant for signed-in users or the server only -- among them
-- perform_worker_checkin_by_id / _checkout_by_id (clock any worker in or out by
-- id) and verify_cron_secret (a yes/no check on the cron secret).
--
-- This copies the real, working ACLs read from the Tokyo project, function by
-- function. It only changes who may call a function; no function body or data
-- is touched. Safe to re-run. A signature that no longer exists fails loudly.

DO $$
DECLARE sig text;
BEGIN
  -- Server only (service_role): internal triggers and endpoints reached through Edge Functions.
  FOREACH sig IN ARRAY ARRAY[
    'check_seat_limit_after_statement()',
    'handle_auth_user_deleted()',
    'handle_new_user()',
    'handle_user_role_deleted()',
    'notify_worker_offboarded()',
    'perform_worker_checkin_by_id(uuid,uuid,numeric,numeric)',
    'perform_worker_checkout_by_id(uuid,uuid,numeric,numeric)',
    'verify_cron_secret(text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', sig);
  END LOOP;

  -- Signed-in users and the server, but not anon: RLS helpers and app RPCs.
  FOREACH sig IN ARRAY ARRAY[
    'current_tenant_id()',
    'current_user_role()',
    'get_my_site_names()',
    'get_my_team_today()',
    'get_regular_shift_end_time()',
    'has_module_access(text)',
    'is_admin_or_owner()',
    'is_owner()',
    'my_assigned_phase_task_ids()',
    'my_worker_id()',
    'perform_location_checkin(numeric,numeric)',
    'perform_location_checkout(numeric,numeric)',
    'perform_worker_checkin(uuid,numeric,numeric)',
    'perform_worker_checkout(uuid,numeric,numeric,time without time zone,time without time zone,numeric,boolean,text)',
    'platform_list_tenants()',
    'platform_set_tenant_package(uuid,uuid)',
    'platform_set_tenant_status(uuid,text,timestamp with time zone)',
    'record_stock_movement(uuid,uuid,text,numeric,numeric,text,uuid,text)',
    'tenant_apply_pending_downgrade()',
    'tenant_can_write()',
    'tenant_cancel_pending_downgrade()',
    'tenant_document_scan_usage_this_month()',
    'tenant_downgrade_to_free()',
    'tenant_schedule_downgrade(uuid)',
    'tenant_seat_status()',
    'tenant_under_document_scan_limit()',
    'tenant_under_seat_limit(text,boolean)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', sig);
  END LOOP;
END $$;
