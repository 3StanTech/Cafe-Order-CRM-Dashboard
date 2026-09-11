-- Pending public order intake. Apply manually after reviewing the existing
-- owner-RLS migration; this file is intentionally additive and does not touch
-- existing operational rows.

begin;

do $$
begin
  if to_regprocedure('public.dashboard_owner_uid()') is null then
    raise exception 'Prerequisite missing: apply the owner-RLS migration before order submissions';
  end if;
end;
$$;

create table public.order_submissions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('CB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  idempotency_key text not null unique,
  request_hash text not null,
  quote_revision text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  customer_name text not null,
  customer_phone text not null,
  address_snapshot text not null,
  delivery_date date not null,
  notes text,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  thermal_bags jsonb not null default '[]'::jsonb check (jsonb_typeof(thermal_bags) = 'array'),
  catalog_snapshot jsonb not null check (jsonb_typeof(catalog_snapshot) = 'object'),
  priced_items jsonb not null check (jsonb_typeof(priced_items) = 'object'),
  subtotal_centavos integer not null check (subtotal_centavos >= 0),
  delivery_fee_centavos integer not null default 0 check (delivery_fee_centavos >= 0),
  total_centavos integer not null check (total_centavos >= 0),
  -- The submitted quote is immutable audit data.  Owner edits below replace
  -- only the current review fields and never change the customer's original
  -- request hash, idempotency receipt, or quoted amount.
  submitted_snapshot jsonb not null check (jsonb_typeof(submitted_snapshot) = 'object'),
  review_version integer not null default 0 check (review_version >= 0),
  review_hash text not null,
  -- Deleting an operational order must remain possible; the accepted
  -- submission is a historical receipt and must not resurrect that order.
  accepted_order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  rejected_at timestamptz,
  constraint order_submissions_accepted_result check (
    (status = 'accepted' and accepted_at is not null)
    or (status <> 'accepted' and accepted_order_id is null and accepted_at is null)
  ),
  constraint order_submissions_rejected_result check (
    (status = 'rejected' and rejected_at is not null)
    or (status <> 'rejected' and rejected_at is null)
  )
);

