-- P2Pro, шаг 25: статистика функций для админки — какими разделами и кнопками пользуются.
-- Хранится только «кто, какой функцией, сколько раз за день». Ни сумм, ни курсов, ни сделок.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

create table if not exists public.feature_usage (
  day      date not null,
  feature  text not null,
  user_id  uuid not null references auth.users(id) on delete cascade,
  cnt      int  not null default 0,
  primary key (day, feature, user_id)
);
create index if not exists feature_usage_day on public.feature_usage (day);

-- Читает и пишет только сервер (ключ service_role); приложение — только через функцию ниже
alter table public.feature_usage enable row level security;
revoke all on public.feature_usage from public, anon, authenticated;

-- Приложение раз в минуту присылает пачку счётчиков: {"tab_stats": 3, "save_deal": 2, ...}
-- Записываем только для того, кто вошёл; названия и числа проверяем, чтобы нельзя было засорить таблицу
create or replace function public.track_usage(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; n int; i int := 0;
begin
  if auth.uid() is null or p is null or jsonb_typeof(p) <> 'object' then return; end if;
  for k, v in select * from jsonb_each(p) loop
    i := i + 1; exit when i > 40;
    continue when k !~ '^[a-z][a-z0-9_]{1,30}$' or jsonb_typeof(v) <> 'number';
    n := least(greatest(floor((v #>> '{}')::numeric)::int, 0), 500);
    continue when n = 0;
    insert into public.feature_usage (day, feature, user_id, cnt)
    values ((now() at time zone 'Europe/Moscow')::date, k, auth.uid(), n)
    on conflict (day, feature, user_id) do update set cnt = least(public.feature_usage.cnt + excluded.cnt, 100000);
  end loop;
end $$;
revoke execute on function public.track_usage(jsonb) from public, anon;
grant execute on function public.track_usage(jsonb) to authenticated;
