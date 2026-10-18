-- P2Pro, шаг 6: вход через Telegram.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Какой аккаунт P2Pro принадлежит какому пользователю Telegram. Пишет и читает только функция telegram-auth
-- (ключом сервера): у приложения доступа к таблице нет. При удалении аккаунта строка удаляется сама
create table if not exists public.tg_users (
  tg_id bigint primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.tg_users enable row level security;
revoke all on public.tg_users from public, anon, authenticated;
