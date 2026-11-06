-- P2Pro, шаг 26: промокоды со скидкой. Код может давать дни PRO, постоянную скидку на PRO (в процентах) или и то и другое.
-- Скидка записывается человеку как персональная цена и действует на все способы оплаты (звёзды, рубли, крипта) навсегда.
-- Если у человека уже есть цена ниже — она остаётся (берём меньшую).
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.

alter table public.promo_codes add column if not exists pct int not null default 0;
alter table public.promo_codes drop constraint if exists promo_codes_pct_check;
alter table public.promo_codes add constraint promo_codes_pct_check check (pct between 0 and 90);
-- Раньше дней было минимум 1. Теперь 0 можно, если код даёт скидку
alter table public.promo_codes drop constraint if exists promo_codes_days_check;
alter table public.promo_codes add constraint promo_codes_days_check check (days between 0 and 3650 and (days > 0 or pct > 0));

drop function if exists public.redeem_promo(text);
create function public.redeem_promo(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pc public.promo_codes; s public.subscriptions; active boolean; free boolean; c text := upper(trim(coalesce(p_code, ''))); uid uuid := auth.uid(); err text;
  k numeric;
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

  -- Скидка: от обычных цен (350 / 2650 ⭐, 490 / 3990 ₽ — такие же в приложении и функциях бота)
  if pc.pct > 0 then
    k := (100 - pc.pct) / 100.0;
    insert into public.custom_prices as cp (user_id, m, y, rm, ry, updated_at)
    values (uid, round(350 * k), round(2650 * k), round(490 * k), round(3990 * k), now())
    on conflict (user_id) do update set
      m = least(cp.m, excluded.m), y = least(cp.y, excluded.y),
      rm = least(coalesce(cp.rm, 490), excluded.rm), ry = least(coalesce(cp.ry, 3990), excluded.ry), updated_at = now();
  end if;

  select * into s from public.subscriptions where user_id = uid for update;
  if pc.days > 0 then
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
  end if;
  return jsonb_build_object('sub', to_jsonb(s), 'days', pc.days, 'pct', pc.pct);
end $$;
revoke execute on function public.redeem_promo(text) from public, anon;
grant execute on function public.redeem_promo(text) to authenticated;
