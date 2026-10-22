-- P2Pro, шаг 17: пробный PRO на 7 дней — один раз на человека.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- Кто уже брал пробный период. Без связи с аккаунтом: если удалить аккаунт и зарегистрироваться заново
-- с тем же Telegram или почтой, второй раз пробный не дадут
create table if not exists public.pro_trials (
  user_id uuid primary key,
  tg_id bigint,
  email text,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_sent boolean not null default false   -- бот уже написал «пробный период закончился»
);
alter table public.pro_trials enable row level security;
revoke all on public.pro_trials from public, anon, authenticated;
create index if not exists pro_trials_tg on public.pro_trials (tg_id);
create index if not exists pro_trials_email on public.pro_trials (lower(email));
create index if not exists pro_trials_open on public.pro_trials (ends_at) where not ended_sent;

-- Включить пробный период. Только если человек ещё ни разу не был в PRO и не брал пробный
create or replace function public.start_trial() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s public.subscriptions; tg bigint; em text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select t.tg_id into tg from public.tg_users t where t.user_id = uid;
  select u.email into em from auth.users u where u.id = uid;
  if exists (select 1 from public.pro_trials p where p.user_id = uid or (tg is not null and p.tg_id = tg)
      or (em is not null and lower(p.email) = lower(em))) then raise exception 'trial_used'; end if;
  insert into public.subscriptions (user_id) values (uid) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = uid for update;
  if s.pro_until is not null or jsonb_array_length(s.payments) > 0 then raise exception 'trial_used'; end if;   -- уже был PRO
  update public.subscriptions set
    pro_since = now(), pro_until = now() + interval '7 days', auto_renew = false, pay_method = 'trial', period = 'm', reminded_for = null,
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', 0, 'days', 7, 'period', 'm', 'method', 'trial')) || payments,
    updated_at = now()
  where user_id = uid returning * into s;
  insert into public.pro_trials (user_id, tg_id, email, ends_at) values (uid, tg, em, s.pro_until);
  return s;
end $$;
revoke execute on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;
