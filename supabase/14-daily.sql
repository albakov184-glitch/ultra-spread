-- P2Pro, шаг 14: итоги дня в боте — каждый день в 23:59 (МСК) бот присылает текст и карточку дня
-- тем, у кого за день были сделки. На Free карточка с водяным знаком, в PRO — без.
-- Перед запуском замените ВАШ_СЕКРЕТ на значение TELEGRAM_WEBHOOK_SECRET (как в 09-cron.sql).
-- Этот файл с секретом никому не отправляйте и в GitHub не сохраняйте.
-- Запуск: Supabase → SQL Editor → вставить → заменить ВАШ_СЕКРЕТ → Run. Повторный запуск безопасен.

-- Человек может отключить итоги кнопкой «🔕 Не присылать итоги» под сообщением
alter table public.tg_users add column if not exists daily_off boolean not null default false;

-- 23:59 по Москве = 20:59 по UTC
select cron.unschedule(jobid) from cron.job where jobname = 'p2pro-daily';
select cron.schedule('p2pro-daily', '59 20 * * *', $job$
  select net.http_post(
    url := 'https://liddntvlxlupwfhpuwnp.supabase.co/functions/v1/telegram-bot',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-telegram-bot-api-secret-token', 'ВАШ_СЕКРЕТ'),
    body := '{"cron":"daily"}'::jsonb
  )
$job$);
