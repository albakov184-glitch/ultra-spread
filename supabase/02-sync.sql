-- P2Pro, шаг 2: время изменений ставит сервер (для синхронизации между устройствами) и тест-панель подписки.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- updated_at всегда ставит сервер: часы на телефонах могут врать, а по этому времени устройства забирают свежие изменения
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists touch on public.profiles;
create trigger touch before insert or update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists touch on public.trades;
create trigger touch before insert or update on public.trades for each row execute function public.touch_updated_at();
drop trigger if exists touch on public.counterparties;
create trigger touch before insert or update on public.counterparties for each row execute function public.touch_updated_at();
drop trigger if exists touch on public.subscriptions;
create trigger touch before insert or update on public.subscriptions for each row execute function public.touch_updated_at();
create index if not exists trades_user_upd on public.trades (user_id, updated_at);
create index if not exists cps_user_upd on public.counterparties (user_id, updated_at);

-- ДЕМО для тест-панели: поставить любой срок PRO. p_until = null — тариф Free. Перед запуском оплаты удалить:
-- drop function public.demo_set_sub(text, timestamptz, boolean, boolean);
create or replace function public.demo_set_sub(p_period text, p_until timestamptz, p_auto boolean, p_clear boolean default false)
returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.subscriptions (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  update public.subscriptions set
    period = case when p_period = 'y' then 'y' else 'm' end,
    pro_since = case when p_until is null then null else coalesce(pro_since, now()) end,
    pro_until = p_until,
    auto_renew = p_auto,
    payments = case when p_clear then '[]'::jsonb else payments end
  where user_id = auth.uid() returning * into s;
  return s;
end $$;

-- Функции подписки — только для вошедших пользователей
revoke execute on function public.demo_activate_pro(text, text) from public, anon;
revoke execute on function public.set_auto_renew(boolean) from public, anon;
revoke execute on function public.demo_reset_pro() from public, anon;
revoke execute on function public.demo_set_sub(text, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.demo_set_sub(text, timestamptz, boolean, boolean) to authenticated;
