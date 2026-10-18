-- P2Pro, шаг 3: тест-панель подписки работает только для владельца.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Владелец проекта: только он может ставить себе любой срок PRO через тест-панель.
-- Проверяем по постоянному id аккаунта, а не по почте: если аккаунт когда-нибудь удалят,
-- новый человек с той же почтой владельцем не станет. id находим по почте один раз — при запуске скрипта
do $do$
declare owner uuid;
begin
  select id into owner from auth.users where lower(email) = 'albakov184@gmail.com';
  if owner is null then raise exception 'Сначала зарегистрируйте аккаунт владельца albakov184@gmail.com'; end if;
  execute format($f$create or replace function public.is_admin() returns boolean
    language sql stable set search_path = public as $b$ select coalesce(auth.uid() = %L::uuid, false) $b$$f$, owner);
end
$do$;

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
