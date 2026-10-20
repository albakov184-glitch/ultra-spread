-- P2Pro, шаг 15: оплата PRO криптовалютой через xRocket Pay (на сайте) и персональная цена в рублях.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Персональная цена в рублях (для оплаты на сайте). Пусто — обычная (490 ₽ / 3 990 ₽)
alter table public.custom_prices add column if not exists rm int check (rm is null or rm between 1 and 1000000);
alter table public.custom_prices add column if not exists ry int check (ry is null or ry between 1 and 10000000);

-- Счета xRocket. id — наш номер счёта (clientInvoiceId), по нему одна оплата даёт PRO ровно один раз.
-- Пишут только функции (ключ сервера). При удалении аккаунта счёт остаётся без привязки — для истории оплат
create table if not exists public.crypto_invoices (
  id text primary key check (id ~ '^p2p_[a-f0-9]{32}$'),
  xr_id text,
  user_id uuid references auth.users (id) on delete set null,
  period text not null check (period in ('m', 'y')),
  price_rub int not null check (price_rub > 0),
  status text not null default 'active',
  paid_amount text,
  paid_currency text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
alter table public.crypto_invoices enable row level security;
revoke all on public.crypto_invoices from public, anon, authenticated;
create index if not exists crypto_invoices_user on public.crypto_invoices (user_id);

-- Счёт оплачен: выдаём PRO (месяц — 30 дней, год — 365) к текущему сроку. Повторное уведомление ничего не меняет
create or replace function public.crypto_grant_pro(p_invoice text, p_amount text, p_currency text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv public.crypto_invoices; s public.subscriptions; d int; active boolean;
begin
  update public.crypto_invoices set status = 'paid', paid_at = now(), paid_amount = p_amount, paid_currency = p_currency
    where id = p_invoice and status <> 'paid' returning * into inv;
  if inv.id is null then return jsonb_build_object('fresh', false); end if;   -- уже учтён или нет такого счёта
  if inv.user_id is null then return jsonb_build_object('fresh', true, 'user_id', null); end if;   -- аккаунт успели удалить
  d := case when inv.period = 'y' then 365 else 30 end;
  insert into public.subscriptions (user_id) values (inv.user_id) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = inv.user_id for update;
  active := s.pro_until is not null and s.pro_until > now();
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => d),
    pro_since = case when active then pro_since else now() end,
    auto_renew = false, pay_method = 'crypto', period = inv.period,
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', inv.price_rub, 'period', inv.period, 'method', 'crypto',
      'paid', coalesce(p_amount, '') || ' ' || coalesce(p_currency, ''), 'invoice', inv.id)) || payments
  where user_id = inv.user_id returning * into s;
  return jsonb_build_object('fresh', true, 'user_id', inv.user_id, 'period', inv.period, 'price_rub', inv.price_rub, 'pro_until', s.pro_until);
end $$;
revoke execute on function public.crypto_grant_pro(text, text, text) from public, anon, authenticated;
grant execute on function public.crypto_grant_pro(text, text, text) to service_role;