create table public.order_submission_rate_limits (
  key_hash text primary key,
  request_count integer not null default 0 check (request_count >= 0),
  window_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger order_submissions_set_updated_at
before update on public.order_submissions
for each row execute function public.set_updated_at();

create trigger order_submission_rate_limits_set_updated_at
before update on public.order_submission_rate_limits
for each row execute function public.set_updated_at();

alter table public.order_submissions enable row level security;
alter table public.order_submission_rate_limits enable row level security;

create policy "authenticated select order submissions"
on public.order_submissions for select to authenticated
using (auth.uid() = public.dashboard_owner_uid());

-- There is deliberately no authenticated UPDATE policy. Direct clients must
-- use the server-side owner edit path or owner-bound acceptance/rejection RPCs
-- so the verified quote, idempotency hash, and state transition remain safe.
revoke all on public.order_submissions from public, anon, authenticated;
grant select on public.order_submissions to authenticated;
grant select, insert, update on public.order_submissions to service_role;
-- The anonymous boundary uses the service role for its public menu quote.
grant select on public.settings to service_role;
revoke all on public.order_submission_rate_limits from public, anon, authenticated;
grant all on public.order_submission_rate_limits to service_role;

-- The anonymous route uses the server-only service role, and only the owner
-- can read or change pending submissions through the authenticated client.
create or replace function public.consume_order_submission_rate_limit(p_key_hash text, p_limit integer default 12)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  count_in_window integer;
begin
  if p_key_hash is null or length(p_key_hash) < 32 or p_limit < 1 then
    raise exception 'invalid rate-limit input';
  end if;

  delete from public.order_submission_rate_limits
  where updated_at < now() - interval '15 minutes';

  insert into public.order_submission_rate_limits (key_hash, request_count, window_started_at)
  values (p_key_hash, 1, now())
  on conflict (key_hash) do update
  set request_count = case
    when public.order_submission_rate_limits.window_started_at < now() - interval '1 minute' then 1
    else public.order_submission_rate_limits.request_count + 1
  end,
  window_started_at = case
    when public.order_submission_rate_limits.window_started_at < now() - interval '1 minute' then now()
    else public.order_submission_rate_limits.window_started_at
  end,
  updated_at = now()
  returning request_count into count_in_window;

  return count_in_window <= p_limit;
end;
$$;

revoke all on function public.consume_order_submission_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function public.consume_order_submission_rate_limit(text, integer) to service_role;

create or replace function public.accept_order_submission(p_submission_id uuid, p_request_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  submission public.order_submissions;
  customer public.customers;
  customer_count integer;
  matching_phone_count integer;
  inserted_order public.orders;
  item jsonb;
  product_id uuid;
  order_id uuid;
begin
  -- Keep this explicit even with RLS, so a future policy cannot turn this into
  -- an elevated write path for another authenticated account.
  if auth.uid() is null or auth.uid() is distinct from public.dashboard_owner_uid() then
    raise exception using errcode = '42501', message = 'dashboard owner access required';
  end if;

  select * into submission
  from public.order_submissions
  where id = p_submission_id
  for update;

  if submission.id is null then
    raise exception using errcode = 'P0002', message = 'order submission not found';
  end if;
  if submission.review_hash <> p_request_hash then
    raise exception using errcode = '22023', message = 'submission review is stale; refresh before accepting';
  end if;
  if submission.status = 'accepted' then
    return jsonb_build_object('status', submission.status, 'reference', submission.reference, 'order_id', submission.accepted_order_id, 'total_centavos', submission.total_centavos);
  end if;
  if submission.status <> 'pending' then
    raise exception using errcode = '22023', message = 'only pending submissions can be accepted';
  end if;

  -- Serialize customer matching for the same normalized name so concurrent
  -- acceptance from two owner devices cannot create duplicate customers.
  perform pg_advisory_xact_lock(hashtextextended(lower(btrim(submission.customer_name)), 0));
  select count(*) into customer_count
  from public.customers
  where lower(btrim(name)) = lower(btrim(submission.customer_name));

  if customer_count = 0 then
    insert into public.customers (name, phone)
    values (submission.customer_name, submission.customer_phone)
    returning * into customer;
  elsif customer_count = 1 then
    select * into customer from public.customers
    where lower(btrim(name)) = lower(btrim(submission.customer_name))
    for update;
    if customer.phone is null or btrim(customer.phone) = '' then
      update public.customers set phone = submission.customer_phone where id = customer.id returning * into customer;
    elsif regexp_replace(customer.phone, '[^0-9]', '', 'g') <> regexp_replace(submission.customer_phone, '[^0-9]', '', 'g') then
      raise exception using errcode = '22023', message = 'customer name exists with a different contact number; resolve this in Viber before accepting';
    end if;
  else
    select count(*) into matching_phone_count
    from public.customers
    where lower(btrim(name)) = lower(btrim(submission.customer_name))
      and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = regexp_replace(submission.customer_phone, '[^0-9]', '', 'g');
    if matching_phone_count <> 1 then
      raise exception using errcode = '22023', message = 'multiple customers share this name; resolve this in Viber before accepting';
    end if;
    select * into customer from public.customers
    where lower(btrim(name)) = lower(btrim(submission.customer_name))
      and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = regexp_replace(submission.customer_phone, '[^0-9]', '', 'g')
    for update;
  end if;

  order_id := gen_random_uuid();
  insert into public.orders (
    id, customer_id, status, delivery_date, payment_received,
    subtotal_centavos, delivery_fee_centavos, total_centavos,
    raw_source, address_snapshot, notes
  ) values (
    order_id, customer.id, 'new', submission.delivery_date, false,
    submission.subtotal_centavos, submission.delivery_fee_centavos, submission.total_centavos,
    'public_order_link', submission.address_snapshot, submission.notes
  ) returning * into inserted_order;

  for item in select jsonb_array_elements((submission.priced_items->'items'))
  loop
    select id into product_id
    from public.products
    where lower(name) = lower(item->>'product_name')
    order by created_at
    limit 1;
    if product_id is null then
      raise exception using errcode = '22023', message = 'submitted product is no longer available';
    end if;
    insert into public.order_items (
      order_id, product_id, product_name_snapshot, quantity, modifiers,
      unit_price_centavos, line_total_centavos
    ) values (
      inserted_order.id, product_id, item->>'product_name', (item->>'quantity')::integer,
      coalesce(item->'modifiers', '{}'::jsonb), (item->>'unit_price_centavos')::integer,
      (item->>'line_total_centavos')::integer
    );
  end loop;

  update public.order_submissions
  set status = 'accepted', accepted_order_id = inserted_order.id, accepted_at = now()
  where id = submission.id;

  return jsonb_build_object('status', 'accepted', 'reference', submission.reference, 'order_id', inserted_order.id, 'total_centavos', submission.total_centavos);
end;
$$;

revoke all on function public.accept_order_submission(uuid, text) from public, anon;
grant execute on function public.accept_order_submission(uuid, text) to authenticated;

create or replace function public.reject_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  submission public.order_submissions;
begin
  if auth.uid() is null or auth.uid() is distinct from public.dashboard_owner_uid() then
    raise exception using errcode = '42501', message = 'dashboard owner access required';
  end if;
  select * into submission from public.order_submissions where id = p_submission_id for update;
  if submission.id is null then raise exception using errcode = 'P0002', message = 'order submission not found'; end if;
  if submission.status = 'rejected' then
    return jsonb_build_object('status', submission.status, 'reference', submission.reference);
  end if;
  if submission.status <> 'pending' then raise exception using errcode = '22023', message = 'only pending submissions can be rejected'; end if;
  update public.order_submissions set status = 'rejected', rejected_at = now() where id = submission.id;
  return jsonb_build_object('status', 'rejected', 'reference', submission.reference);
end;
$$;

revoke all on function public.reject_order_submission(uuid) from public, anon;
grant execute on function public.reject_order_submission(uuid) to authenticated;

-- Durable confirmation keys make a retried Viber batch idempotent across
-- browser refreshes and uncertain network responses.
create table public.order_confirmation_keys (
  confirmation_key text primary key,
  request_hash text not null,
  -- Deliberately a tombstone-friendly UUID without an FK: an accepted order
  -- may be deleted through the existing owner workflow while the key remains
  -- durable and prevents a retry from resurrecting it.
  order_id uuid,
  created_at timestamptz not null default now()
);

alter table public.order_confirmation_keys enable row level security;
revoke all on public.order_confirmation_keys from public, anon, authenticated;
grant select on public.order_confirmation_keys to authenticated;

create or replace function public.create_order_with_confirmation(
  p_confirmation_key text,
  p_request_hash text,
  p_order jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  existing_key public.order_confirmation_keys;
  customer public.customers;
  inserted public.orders;
  item jsonb;
  claimed boolean := false;
  claimed_key text;
  order_id uuid := gen_random_uuid();
  customer_id uuid;
  customer_name text;
  customer_phone text;
  customer_count integer;
  matching_phone_count integer;
begin
  if auth.uid() is null or auth.uid() is distinct from public.dashboard_owner_uid() then
    raise exception using errcode = '42501', message = 'dashboard owner access required';
  end if;
  if p_confirmation_key is null or length(btrim(p_confirmation_key)) < 16 or p_request_hash is null or length(btrim(p_request_hash)) < 32 then
    raise exception using errcode = '22023', message = 'a durable confirmation key and request hash are required';
  end if;

  insert into public.order_confirmation_keys (confirmation_key, request_hash, order_id)
  values (btrim(p_confirmation_key), p_request_hash, order_id)
  on conflict (confirmation_key) do nothing
  returning confirmation_key into claimed_key;
  claimed := found;

  select * into existing_key
  from public.order_confirmation_keys
  where confirmation_key = btrim(p_confirmation_key)
  for update;

  if existing_key.request_hash <> p_request_hash then
    raise exception using errcode = '22023', message = 'confirmation key was already used for another payload';
  end if;
  if not claimed and existing_key.order_id is not null and exists (select 1 from public.orders where id = existing_key.order_id) then
    select * into inserted from public.orders where id = existing_key.order_id;
    return to_jsonb(inserted);
  end if;
  if not claimed then
    raise exception using errcode = '22023', message = 'confirmation key points to a deleted order';
  end if;

  customer_id := nullif(p_order->>'customer_id', '')::uuid;
  if customer_id is null then
    customer_name := nullif(btrim(coalesce(p_order->>'customer_name', p_order->'customer'->>'name')), '');
    customer_phone := nullif(btrim(coalesce(p_order->>'customer_phone', p_order->'customer'->>'phone')), '');
    if customer_name is null then
      raise exception using errcode = '22023', message = 'customer name is required for confirmation';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(lower(customer_name), 0));
    select count(*) into customer_count from public.customers where lower(btrim(name)) = lower(customer_name);
    if customer_count = 0 then
      insert into public.customers (name, phone) values (customer_name, customer_phone) returning * into customer;
    elsif customer_count = 1 then
      select * into customer from public.customers where lower(btrim(name)) = lower(customer_name) for update;
      if customer.phone is null or btrim(customer.phone) = '' then
        update public.customers set phone = customer_phone where id = customer.id returning * into customer;
      elsif customer_phone is not null and regexp_replace(customer.phone, '[^0-9]', '', 'g') <> regexp_replace(customer_phone, '[^0-9]', '', 'g') then
        raise exception using errcode = '22023', message = 'customer name exists with a different contact number; resolve before confirming';
      end if;
    else
      select count(*) into matching_phone_count from public.customers
      where lower(btrim(name)) = lower(customer_name)
        and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = regexp_replace(customer_phone, '[^0-9]', '', 'g');
      if matching_phone_count <> 1 then
        raise exception using errcode = '22023', message = 'multiple customers share this name; resolve before confirming';
      end if;
      select * into customer from public.customers
      where lower(btrim(name)) = lower(customer_name)
        and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = regexp_replace(customer_phone, '[^0-9]', '', 'g')
      for update;
    end if;
    customer_id := customer.id;
  end if;

  insert into public.orders (
    id, customer_id, status, delivery_date, payment_received,
    subtotal_centavos, delivery_fee_centavos, total_centavos,
    raw_source, address_snapshot, notes, route_position
  ) values (
    order_id,
    customer_id,
    'new',
    nullif(p_order->>'delivery_date', '')::date,
    false,
    (p_order->>'subtotal_centavos')::integer,
    (p_order->>'delivery_fee_centavos')::integer,
    (p_order->>'total_centavos')::integer,
    coalesce(p_order->>'raw_source', 'viber_import'),
    p_order->>'address_snapshot',
    p_order->>'notes',
    nullif(p_order->>'route_position', '')::integer
  ) returning * into inserted;

  for item in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.order_items (
      id, order_id, product_id, product_name_snapshot, quantity, modifiers,
      unit_price_centavos, line_total_centavos
    ) values (
      gen_random_uuid(), inserted.id, (item->>'product_id')::uuid,
      item->>'product_name_snapshot', (item->>'quantity')::integer,
      coalesce(item->'modifiers', '{}'::jsonb), (item->>'unit_price_centavos')::integer,
      (item->>'line_total_centavos')::integer
    );
  end loop;

  return to_jsonb(inserted);
end;
$$;

revoke all on function public.create_order_with_confirmation(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.create_order_with_confirmation(text, text, jsonb, jsonb) to authenticated;

commit;
