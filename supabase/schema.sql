-- P2Pro: база в Supabase.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.
-- Каждый пользователь видит и меняет только свои данные (Row Level Security).

-- Профиль: имя и настройки приложения (цель, капитал, биржи, банки, комиссии, тема)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Сделки: вся сделка хранится в data (как в приложении), ts — для сортировки и выборок
create table if not exists public.trades (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  ts timestamptz not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists trades_user_ts on public.trades (user_id, ts desc);

-- Контрагенты: ключ — ник в нижнем регистре
create table if not exists public.counterparties (
  user_id uuid not null references auth.users (id) on delete cascade,
  name_key text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, name_key)
);

-- Подписка: читать может владелец, менять — только сервер (функции ниже или будущая оплата)
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  period text not null default 'm' check (period in ('m', 'y')),
  pro_since timestamptz,
  pro_until timestamptz,
  auto_renew boolean not null default true,
  pay_method text,
  payments jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Защита строк: только свои данные
alter table public.profiles enable row level security;
alter table public.trades enable row level security;
alter table public.counterparties enable row level security;
alter table public.subscriptions enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "own trades" on public.trades;
create policy "own trades" on public.trades for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own counterparties" on public.counterparties;
create policy "own counterparties" on public.counterparties for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select using (auth.uid() = user_id);

-- Новый пользователь: сразу создаём профиль с именем из регистрации
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name) values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Демо-оплата из первых версий удалена: PRO выдаёт только сервер после настоящей оплаты (13-security.sql)

-- Включить/выключить автопродление и отменить подписку может сам пользователь
create or replace function public.set_auto_renew(p_on boolean) returns void
language sql security definer set search_path = public as $$
  update public.subscriptions set auto_renew = p_on, updated_at = now() where user_id = auth.uid();
$$;

-- ДЕМО: вернуть тариф Free (для тест-панели). Перед запуском удалить вместе с demo_activate_pro.
create or replace function public.demo_reset_pro() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.subscriptions set pro_until = null, updated_at = now() where user_id = auth.uid();
end $$;

grant execute on function public.set_auto_renew(boolean) to authenticated;
grant execute on function public.demo_reset_pro() to authenticated;
