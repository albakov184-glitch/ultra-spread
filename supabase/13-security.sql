-- P2Pro, шаг 13: закрываем бесплатный PRO. Запустить ОБЯЗАТЕЛЬНО.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Демо-покупка из первых версий: любой вошедший мог вызвать её напрямую и получить PRO без оплаты.
-- Теперь PRO даётся только оплатой звёздами (бот), подарком/промокодом (админка) и позже — через Platega
drop function if exists public.demo_activate_pro(text, text);

-- Демо-автопродление тоже давало дни бесплатно. Оставляем функцию (её вызывает приложение, когда срок кончился),
-- но теперь она ничего не продлевает — просто возвращает подписку. Настоящее продление сделаем вместе с оплатой картой
create or replace function public.demo_renew_pro() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.subscriptions where user_id = auth.uid();
  return s;
end $$;
revoke execute on function public.demo_renew_pro() from public, anon;
grant execute on function public.demo_renew_pro() to authenticated;

-- История оплат звёздами не должна пропадать при удалении аккаунта: платёж остаётся (без привязки к аккаунту)
do $do$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.star_payments'::regclass and contype = 'f';
  if c is not null then execute format('alter table public.star_payments drop constraint %I', c); end if;
  alter table public.star_payments alter column user_id drop not null;
  alter table public.star_payments add constraint star_payments_user_fk foreign key (user_id) references auth.users (id) on delete set null;
end
$do$;
