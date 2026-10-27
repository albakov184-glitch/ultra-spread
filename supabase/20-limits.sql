-- P2Pro, шаг 20: защита от перебора промокодов, засорения базы и повторных пробных периодов.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

-- 1. Промокоды: не больше 10 неверных попыток в час на аккаунт — подобрать код перебором не получится.
-- Неверная попытка записывается, поэтому функция больше не «падает» с ошибкой, а возвращает её в ответе: {error} или {sub}
create table if not exists public.promo_fails (
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists promo_fails_user on public.promo_fails (user_id, at);
alter table public.promo_fails enable row level security;
revoke all on public.promo_fails from public, anon, authenticated;

drop function if exists public.redeem_promo(text);
create function public.redeem_promo(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pc public.promo_codes; s public.subscriptions; active boolean; free boolean; c text := upper(trim(coalesce(p_code, ''))); uid uuid := auth.uid(); err text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if (select count(*) from public.promo_fails f where f.user_id = uid and f.at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'promo_slow');
  end if;
  select * into pc from public.promo_codes where code = c for update;
  if pc.code is null or not pc.active then err := 'promo_invalid';
  elsif pc.expires_at is not null and pc.expires_at < now() then err := 'promo_expired';
  elsif pc.max_uses is not null and pc.uses >= pc.max_uses then err := 'promo_used_up';
  elsif exists (select 1 from public.promo_uses where code = c and user_id = uid) then err := 'promo_already';
  end if;
  if err is not null then
    insert into public.promo_fails (user_id) values (uid);
    delete from public.promo_fails where at < now() - interval '1 day';
    return jsonb_build_object('error', err);
  end if;
  insert into public.promo_uses (code, user_id) values (c, uid);
  update public.promo_codes set uses = uses + 1 where code = c;
  insert into public.subscriptions (user_id) values (uid) on conflict (user_id) do nothing;
  select * into s from public.subscriptions where user_id = uid for update;
  active := s.pro_until is not null and s.pro_until > now();
  free := not active or coalesce(s.pay_method, '') in ('gift', 'promo', 'trial');
  update public.subscriptions set
    pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => pc.days),
    pro_since = case when active then pro_since else now() end,
    auto_renew = case when free then false else auto_renew end,
    pay_method = case when free then 'promo' else pay_method end,
    period = case when free then 'm' else period end,
    payments = jsonb_build_array(jsonb_build_object('ts', now(), 'amount', 0, 'period', 'm', 'method', 'promo', 'days', pc.days, 'code', c)) || payments
  where user_id = uid returning * into s;
  return jsonb_build_object('sub', to_jsonb(s));
end $$;
revoke execute on function public.redeem_promo(text) from public, anon;
grant execute on function public.redeem_promo(text) to authenticated;

-- 2. Размер данных: одна сделка — не больше 20 КБ, настройки профиля — не больше 64 КБ,
-- не больше 30 000 сделок и 3 000 контрагентов на аккаунт. Обычному человеку этого хватит на годы,
-- а забить базу мусором через API уже не получится
create or replace function public.guard_size() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'profiles' then
    if pg_column_size(new.settings) > 65536 then raise exception 'too_big'; end if;
    return new;
  end if;
  if pg_column_size(new.data) > 20480 then raise exception 'too_big'; end if;
  if tg_op = 'INSERT' then
    if tg_table_name = 'trades' and (select count(*) from public.trades where user_id = new.user_id) >= 30000 then raise exception 'too_many'; end if;
    if tg_table_name = 'counterparties' and (select count(*) from public.counterparties where user_id = new.user_id) >= 3000 then raise exception 'too_many'; end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_size on public.trades;
create trigger guard_size before insert or update on public.trades for each row execute function public.guard_size();
drop trigger if exists guard_size on public.counterparties;
create trigger guard_size before insert or update on public.counterparties for each row execute function public.guard_size();
drop trigger if exists guard_size on public.profiles;
create trigger guard_size before insert or update on public.profiles for each row execute function public.guard_size();

-- 3. Пробный PRO — только для аккаунтов, открытых через Telegram. Почту можно завести сколько угодно,
-- а Telegram-аккаунт — нет: так пробные 7 дней нельзя получать снова и снова
create or replace function public.start_trial() returns public.subscriptions
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s public.subscriptions; tg bigint; em text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select t.tg_id into tg from public.tg_users t where t.user_id = uid;
  if tg is null then raise exception 'trial_tg'; end if;
  select u.email into em from auth.users u where u.id = uid;
  if exists (select 1 from public.pro_trials p where p.user_id = uid or p.tg_id = tg
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
