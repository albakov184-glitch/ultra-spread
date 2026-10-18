// P2Pro — вход через Telegram в мини-аппе.
// Мини-апп присылает initData — данные пользователя, подписанные Telegram токеном бота. Проверяем подпись,
// находим или создаём аккаунт этого пользователя Telegram и выдаём приложению обычную сессию Supabase.
// Токен бота — в Supabase → Edge Functions → Secrets (TELEGRAM_BOT_TOKEN), ключи Supabase функция получает сама.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || SERVICE;
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
async function userFor(tg: TgUser, retry = true): Promise<{ id: string; email?: string }> {
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!TOKEN || !SB_URL || !SERVICE) return json({ error: 'server' }, 500);
  const body = await req.json().catch(() => null);
  const initData = typeof body?.initData === 'string' ? body.initData.slice(0, 8192) : '';
  const tg = initData ? await checkInit(initData) : null;
  if (tg === 'old') return json({ error: 'old' }, 401);
  if (!tg) return json({ error: 'bad' }, 401);
  try {
    const user = await userFor(tg);
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
