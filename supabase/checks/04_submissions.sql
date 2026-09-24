-- Read-only checks for Release 2. Run only after order_submissions migration.
-- Privileges match supabase/migrations/20260907010000_order_submissions.sql:
-- authenticated may read submissions and confirmation keys and execute the
-- owner RPCs; service_role may write submissions and execute the rate-limit
-- RPC. Anon or authenticated writes, and EXECUTE outside that split, fail.
-- This file does not change data, grants, or authentication state.

select 'order_submissions_rls' as check_name,
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.order_submissions')), false) as passed
union all
select 'rate_limits_rls',
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.order_submission_rate_limits')), false)
union all
select 'confirmation_keys_rls',
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.order_confirmation_keys')), false)
union all
select 'owner_can_read_submissions',
  coalesce(has_table_privilege('authenticated', to_regclass('public.order_submissions'), 'SELECT'), false)
union all
select 'anon_cannot_read_submissions',
  coalesce(not has_table_privilege('anon', to_regclass('public.order_submissions'), 'SELECT'), false)
union all
select 'anon_cannot_write_submissions',
  coalesce(not has_table_privilege('anon', to_regclass('public.order_submissions'), 'INSERT'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_submissions'), 'UPDATE'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_submissions'), 'DELETE'), false)
union all
select 'authenticated_cannot_write_submissions',
  coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submissions'), 'INSERT'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submissions'), 'UPDATE'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submissions'), 'DELETE'), false)
union all
select 'service_role_can_write_submissions',
  coalesce(has_table_privilege('service_role', to_regclass('public.order_submissions'), 'SELECT'), false)
  and coalesce(has_table_privilege('service_role', to_regclass('public.order_submissions'), 'INSERT'), false)
  and coalesce(has_table_privilege('service_role', to_regclass('public.order_submissions'), 'UPDATE'), false)
union all
select 'anon_cannot_access_rate_limits',
  coalesce(not has_table_privilege('anon', to_regclass('public.order_submission_rate_limits'), 'SELECT'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_submission_rate_limits'), 'INSERT'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_submission_rate_limits'), 'UPDATE'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_submission_rate_limits'), 'DELETE'), false)
union all
select 'authenticated_cannot_access_rate_limits',
  coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submission_rate_limits'), 'SELECT'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submission_rate_limits'), 'INSERT'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submission_rate_limits'), 'UPDATE'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_submission_rate_limits'), 'DELETE'), false)
union all
select 'confirmation_keys_owner_read_only',
  coalesce(has_table_privilege('authenticated', to_regclass('public.order_confirmation_keys'), 'SELECT'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_confirmation_keys'), 'INSERT'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_confirmation_keys'), 'UPDATE'), false)
  and coalesce(not has_table_privilege('authenticated', to_regclass('public.order_confirmation_keys'), 'DELETE'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_confirmation_keys'), 'SELECT'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_confirmation_keys'), 'INSERT'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_confirmation_keys'), 'UPDATE'), false)
  and coalesce(not has_table_privilege('anon', to_regclass('public.order_confirmation_keys'), 'DELETE'), false)
union all
select 'owner_accept_rpc',
  coalesce(has_function_privilege('authenticated', to_regprocedure('public.accept_order_submission(uuid,text)'), 'EXECUTE'), false)
union all
select 'anon_cannot_execute_accept',
  coalesce(not has_function_privilege('anon', to_regprocedure('public.accept_order_submission(uuid,text)'), 'EXECUTE'), false)
union all
select 'owner_reject_rpc',
  coalesce(has_function_privilege('authenticated', to_regprocedure('public.reject_order_submission(uuid)'), 'EXECUTE'), false)
union all
select 'anon_cannot_execute_reject',
  coalesce(not has_function_privilege('anon', to_regprocedure('public.reject_order_submission(uuid)'), 'EXECUTE'), false)
union all
select 'confirmation_rpc_owner_only',
  coalesce(has_function_privilege('authenticated', to_regprocedure('public.create_order_with_confirmation(text,text,jsonb,jsonb)'), 'EXECUTE'), false)
  and coalesce(not has_function_privilege('anon', to_regprocedure('public.create_order_with_confirmation(text,text,jsonb,jsonb)'), 'EXECUTE'), false)
union all
select 'rate_limit_service_rpc',
  coalesce(has_function_privilege('service_role', to_regprocedure('public.consume_order_submission_rate_limit(text,integer)'), 'EXECUTE'), false)
  and coalesce(not has_function_privilege('anon', to_regprocedure('public.consume_order_submission_rate_limit(text,integer)'), 'EXECUTE'), false)
  and coalesce(not has_function_privilege('authenticated', to_regprocedure('public.consume_order_submission_rate_limit(text,integer)'), 'EXECUTE'), false)
union all
select 'pending_rows_empty',
  (select count(*) = 0 from public.order_submissions)
order by check_name;
