begin;

create extension if not exists pgcrypto;

create type public.order_status as enum (
  'new',
  'paid',
  'delivered',
  'cancelled'
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_centavos integer not null check (price_centavos >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- DORMANT TABLE — expected to be empty in production; nothing reads or writes it.
-- The app's modifiers are a fixed union in src/domain/contracts.ts, assigned per
-- product in src/domain/catalog.ts; per-cup selections live in order_items.modifiers
-- jsonb. Owner-editable catalog data is persisted as JSON in `settings` (see
-- getRuntimeCatalog()) — extend that for editable modifiers, not this table.
-- Rows appearing here are a signal that something unexpected wrote to it.
-- Kept rather than dropped because it is inert: no rows, no FK references, no cost.
create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  applies_to_product_ids uuid[] not null default '{}',
  options jsonb not null default '[]'::jsonb,
  allows_multiple boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  status public.order_status not null default 'new',
  delivery_date date,
  payment_received boolean not null default false,
  constraint orders_status_payment_consistent check (
    (status = 'new' and not payment_received)
    or (status in ('paid', 'delivered') and payment_received)
    or status = 'cancelled'
  ),
  subtotal_centavos integer not null check (subtotal_centavos >= 0),
  delivery_fee_centavos integer not null default 0 check (delivery_fee_centavos >= 0),
  total_centavos integer not null check (total_centavos >= 0),
  raw_source text not null,
  address_snapshot text,
  notes text,
  route_position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  delivered_at timestamptz,
  constraint orders_lifecycle_timestamps_consistent check (
    (status = 'new' and paid_at is null and delivered_at is null)
    or (status = 'paid' and paid_at is not null and delivered_at is null)
    or (status = 'delivered' and paid_at is not null and delivered_at is not null and paid_at <= delivered_at)
    or (status = 'cancelled' and delivered_at is null)
  )
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  modifiers jsonb not null default '{}'::jsonb,
  unit_price_centavos integer not null check (unit_price_centavos >= 0),
  line_total_centavos integer not null check (line_total_centavos >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.set_order_lifecycle_timestamps()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'new' then
      new.paid_at := null;
      new.delivered_at := null;
    elsif new.status = 'paid' then
      new.paid_at := coalesce(new.paid_at, now());
      new.delivered_at := null;
    elsif new.status = 'delivered' then
      new.paid_at := coalesce(new.paid_at, now());
      new.delivered_at := coalesce(new.delivered_at, now());
    elsif new.status = 'cancelled' then
      new.delivered_at := null;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from 'paid' and new.status = 'paid' then
      new.paid_at := coalesce(old.paid_at, now());
      new.delivered_at := null;
    elsif old.status is distinct from 'delivered' and new.status = 'delivered' then
      new.paid_at := coalesce(old.paid_at, now());
      new.delivered_at := coalesce(old.delivered_at, now());
    elsif old.status is distinct from 'cancelled' and new.status = 'cancelled' then
      new.paid_at := old.paid_at;
      new.delivered_at := null;
    else
      new.paid_at := old.paid_at;
      new.delivered_at := old.delivered_at;
    end if;
  end if;
  return new;
end;
$$;

create trigger products_set_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger modifier_groups_set_updated_at before update on public.modifier_groups for each row execute function public.set_updated_at();
create trigger customers_set_updated_at before update on public.customers for each row execute function public.set_updated_at();
create trigger orders_set_updated_at before update on public.orders for each row execute function public.set_updated_at();
create trigger orders_set_lifecycle_timestamps before insert or update on public.orders for each row execute function public.set_order_lifecycle_timestamps();
create trigger order_items_set_updated_at before update on public.order_items for each row execute function public.set_updated_at();
create trigger settings_set_updated_at before update on public.settings for each row execute function public.set_updated_at();

alter table public.products enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.settings enable row level security;

-- This project disables automatic Data API grants for newly created tables.
-- RLS still limits these authenticated privileges to the dashboard owner.
grant usage on schema public to authenticated;
revoke all on public.products, public.modifier_groups, public.customers,
  public.orders, public.order_items, public.settings from public, anon, authenticated;
grant select, insert, update, delete on public.products, public.customers,
  public.orders, public.order_items, public.settings to authenticated;
-- modifier_groups is dormant; retain the table without granting app access.

create or replace function public.dashboard_owner_uid()
returns uuid
language sql
stable
security definer
set search_path = auth, public
as $$
  select id
  from auth.users
  where email = 'acosta.angelatherese@gmail.com'
  limit 1
$$;

revoke all on function public.dashboard_owner_uid() from public;
grant execute on function public.dashboard_owner_uid() to authenticated;

create policy "authenticated select products" on public.products for select to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated insert products" on public.products for insert to authenticated with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated update products" on public.products for update to authenticated using (auth.uid() = public.dashboard_owner_uid()) with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated delete products" on public.products for delete to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated select modifier_groups" on public.modifier_groups for select to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated insert modifier_groups" on public.modifier_groups for insert to authenticated with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated update modifier_groups" on public.modifier_groups for update to authenticated using (auth.uid() = public.dashboard_owner_uid()) with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated delete modifier_groups" on public.modifier_groups for delete to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated select customers" on public.customers for select to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated insert customers" on public.customers for insert to authenticated with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated update customers" on public.customers for update to authenticated using (auth.uid() = public.dashboard_owner_uid()) with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated delete customers" on public.customers for delete to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated select orders" on public.orders for select to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated insert orders" on public.orders for insert to authenticated with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated update orders" on public.orders for update to authenticated using (auth.uid() = public.dashboard_owner_uid()) with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated delete orders" on public.orders for delete to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated select order_items" on public.order_items for select to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated insert order_items" on public.order_items for insert to authenticated with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated update order_items" on public.order_items for update to authenticated using (auth.uid() = public.dashboard_owner_uid()) with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated delete order_items" on public.order_items for delete to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated select settings" on public.settings for select to authenticated using (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated insert settings" on public.settings for insert to authenticated with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated update settings" on public.settings for update to authenticated using (auth.uid() = public.dashboard_owner_uid()) with check (auth.uid() = public.dashboard_owner_uid());
create policy "authenticated delete settings" on public.settings for delete to authenticated using (auth.uid() = public.dashboard_owner_uid());

create or replace function public.create_order_with_items(p_order jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted public.orders;
  item jsonb;
begin
  insert into public.orders (
    id, customer_id, status, delivery_date, payment_received,
    subtotal_centavos, delivery_fee_centavos, total_centavos,
    raw_source, address_snapshot, notes, route_position
  ) values (
    (p_order->>'id')::uuid,
    (p_order->>'customer_id')::uuid,
    (p_order->>'status')::public.order_status,
    nullif(p_order->>'delivery_date', '')::date,
    coalesce((p_order->>'payment_received')::boolean, false),
    (p_order->>'subtotal_centavos')::integer,
    (p_order->>'delivery_fee_centavos')::integer,
    (p_order->>'total_centavos')::integer,
    coalesce(p_order->>'raw_source', ''),
    p_order->>'address_snapshot',
    p_order->>'notes',
    nullif(p_order->>'route_position', '')::integer
  )
  returning * into inserted;

  for item in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.order_items (
      id, order_id, product_id, product_name_snapshot, quantity, modifiers,
      unit_price_centavos, line_total_centavos
    ) values (
      (item->>'id')::uuid,
      inserted.id,
      (item->>'product_id')::uuid,
      item->>'product_name_snapshot',
      (item->>'quantity')::integer,
      coalesce(item->'modifiers', '{}'::jsonb),
      (item->>'unit_price_centavos')::integer,
      (item->>'line_total_centavos')::integer
    );
  end loop;

  return to_jsonb(inserted);
end;
$$;

create or replace function public.replace_order_items(p_order_id uuid, p_order jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  updated public.orders;
  item jsonb;
begin
  delete from public.order_items where order_id = p_order_id;

  for item in select jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.order_items (
      id, order_id, product_id, product_name_snapshot, quantity, modifiers,
      unit_price_centavos, line_total_centavos
    ) values (
      (item->>'id')::uuid,
      p_order_id,
      (item->>'product_id')::uuid,
      item->>'product_name_snapshot',
      (item->>'quantity')::integer,
      coalesce(item->'modifiers', '{}'::jsonb),
      (item->>'unit_price_centavos')::integer,
      (item->>'line_total_centavos')::integer
    );
  end loop;

  update public.orders
  set
    subtotal_centavos = coalesce((p_order->>'subtotal_centavos')::integer, subtotal_centavos),
    delivery_fee_centavos = coalesce((p_order->>'delivery_fee_centavos')::integer, delivery_fee_centavos),
    total_centavos = coalesce((p_order->>'total_centavos')::integer, total_centavos),
    delivery_date = case
      when p_order ? 'delivery_date' then nullif(p_order->>'delivery_date', '')::date
      else delivery_date
    end,
    address_snapshot = case
      when p_order ? 'address_snapshot' then p_order->>'address_snapshot'
      else address_snapshot
    end,
    notes = case
      when p_order ? 'notes' then p_order->>'notes'
      else notes
    end
  where id = p_order_id
  returning * into updated;

  if updated.id is null then
    raise exception 'orders record % does not exist.', p_order_id;
  end if;

  return to_jsonb(updated);
end;
$$;

create or replace function public.delete_customer_cascade(p_customer_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.orders where customer_id = p_customer_id;
  delete from public.settings where key = 'customer:' || p_customer_id::text || ':profile';
  delete from public.customers where id = p_customer_id;
end;
$$;

revoke all on function public.create_order_with_items(jsonb, jsonb) from public;
revoke all on function public.replace_order_items(uuid, jsonb, jsonb) from public;
revoke all on function public.delete_customer_cascade(uuid) from public;
grant execute on function public.create_order_with_items(jsonb, jsonb) to authenticated;
grant execute on function public.replace_order_items(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.delete_customer_cascade(uuid) to authenticated;

alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.modifier_groups;
alter publication supabase_realtime add table public.customers;
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
alter publication supabase_realtime add table public.settings;

commit;
