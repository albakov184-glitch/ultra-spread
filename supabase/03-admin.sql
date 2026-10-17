-- P2Pro, шаг 3: тест-панель подписки работает только для владельца.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Владелец проекта: только эта почта может ставить себе любой срок PRO через тест-панель
create or replace function public.is_admin() returns boolean
language sql stable set search_path = public as $$
  select coalesce(lower(auth.jwt() ->> 'email') = 'albakov184@gmail.com', false);
$$;

create or replace function public.demo_set_sub(p_period text, p_until timestamptz, p_auto boolean, p_clear boolean default false)
returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  insert into public.subscriptions (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  update public.subscriptions set
    period = case when p_period = 'y' then 'y' else 'm' end,
    pro_since = case when p_until is null then null else coalesce(pro_since, now()) end,
    pro_until = p_until,
    auto_renew = p_auto,
    payments = case when p_clear then '[]'::jsonb else payments end
  where user_id = auth.uid() returning * into s;
  return s;
end $$;

create or replace function public.demo_reset_pro() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.subscriptions set pro_until = null where user_id = auth.uid();
end $$;

revoke execute on function public.demo_set_sub(text, timestamptz, boolean, boolean) from public, anon;
revoke execute on function public.demo_reset_pro() from public, anon;
grant execute on function public.demo_set_sub(text, timestamptz, boolean, boolean) to authenticated;
grant execute on function public.demo_reset_pro() to authenticated;
