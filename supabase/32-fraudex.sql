-- P2Pro, шаг 32: жалобы с данными биржи — для общей базы Fraudex.
-- В жалобе теперь можно указать биржу, UID и маску профиля, а также карту или телефон мошенника.
-- Одобренная жалоба с полными данными уходит и в базу Fraudex; снятая — удаляется оттуда.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

alter table public.bl_reports add column if not exists exchange text not null default '';   -- bybit, htx, bitget… (пусто — не указана)
alter table public.bl_reports add column if not exists uid text not null default '';        -- числовой UID (Bybit, HTX)
alter table public.bl_reports add column if not exists mask text not null default '';       -- маска / ID профиля на бирже
alter table public.bl_reports add column if not exists req text not null default '';        -- карта или телефон мошенника
alter table public.bl_reports add column if not exists fdx text not null default '';        -- отправка в Fraudex: '' — нет, sent — отправлено, err:… — ошибка

alter table public.bl_reports drop constraint if exists bl_reports_ids_len;
alter table public.bl_reports add constraint bl_reports_ids_len
  check (char_length(exchange) <= 20 and char_length(uid) <= 19 and char_length(mask) <= 128 and char_length(req) <= 24 and char_length(fdx) <= 300);
