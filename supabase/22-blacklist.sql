-- P2Pro, шаг 22: общий чёрный список мошенников.
-- Пользователи PRO жалуются на ник со скрином, владелец проверяет жалобу в боте или админке.
-- Одобренные жалобы — это и есть общая база: её видят все пользователи PRO (без имени того, кто пожаловался).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

create table if not exists public.bl_reports (
  id bigserial primary key,
  nick text not null check (char_length(nick) between 2 and 40),   -- ник в нижнем регистре, без @ — по нему ищем
  shown text not null default '',                                   -- ник, как его написали (для показа)
  kind text not null default 'other' check (kind in ('nopay', 'cancel', 'fake', 'third', 'rude', 'other')),
  kind_text text not null default '',                               -- свой тип нарушения («Другое»)
  note text not null default '',
  proofs text[] not null default '{}',                              -- скрины в закрытом хранилище bl-proofs
  reporter uuid references auth.users (id) on delete set null,      -- пусто — добавил владелец вручную
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'removed')),
  reason text not null default '',                                  -- причина отказа — её видит автор
  reward text not null default '',                                  -- награда автору: d3, d7, d30, p20, p50, no
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists bl_reports_nick on public.bl_reports (nick, status);
create index if not exists bl_reports_status on public.bl_reports (status, created_at desc);
create index if not exists bl_reports_reporter on public.bl_reports (reporter, created_at desc);

-- Доступ только у сервера (бот): приложение читает базу через него, и только для PRO
alter table public.bl_reports enable row level security;
revoke all on public.bl_reports from public, anon, authenticated;

-- Скрины доказательств: закрытое хранилище, до 2 МБ на файл, только картинки. Пишет и читает только сервер
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bl-proofs', 'bl-proofs', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
