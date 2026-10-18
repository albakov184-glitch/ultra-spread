-- P2Pro, шаг 7: админ-панель в боте.
-- Подарочный PRO (выдан командой /give) сам не продлевается, даже если пользователь включит автопродление.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.
create or replace function public.demo_renew_pro() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions; add_days int; price int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.subscriptions where user_id = auth.uid() for update;
  if s.user_id is null or not s.auto_renew or s.pay_method = 'gift' or s.pro_until is null or s.pro_until > now() then return s; end if;
  add_days := case when s.period = 'y' then 365 else 30 end;
  price := case when s.period = 'y' then 3990 else 490 end;
  update public.subscriptions set
    pro_until = now() + make_interval(days => add_days),
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', price, 'period', s.period, 'method', coalesce(s.pay_method, 'card'), 'auto', true)) || payments
  where user_id = auth.uid() returning * into s;
  return s;
end $$;
revoke execute on function public.demo_renew_pro() from public, anon;
grant execute on function public.demo_renew_pro() to authenticated;

-- Ник Telegram для поиска в админке. Пишет только функция входа telegram-auth: данным профиля (user_metadata)
-- верить нельзя — пользователь может сам вписать туда чужой ник
alter table public.tg_users add column if not exists username text;
create index if not exists tg_users_username on public.tg_users (lower(username));

-- Подарок PRO из админки — одним действием на сервере, чтобы двойное нажатие не потеряло дни.
-- Платную подписку подарок только продлевает: способ оплаты и автопродление остаются как были
create or replace function public.admin_gift_pro(p_user uuid, p_days int) returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions; active boolean; gift boolean;
begin
  if p_days is null or p_days < 1 or p_days > 3650 then raise exception 'bad days'; end if;
  insert into public.subscriptions (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = p_user for update;
  active := s.pro_until is not null and s.pro_until > now();
  gift := not active or coalesce(s.pay_method, '') = 'gift';
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => p_days),
    pro_since = case when active then pro_since else now() end,
    auto_renew = case when gift then false else auto_renew end,
    pay_method = case when gift then 'gift' else pay_method end,
    period = case when gift then 'm' else period end,
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', 0, 'period', 'm', 'method', 'gift', 'days', p_days)) || payments
  where user_id = p_user returning * into s;
  return s;
end $$;
revoke execute on function public.admin_gift_pro(uuid, int) from public, anon, authenticated;
grant execute on function public.admin_gift_pro(uuid, int) to service_role;
