-- P2Pro, шаг 21: партнёрские ссылки. Партнёр получает ссылку https://t.me/P2ProAppBot?start=p_КОД,
-- бот запоминает, кто по ней пришёл, а админка считает выручку с этих людей и долю партнёра (выплаты — вручную).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Партнёры: код ссылки, имя, процент с оплат
create table if not exists public.partners (
  code text primary key check (code ~ '^[a-z0-9_]{2,24}$'),
  name text not null default '',
  pct numeric(5,2) not null default 15 check (pct >= 0 and pct <= 90),
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Кто по чьей ссылке пришёл. Один человек — один партнёр: считается первая ссылка
create table if not exists public.partner_refs (
  tg_id bigint primary key,
  code text not null references public.partners (code) on delete cascade on update cascade,
  name text not null default '',   -- ник или имя из Telegram на момент перехода: видно, кто пришёл, даже если ещё не открыл приложение
  at timestamptz not null default now()
);
create index if not exists partner_refs_code on public.partner_refs (code);

-- Выплаты партнёру — отмечаются вручную в админке
create table if not exists public.partner_payouts (
  id bigserial primary key,
  code text not null references public.partners (code) on delete cascade on update cascade,
  amount numeric(12,2) not null check (amount > 0),
  cur text not null default 'rub' check (cur in ('rub', 'stars')),
  note text not null default '',
  at timestamptz not null default now()
);
create index if not exists partner_payouts_code on public.partner_payouts (code);

-- Доступ только у сервера (бот и админка): приложение эти таблицы не видит
alter table public.partners enable row level security;
alter table public.partner_refs enable row level security;
alter table public.partner_payouts enable row level security;
revoke all on public.partners, public.partner_refs, public.partner_payouts from public, anon, authenticated;
