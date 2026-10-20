-- P2Pro, шаг 9: расписание для бота. Каждые 10 минут Supabase будит бота, и он сам:
--   • присылает владельцу уведомления о новых пользователях и оплатах;
--   • раз в день (после 12:00 МСК) напоминает «PRO закончится через 3 дня»;
--   • раз в неделю публикует пост в канал, если автопосты включены в админке.
-- Перед запуском замените ВАШ_СЕКРЕТ на значение TELEGRAM_WEBHOOK_SECRET (тот же, что в ссылке setWebhook).
-- Этот файл с секретом никому не отправляйте и в GitHub не сохраняйте.
-- Запуск: Supabase → SQL Editor → вставить → заменить ВАШ_СЕКРЕТ → Run. Повторный запуск безопасен.

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'p2pro-bot-tick';
select cron.schedule('p2pro-bot-tick', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://liddntvlxlupwfhpuwnp.supabase.co/functions/v1/telegram-bot',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-telegram-bot-api-secret-token', 'ВАШ_СЕКРЕТ'),
    body := '{"cron":"tick"}'::jsonb
  )
$job$);
