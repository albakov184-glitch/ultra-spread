-- P2Pro, шаг 24: итоговая защита. Закрепляет безопасные версии старых функций — на случай, если какой-то
-- старый шаг когда-то запускали повторно или не по порядку. Ничего не удаляет из данных.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- 1. Демо-покупка PRO без оплаты — удалить совсем
drop function if exists public.demo_activate_pro(text, text);
drop function if exists public.demo_activate_pro(text);

-- 2. «Автопродление» ничего не продлевает: PRO даёт только сервер после настоящей оплаты
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

-- 3. Тест-панель подписки — только владелец
create or replace function public.demo_reset_pro() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.subscriptions set pro_until = null, updated_at = now() where user_id = auth.uid();
end $$;
revoke execute on function public.demo_reset_pro() from public, anon;

-- 4. Функции, которые выдают PRO или деньги, — только сервер (ключ service_role)
revoke execute on function public.admin_gift_pro(uuid, int) from public, anon, authenticated;
revoke execute on function public.stars_grant_pro(uuid, text, text, int, bigint) from public, anon, authenticated;
revoke execute on function public.stars_refund(text) from public, anon, authenticated;
revoke execute on function public.crypto_grant_pro(text, text, text) from public, anon, authenticated;
revoke execute on function public.pay_chargeback(text) from public, anon, authenticated;

-- 5. Подписку пользователь может только читать — менять её напрямую нельзя
revoke insert, update, delete on public.subscriptions from anon, authenticated;
