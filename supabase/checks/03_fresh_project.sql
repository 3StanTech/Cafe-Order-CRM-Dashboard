-- Read-only checks for the fresh Bubu Cafe project.
-- Run after schema.sql. Before the owner Auth user exists, owner_uid_present
-- and owner_uid_is_expected_user are false, never null. After that user exists,
-- both are true only for UID df339f22-d142-44d1-98fd-570cd8b29f7c.
-- initial_operational_rows_empty is expected only before first app use.
-- Each active table needs four authenticated owner policies. A permissive
-- USING (true) or WITH CHECK (true) policy fails. modifier_groups is dormant:
-- this file does not require it to have app policies or grants.
-- This file does not change data, grants, or authentication state.

with active_tables(name) as (
  values ('products'), ('customers'), ('orders'), ('order_items'), ('settings')
), policy_shape as (
  select
    tablename,
    cmd,
    permissive,
    roles::text[] as roles,
    qual,
    with_check
  from pg_policies
  where schemaname = 'public'
), owner_predicate(expression) as (
  select expression
  from (
    values
      ('(auth\.uid\(\)\)?\s*=\s*\(?(public\.)?dashboard_owner_uid\(\))')
  ) as patterns(expression)
), base_checks as (
  select 'base_table_exists:' || name as check_name,
    to_regclass('public.' || name) is not null as passed
  from active_tables
  union all
  select 'base_table_rls:' || name,
    coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || name)), false)
  from active_tables
  union all
  select 'authenticated_crud:' || name,
    coalesce(has_table_privilege('authenticated', to_regclass('public.' || name), 'SELECT'), false)
    and coalesce(has_table_privilege('authenticated', to_regclass('public.' || name), 'INSERT'), false)
    and coalesce(has_table_privilege('authenticated', to_regclass('public.' || name), 'UPDATE'), false)
    and coalesce(has_table_privilege('authenticated', to_regclass('public.' || name), 'DELETE'), false)
  from active_tables
  union all
  select 'anon_no_crud:' || name,
    not coalesce(has_table_privilege('anon', to_regclass('public.' || name), 'SELECT,INSERT,UPDATE,DELETE'), false)
  from active_tables
  union all
  select 'owner_rls_policy:' || name,
    coalesce((
      select count(*) = 4
        and count(*) filter (where cmd = 'SELECT') = 1
        and count(*) filter (where cmd = 'INSERT') = 1
        and count(*) filter (where cmd = 'UPDATE') = 1
        and count(*) filter (where cmd = 'DELETE') = 1
        and coalesce(bool_and(coalesce(
          permissive = 'PERMISSIVE'
          and roles = array['authenticated']
          and coalesce(qual, '') !~* '\m(true|or)\M'
          and coalesce(with_check, '') !~* '\m(true|or)\M'
          and case cmd
            when 'SELECT' then coalesce(qual ~ (select expression from owner_predicate), false) and with_check is null
            when 'DELETE' then coalesce(qual ~ (select expression from owner_predicate), false) and with_check is null
            when 'INSERT' then qual is null and coalesce(with_check ~ (select expression from owner_predicate), false)
            when 'UPDATE' then coalesce(qual ~ (select expression from owner_predicate), false)
              and coalesce(with_check ~ (select expression from owner_predicate), false)
            else false
          end
        , false)), false)
      from policy_shape
      where tablename = name
    ), false)
  from active_tables
  union all
  select 'no_permissive_true_policy:' || name,
    not exists (
      select 1
      from policy_shape
      where tablename = name
        and (
          coalesce(qual, '') ~* '(^\(?\s*true\s*\)?$|\mtrue\M)'
          or coalesce(with_check, '') ~* '(^\(?\s*true\s*\)?$|\mtrue\M)'
        )
    )
  from active_tables
), function_checks as (
  select 'owner_uid_present' as check_name,
    coalesce(public.dashboard_owner_uid() is not null, false) as passed
  union all
  select 'owner_uid_is_expected_user',
    coalesce(
      public.dashboard_owner_uid() = 'df339f22-d142-44d1-98fd-570cd8b29f7c'::uuid,
      false
    )
  union all
  select 'owner_uid_not_public',
    coalesce(not has_function_privilege('anon', 'public.dashboard_owner_uid()', 'EXECUTE'), false)
  union all
  select 'create_order_rpc_owner_only',
    coalesce(
      has_function_privilege('authenticated', 'public.create_order_with_items(jsonb,jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.create_order_with_items(jsonb,jsonb)', 'EXECUTE'),
      false
    )
  union all
  select 'replace_items_rpc_owner_only',
    coalesce(
      has_function_privilege('authenticated', 'public.replace_order_items(uuid,jsonb,jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.replace_order_items(uuid,jsonb,jsonb)', 'EXECUTE'),
      false
    )
  union all
  select 'delete_customer_rpc_owner_only',
    coalesce(
      has_function_privilege('authenticated', 'public.delete_customer_cascade(uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.delete_customer_cascade(uuid)', 'EXECUTE'),
      false
    )
), data_checks as (
  select 'modifier_groups_dormant' as check_name,
    (select count(*) = 0 from public.modifier_groups)
    and coalesce(not has_table_privilege('authenticated', 'public.modifier_groups', 'SELECT'), false)
    and coalesce(not has_table_privilege('authenticated', 'public.modifier_groups', 'INSERT'), false)
    and coalesce(not has_table_privilege('authenticated', 'public.modifier_groups', 'UPDATE'), false)
    and coalesce(not has_table_privilege('authenticated', 'public.modifier_groups', 'DELETE'), false)
    and not exists (
      select 1
      from policy_shape
      where tablename = 'modifier_groups'
        and (
          coalesce(qual, '') ~* '(^\(?\s*true\s*\)?$|\mtrue\M)'
          or coalesce(with_check, '') ~* '(^\(?\s*true\s*\)?$|\mtrue\M)'
          or roles && array['anon', 'public']
        )
    ) as passed
  union all
  select 'lifecycle_constraint_present',
    exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_lifecycle_timestamps_consistent')
  union all
  select 'payment_constraint_present',
    exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_status_payment_consistent')
  union all
  select 'initial_operational_rows_empty',
    (select count(*) = 0 from public.products)
    and (select count(*) = 0 from public.customers)
    and (select count(*) = 0 from public.orders)
    and (select count(*) = 0 from public.order_items)
    and (select count(*) = 0 from public.settings)
)
select check_name, passed from base_checks
union all select check_name, passed from function_checks
union all select check_name, passed from data_checks
order by check_name;
