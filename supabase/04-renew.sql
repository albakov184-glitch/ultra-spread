-- P2Pro, шаг 4: безопасное автопродление (демо).
-- Продлевает, только если автопродление включено и срок уже истёк. Два устройства, открытые в момент окончания,
-- не продлят дважды, а отменённая на другом устройстве подписка не продлится.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.
create or replace function public.demo_renew_pro() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions; add_days int; price int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into s from public.subscriptions where user_id = auth.uid() for update;
  if s.user_id is null or not s.auto_renew or s.pay_method = 'gift' or s.pro_until is null or s.pro_until > now() then return s; end if;   -- подарок (/give в боте) не продлевается
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
