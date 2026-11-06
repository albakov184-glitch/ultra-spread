-- P2Pro, шаг 30: статистика кнопок меню бота (Курс USDT, Мой день, Мой месяц, Мой PRO, Полезное).
-- Считаем и нажатия, и сколько разных людей нажали. Хранится только «кто (Telegram id), какую кнопку, сколько раз за день».
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

create table if not exists public.bot_clicks (
  day     date   not null,
  action  text   not null check (action ~ '^[a-z_]{2,20}$'),
  tg_id   bigint not null,
  cnt     int    not null default 1,
  primary key (day, action, tg_id)
);
create index if not exists bot_clicks_action on public.bot_clicks (action, day);

-- Только сервер (бот и админка): приложение и посторонние таблицу не видят
alter table public.bot_clicks enable row level security;
revoke all on public.bot_clicks from public, anon, authenticated;

-- +1 нажатие одним запросом (без потерь, даже если люди жмут одновременно)
create or replace function public.bot_click(p_action text, p_tg bigint) returns void
language sql security definer set search_path = public as $$
  insert into public.bot_clicks (day, action, tg_id) values ((now() at time zone 'Europe/Moscow')::date, p_action, p_tg)
  on conflict (day, action, tg_id) do update set cnt = least(public.bot_clicks.cnt + 1, 100000);
$$;
revoke execute on function public.bot_click(text, bigint) from public, anon, authenticated;
