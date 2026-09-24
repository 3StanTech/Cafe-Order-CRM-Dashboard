-- Rebind the fresh Bubu Cafe project's owner lookup to the Auth identity
-- created for this relaunch. Apply once to project rcyhthbbexzsvtpjyptj
-- after confirming the email and UID in Authentication > Users.

begin;

do $$
begin
  if not exists (
    select 1 from auth.users
    where id = 'df339f22-d142-44d1-98fd-570cd8b29f7c'::uuid
      and email = 'acosta.angelatherese@gmail.com'
      and email_confirmed_at is not null
  ) then
    raise exception 'Expected confirmed Bubu Cafe owner Auth identity is missing';
  end if;
end;
$$;

create or replace function public.dashboard_owner_uid()
returns uuid
language sql
stable
security definer
set search_path = auth, public
as $$
  select id
  from auth.users
  where id = 'df339f22-d142-44d1-98fd-570cd8b29f7c'::uuid
    and email = 'acosta.angelatherese@gmail.com'
  limit 1
$$;

revoke all on function public.dashboard_owner_uid() from public;
grant execute on function public.dashboard_owner_uid() to authenticated;

commit;
