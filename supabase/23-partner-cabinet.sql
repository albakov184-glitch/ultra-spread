-- P2Pro, шаг 23: кабинет партнёра в боте. Владелец выдаёт партнёру одноразовую ссылку из админки,
-- партнёр нажимает «Старт» — его Telegram привязывается к партнёрке, и в боте появляется /partner со статистикой.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

alter table public.partners add column if not exists tg_id bigint;              -- Telegram партнёра (кабинет в боте)
alter table public.partners add column if not exists tg_name text not null default '';   -- его ник или имя — для админки
create unique index if not exists partners_tg on public.partners (tg_id) where tg_id is not null;   -- один Telegram — одна партнёрка
