-- P2Pro, шаг 31: кто и откуда впервые запустил бота — для воронки и источников в админке.
-- Метка — то, что после ?start= в ссылке (channel — кнопка в канале, p_код — ссылка партнёра). Запоминаем только первый запуск.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

create table if not exists public.bot_starts (
  tg_id bigint primary key,
  src   text not null default 'direct' check (src ~ '^[A-Za-z0-9_-]{1,40}$'),
  at    timestamptz not null default now()
);
create index if not exists bot_starts_at on public.bot_starts (at);

-- Только сервер (бот и админка)
alter table public.bot_starts enable row level security;
revoke all on public.bot_starts from public, anon, authenticated;
