-- P2Pro, шаг 8: промокоды, напоминания и служебные данные админки бота.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Служебная память бота: черновик рассылки, включены ли автопосты, когда последний раз проверяли новых пользователей.
-- Доступ только у функций (ключ сервера)
create table if not exists public.bot_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bot_state enable row level security;
revoke all on public.bot_state from public, anon, authenticated;

-- Напоминание «PRO закончится через 3 дня» отправляем один раз на каждый срок
alter table public.subscriptions add column if not exists reminded_for timestamptz;

-- Промокоды: код → сколько дней PRO, сколько раз можно активировать, до какого числа
create table if not exists public.promo_codes (
  code text primary key check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,32}$'),
  days int not null check (days between 1 and 3650),
  max_uses int check (max_uses is null or max_uses > 0),
  uses int not null default 0,
  expires_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
-- Кто какой промокод активировал: один человек — один раз
create table if not exists public.promo_uses (
  code text not null references public.promo_codes (code) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  used_at timestamptz not null default now(),
  primary key (code, user_id)
);
alter table public.promo_codes enable row level security;
alter table public.promo_uses enable row level security;
revoke all on public.promo_codes from public, anon, authenticated;
revoke all on public.promo_uses from public, anon, authenticated;

-- Активация промокода из приложения. Дни прибавляются к текущему сроку; платная подписка остаётся платной
create or replace function public.redeem_promo(p_code text) returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare pc public.promo_codes; s public.subscriptions; active boolean; free boolean; c text := upper(trim(coalesce(p_code, '')));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into pc from public.promo_codes where code = c for update;
  if pc.code is null or not pc.active then raise exception 'promo_invalid'; end if;
  if pc.expires_at is not null and pc.expires_at < now() then raise exception 'promo_expired'; end if;
  if pc.max_uses is not null and pc.uses >= pc.max_uses then raise exception 'promo_used_up'; end if;
  if exists (select 1 from public.promo_uses where code = c and user_id = auth.uid()) then raise exception 'promo_already'; end if;
  insert into public.promo_uses (code, user_id) values (c, auth.uid());
  update public.promo_codes set uses = uses + 1 where code = c;
  insert into public.subscriptions (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = auth.uid() for update;
  active := s.pro_until is not null and s.pro_until > now();
  free := not active or coalesce(s.pay_method, '') in ('gift', 'promo');
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => pc.days),
    pro_since = case when active then pro_since else now() end,
    auto_renew = case when free then false else auto_renew end,
    pay_method = case when free then 'promo' else pay_method end,
    period = case when free then 'm' else period end,
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', 0, 'period', 'm', 'method', 'promo', 'days', pc.days, 'code', c)) || payments
  where user_id = auth.uid() returning * into s;
  return s;
end $$;
revoke execute on function public.redeem_promo(text) from public, anon;
grant execute on function public.redeem_promo(text) to authenticated;

-- Подарок и промокод сами не продлеваются (продление в демо-режиме — бесплатное)
create or replace function public.demo_renew_pro() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions;
begin
  -- Ничего не продлевает: бесплатное «автопродление» закрыто (13-security.sql). Только возвращает подписку
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.subscriptions where user_id = auth.uid();
  return s;
end $$;
revoke execute on function public.demo_renew_pro() from public, anon;
grant execute on function public.demo_renew_pro() to authenticated;

-- Подарок из админки тоже понимает промокодный срок: продлевает его, а платную подписку не трогает
create or replace function public.admin_gift_pro(p_user uuid, p_days int) returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions; active boolean; gift boolean;
begin
  if p_days is null or p_days < 1 or p_days > 3650 then raise exception 'bad days'; end if;
  insert into public.subscriptions (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = p_user for update;
  active := s.pro_until is not null and s.pro_until > now();
  gift := not active or coalesce(s.pay_method, '') in ('gift', 'promo');
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
