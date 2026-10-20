-- P2Pro, шаг 10: оплата PRO звёздами Telegram (Stars) в мини-аппе.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Платежи звёздами. charge_id — номер платежа от Telegram: по нему одна оплата даёт PRO ровно один раз,
-- даже если Telegram пришлёт уведомление повторно. Пишут только функции бота (ключ сервера)
create table if not exists public.star_payments (
  charge_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  tg_id bigint,
  period text not null check (period in ('m', 'y')),
  stars int not null check (stars > 0),
  refunded boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.star_payments enable row level security;
revoke all on public.star_payments from public, anon, authenticated;

-- Выдать PRO за оплату звёздами: месяц — 30 дней, год — 365, к текущему сроку
create or replace function public.stars_grant_pro(p_user uuid, p_period text, p_charge text, p_stars int, p_tg bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions; d int := case when p_period = 'y' then 365 else 30 end; active boolean;
begin
  if p_period not in ('m', 'y') then raise exception 'bad period'; end if;
  insert into public.star_payments (charge_id, user_id, tg_id, period, stars) values (p_charge, p_user, p_tg, p_period, p_stars)
    on conflict (charge_id) do nothing;
  if not found then return jsonb_build_object('fresh', false); end if;   -- этот платёж уже учтён
  insert into public.subscriptions (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = p_user for update;
  active := s.pro_until is not null and s.pro_until > now();
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => d),
    pro_since = case when active then pro_since else now() end,
    auto_renew = false, pay_method = 'stars', period = p_period,
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', p_stars, 'currency', 'XTR', 'period', p_period, 'method', 'stars', 'charge', p_charge)) || payments
  where user_id = p_user returning * into s;
  return jsonb_build_object('fresh', true, 'pro_until', s.pro_until);
end $$;
revoke execute on function public.stars_grant_pro(uuid, text, text, int, bigint) from public, anon, authenticated;
grant execute on function public.stars_grant_pro(uuid, text, text, int, bigint) to service_role;

-- Возврат звёзд (команда /refund в админке): отмечаем платёж и убираем оплаченные дни
create or replace function public.stars_refund(p_charge text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.star_payments; d int;
begin
  update public.star_payments set refunded = true where charge_id = p_charge and not refunded returning * into p;
  if p.charge_id is null then return jsonb_build_object('ok', false); end if;
  d := case when p.period = 'y' then 365 else 30 end;
  update public.subscriptions set
    pro_until = greatest(now(), pro_until - make_interval(days => d)),
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', -p.stars, 'currency', 'XTR', 'period', p.period, 'method', 'stars', 'charge', p.charge_id, 'refund', true)) || payments
  where user_id = p.user_id;
  return jsonb_build_object('ok', true, 'user_id', p.user_id, 'tg_id', p.tg_id, 'stars', p.stars);
end $$;
revoke execute on function public.stars_refund(text) from public, anon, authenticated;
grant execute on function public.stars_refund(text) to service_role;

-- Оплата звёздами разовая: сама не продлевается (демо-продление было бы бесплатным)
create or replace function public.demo_renew_pro() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions; add_days int; price int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.subscriptions where user_id = auth.uid() for update;
  if s.user_id is null or not s.auto_renew or coalesce(s.pay_method, '') in ('gift', 'promo', 'stars') or s.pro_until is null or s.pro_until > now() then return s; end if;
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
