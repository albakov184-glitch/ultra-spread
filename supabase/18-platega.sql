-- P2Pro, шаг 18: оплата PRO через Platega (СБП). Счета живут в той же таблице, что и крипта (crypto_invoices).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Кто принимает оплату: xrocket (крипта) или platega (СБП). pl_id — номер транзакции в Platega
alter table public.crypto_invoices add column if not exists provider text not null default 'xrocket';
alter table public.crypto_invoices add column if not exists pl_id text;
create unique index if not exists crypto_invoices_pl on public.crypto_invoices (pl_id) where pl_id is not null;

-- Счёт оплачен: выдаём PRO к текущему сроку. Способ оплаты в подписке — по тому, кто принял платёж
create or replace function public.crypto_grant_pro(p_invoice text, p_amount text, p_currency text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv public.crypto_invoices; s public.subscriptions; d int; active boolean; m text;
begin
  update public.crypto_invoices set status = 'paid', paid_at = now(), paid_amount = p_amount, paid_currency = p_currency
    where id = p_invoice and status not in ('paid', 'chargeback') returning * into inv;
  if inv.id is null then return jsonb_build_object('fresh', false); end if;   -- уже учтён или нет такого счёта
  if inv.user_id is null then return jsonb_build_object('fresh', true, 'user_id', null, 'gift_from', inv.gift_from); end if;   -- аккаунт успели удалить
  d := case when inv.period = 'y' then 365 else 30 end;
  m := case when inv.provider = 'platega' then 'sbp' else 'crypto' end;
  insert into public.subscriptions (user_id) values (inv.user_id) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = inv.user_id for update;
  active := s.pro_until is not null and s.pro_until > now();
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => d),
    pro_since = case when active then pro_since else now() end,
    auto_renew = false, pay_method = m, period = inv.period,
    payments = jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('ts', now(), 'amount', inv.price_rub, 'period', inv.period, 'method', m,
      'paid', coalesce(p_amount, '') || ' ' || coalesce(p_currency, ''), 'invoice', inv.id, 'gift_from', inv.gift_from))) || payments
  where user_id = inv.user_id returning * into s;
  return jsonb_build_object('fresh', true, 'user_id', inv.user_id, 'gift_from', inv.gift_from, 'period', inv.period, 'price_rub', inv.price_rub,
    'pro_until', s.pro_until, 'method', m);
end $$;
revoke execute on function public.crypto_grant_pro(text, text, text) from public, anon, authenticated;
grant execute on function public.crypto_grant_pro(text, text, text) to service_role;

-- Деньги вернули через банк (чарджбек): забираем оплаченные дни и пишем возврат в историю. Повтор ничего не меняет
create or replace function public.pay_chargeback(p_invoice text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare inv public.crypto_invoices; s public.subscriptions; d int;
begin
  update public.crypto_invoices set status = 'chargeback' where id = p_invoice and status = 'paid' returning * into inv;
  if inv.id is null then return jsonb_build_object('fresh', false); end if;
  if inv.user_id is null then return jsonb_build_object('fresh', true, 'user_id', null); end if;
  d := case when inv.period = 'y' then 365 else 30 end;
  update public.subscriptions set
    pro_until = pro_until - make_interval(days => d),
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', -inv.price_rub, 'period', inv.period,
      'method', case when inv.provider = 'platega' then 'sbp' else 'crypto' end, 'refund', true, 'invoice', inv.id)) || payments
  where user_id = inv.user_id returning * into s;
  return jsonb_build_object('fresh', true, 'user_id', inv.user_id, 'price_rub', inv.price_rub, 'pro_until', s.pro_until);
end $$;
revoke execute on function public.pay_chargeback(text) from public, anon, authenticated;
grant execute on function public.pay_chargeback(text) to service_role;
