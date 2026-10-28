-- P2Pro, шаг 4: безопасное автопродление (демо).
-- Продлевает, только если автопродление включено и срок уже истёк. Два устройства, открытые в момент окончания,
-- не продлят дважды, а отменённая на другом устройстве подписка не продлится.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.
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
