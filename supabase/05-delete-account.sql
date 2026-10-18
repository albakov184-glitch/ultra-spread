-- P2Pro, шаг 5: пользователь может сам удалить аккаунт (Профиль → «Удалить аккаунт»).
-- Удаляется пользователь, а вместе с ним по каскаду — профиль, сделки, контрагенты и подписка.
-- Запуск: Supabase → SQL Editor → вставить весь файл → Run. Повторный запуск безопасен.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
