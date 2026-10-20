-- P2Pro, шаг 16: график курса USDT, уведомления о курсе и подарок PRO другу.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Курс USDT в рублях (биржа xRocket). Бот записывает раз в 10 минут, хранит неделю. Читать может любой — это открытые данные
create table if not exists public.rate_history (
  ts timestamptz primary key default now(),
  usdt numeric(12, 4) not null check (usdt > 0)
);
alter table public.rate_history enable row level security;
revoke all on public.rate_history from public, anon, authenticated;
grant select on public.rate_history to anon, authenticated;
drop policy if exists "read rates" on public.rate_history;
create policy "read rates" on public.rate_history for select using (true);

-- Уведомления о курсе (PRO): «напиши, когда USDT выше / ниже цены». Срабатывает один раз (fired_at), не больше 5 активных
create table if not exists public.rate_alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  dir text not null check (dir in ('above', 'below')),
  price numeric(12, 4) not null check (price > 0 and price < 10000),
  created_at timestamptz not null default now(),
  fired_at timestamptz
);
alter table public.rate_alerts enable row level security;
revoke all on public.rate_alerts from public, anon, authenticated;
grant select, insert, delete on public.rate_alerts to authenticated;
create index if not exists rate_alerts_active on public.rate_alerts (fired_at) where fired_at is null;
drop policy if exists "own alerts read" on public.rate_alerts;
create policy "own alerts read" on public.rate_alerts for select using (auth.uid() = user_id);
drop policy if exists "own alerts delete" on public.rate_alerts;
create policy "own alerts delete" on public.rate_alerts for delete using (auth.uid() = user_id);
drop policy if exists "own alerts add" on public.rate_alerts;
create policy "own alerts add" on public.rate_alerts for insert with check (
  auth.uid() = user_id and fired_at is null
  and (select count(*) from public.rate_alerts a where a.user_id = auth.uid() and a.fired_at is null) < 5);

-- Подарок PRO другу криптой: счёт оплачивает gift_from, PRO получает user_id
alter table public.crypto_invoices add column if not exists gift_from uuid references auth.users (id) on delete set null;

create or replace function public.crypto_grant_pro(p_invoice text, p_amount text, p_currency text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv public.crypto_invoices; s public.subscriptions; d int; active boolean;
begin
  update public.crypto_invoices set status = 'paid', paid_at = now(), paid_amount = p_amount, paid_currency = p_currency
    where id = p_invoice and status <> 'paid' returning * into inv;
  if inv.id is null then return jsonb_build_object('fresh', false); end if;   -- уже учтён или нет такого счёта
  if inv.user_id is null then return jsonb_build_object('fresh', true, 'user_id', null, 'gift_from', inv.gift_from); end if;   -- аккаунт успели удалить
  d := case when inv.period = 'y' then 365 else 30 end;
  insert into public.subscriptions (user_id) values (inv.user_id) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = inv.user_id for update;
  active := s.pro_until is not null and s.pro_until > now();
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => d),
    pro_since = case when active then pro_since else now() end,
    auto_renew = false, pay_method = 'crypto', period = inv.period,
    payments = jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('ts', now(), 'amount', inv.price_rub, 'period', inv.period, 'method', 'crypto',
      'paid', coalesce(p_amount, '') || ' ' || coalesce(p_currency, ''), 'invoice', inv.id, 'gift_from', inv.gift_from))) || payments
  where user_id = inv.user_id returning * into s;
  return jsonb_build_object('fresh', true, 'user_id', inv.user_id, 'gift_from', inv.gift_from, 'period', inv.period, 'price_rub', inv.price_rub, 'pro_until', s.pro_until);
end $$;
revoke execute on function public.crypto_grant_pro(text, text, text) from public, anon, authenticated;
grant execute on function public.crypto_grant_pro(text, text, text) to service_role;
