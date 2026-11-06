-- P2Pro, шаг 29: история курса USDT во всех валютах (тенге, гривна, белорусский рубль, евро), а не только в рублях.
-- Раньше график для других валют был рублёвым графиком, пересчитанным по текущему курсу, — форма у всех была одинаковая.
-- Теперь бот раз в 10 минут записывает курс каждой валюты, и у каждой свой настоящий график (наберётся за сутки).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

alter table public.rate_history add column if not exists fx jsonb;
alter table public.rate_history drop constraint if exists rate_history_fx_check;
alter table public.rate_history add constraint rate_history_fx_check check (fx is null or jsonb_typeof(fx) = 'object');
