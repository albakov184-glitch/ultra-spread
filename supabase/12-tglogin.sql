-- P2Pro, шаг 12: вход на сайт через Telegram-бота (без почты и паролей).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Запросы входа. Сайт придумывает случайный номер (id) и открывает бота; бот записывает запрос,
-- а когда человек нажимает «Войти» — его Telegram (tg). Номер живёт 5 минут и срабатывает один раз.
-- Доступ только у функций (ключ сервера)
create table if not exists public.login_requests (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  status text not null default 'new' check (status in ('new', 'ok', 'no', 'used')),
  tg jsonb,
  created_at timestamptz not null default now()
);
alter table public.login_requests enable row level security;
revoke all on public.login_requests from public, anon, authenticated;
create index if not exists login_requests_created on public.login_requests (created_at);
