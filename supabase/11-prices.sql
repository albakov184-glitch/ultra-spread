-- P2Pro, шаг 11: персональная цена PRO для отдельного пользователя (задаёт владелец в админке бота).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Цена в звёздах за месяц (m) и за год (y). Нет строки — обычная цена (350 ⭐ / 2 650 ⭐)
create table if not exists public.custom_prices (
  user_id uuid primary key references auth.users (id) on delete cascade,
  m int not null check (m between 1 and 100000),
  y int not null check (y between 1 and 1000000),
  updated_at timestamptz not null default now()
);
alter table public.custom_prices enable row level security;
-- Пользователь может только посмотреть свою цену (чтобы показать её в окне оплаты). Менять — только бот
revoke all on public.custom_prices from public, anon, authenticated;
grant select on public.custom_prices to authenticated;
drop policy if exists "read own price" on public.custom_prices;
create policy "read own price" on public.custom_prices for select using (auth.uid() = user_id);
