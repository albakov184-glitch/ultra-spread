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

-- Функция тест-панели demo_set_sub (только для владельца) создаётся в 03-admin.sql

-- Функции подписки — только для вошедших пользователей
revoke execute on function public.demo_activate_pro(text, text) from public, anon;
revoke execute on function public.set_auto_renew(boolean) from public, anon;
revoke execute on function public.demo_reset_pro() from public, anon;
