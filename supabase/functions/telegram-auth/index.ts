// P2Pro — вход через Telegram в мини-аппе.
// Мини-апп присылает initData — данные пользователя, подписанные Telegram токеном бота. Проверяем подпись,
// находим или создаём аккаунт этого пользователя Telegram и выдаём приложению обычную сессию Supabase.
// Токен бота — в Supabase → Edge Functions → Secrets (TELEGRAM_BOT_TOKEN), ключи Supabase функция получает сама.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || SERVICE;
const CHANNEL = '@P2ProChannel';   // обязательная подписка. Бот должен быть админом канала, иначе Telegram не скажет, кто подписан
const MAX_AGE = 24 * 3600;   // initData старше суток не принимаем — пусть перезапустит мини-апп

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

// Проверка по документации Telegram: все поля, кроме hash, по алфавиту через \n, подпись HMAC-SHA256
// ключом HMAC-SHA256("WebAppData", токен бота)
async function checkInit(initData: string): Promise<TgUser | 'old' | null> {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), TOKEN);
  if (!same(hex(await hmac(secret, dcs)), hash.toLowerCase())) return null;
  const at = Number(p.get('auth_date'));
  if (!at || Date.now() / 1000 - at > MAX_AGE) return 'old';
  let user: TgUser | null = null; try { user = JSON.parse(p.get('user') ?? 'null'); } catch (_) { /* битые данные */ }
  return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
}

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// Аккаунт ищем только по таблице tg_users, а не по почте: так никто не сможет заранее зарегистрировать
// «чужую» почту по форме и попасть в аккаунт человека, который потом войдёт через Telegram
async function userFor(tg: TgUser, retry = true): Promise<{ id: string; email?: string; user_metadata?: Record<string, unknown> }> {
  const { data: row, error } = await admin.from('tg_users').select('user_id').eq('tg_id', tg.id).maybeSingle();
  if (error) throw error;
  if (row) {
    const { data, error: e } = await admin.auth.admin.getUserById(row.user_id);
    if (e || !data.user) throw e ?? new Error('user missing');
    return data.user;
  }
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim().slice(0, 32) || tg.username || 'Telegram';
  // Служебный адрес: домен .invalid не существует, письма на него уйти не могут. Случайная часть — чтобы адрес нельзя было угадать
  const email = `tg${tg.id}-${crypto.randomUUID().slice(0, 8)}@telegram.invalid`;
  const { data: c, error: ce } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name, tg_username: tg.username ?? '' }, app_metadata: { tg_id: tg.id } });
  if (ce || !c.user) throw ce ?? new Error('create failed');
  const { error: ie } = await admin.from('tg_users').insert({ tg_id: tg.id, user_id: c.user.id });
  if (ie) {
    // Два входа одновременно: другой успел первым — убираем лишний аккаунт и берём его
    await admin.auth.admin.deleteUser(c.user.id).catch(() => {});
    if (ie.code === '23505' && retry) return userFor(tg, false);
    throw ie;
  }
  return c.user;
}

// Фото профиля Telegram для аватарки. В данных мини-аппа ссылки на фото чаще всего нет, поэтому берём его
// через бота и кладём копию в публичное хранилище avatars (ссылка на сам файл Telegram содержит токен бота — отдавать её нельзя).
// Обновляем не чаще раза в сутки; если не вышло — вход всё равно проходит
async function savePhoto(tg: TgUser, user: { id: string; user_metadata?: Record<string, unknown> }) {
  const meta = user.user_metadata ?? {};
  if (Date.now() - Number(meta.avatar_at || 0) < 864e5 && meta.tg_username === (tg.username ?? '')) return;
  const api = (m: string) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  let avatar = String(meta.avatar || '');
  try {
    const ph = await api(`getUserProfilePhotos?user_id=${tg.id}&limit=1`);
    const sizes: { file_id: string; file_unique_id: string; width: number }[] = ph?.result?.photos?.[0] ?? [];
    const pick = sizes.find((x) => x.width >= 160) ?? sizes[sizes.length - 1];
    if (ph?.ok && !pick) avatar = '';   // фото убрали или скрыли
    if (pick) {
      const f = await api(`getFile?file_id=${encodeURIComponent(pick.file_id)}`);
      const img = f?.result?.file_path && await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`, { signal: AbortSignal.timeout(5000) });
      if (img?.ok) {
        const path = `${user.id}.jpg`;
        const { error } = await admin.storage.from('avatars').upload(path, new Uint8Array(await img.arrayBuffer()), { contentType: 'image/jpeg', upsert: true });
        if (!error) avatar = admin.storage.from('avatars').getPublicUrl(path).data.publicUrl + '?v=' + pick.file_unique_id;
      }
    }
  } catch (e) { console.error('telegram-auth photo', e); }   // сбой Telegram: оставляем прежнее фото, но отметку времени ставим — иначе каждый вход ждал бы таймауты
  await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...meta, avatar, avatar_at: Date.now(), tg_username: tg.username ?? '' } });
}

// true — подписан, false — нет, null — проверить не удалось (сбой Telegram, бот не админ): тогда пускаем, чтобы не закрыть вход всем
async function subscribed(id: number): Promise<boolean | null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL)}&user_id=${id}`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json());
    if (!r?.ok) return null;
    const m = r.result;
    return ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && !!m.is_member);
  } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!TOKEN || !SB_URL || !SERVICE) return json({ error: 'server' }, 500);
  const body = await req.json().catch(() => null);
  const initData = typeof body?.initData === 'string' ? body.initData.slice(0, 8192) : '';
  const tg = initData ? await checkInit(initData) : null;
  if (tg === 'old') return json({ error: 'old' }, 401);
  if (!tg) return json({ error: 'bad' }, 401);
  if (await subscribed(tg.id) === false) return json({ error: 'sub' }, 403);
  // Мини-апп при каждом открытии спрашивает только «подписан ли», без входа
  if (body?.check) return json({ ok: true });
  try {
    const user = await userFor(tg);
    await savePhoto(tg, user).catch((e) => console.error('telegram-auth photo', e));
    // Сессию выдаём через одноразовую ссылку входа: создаём её ключом сервера и сразу же подтверждаем. Письмо не отправляется
    const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email! });
    if (le) throw le;
    const pub = createClient(SB_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    if (error || !data.session) throw error ?? new Error('no session');
    return json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch (e) {
    console.error('telegram-auth', e);
    return json({ error: 'server' }, 500);
  }
});
