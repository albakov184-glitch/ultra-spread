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
const STARS = { m: 350, y: 2650 };   // цены PRO в звёздах. Такие же — в боте (telegram-bot) и в приложении (index.html)
const RUB = { m: 490, y: 3990 };     // цены PRO в рублях (сайт). Такие же — в приложении
// xRocket Pay — оплата криптой на сайте. Ключи — в Supabase → Edge Functions → Secrets
const XR_TOKEN = Deno.env.get('XROCKET_API_TOKEN') ?? '';
const XR_SECRET = Deno.env.get('XROCKET_WEBHOOK_SECRET') ?? '';
const XR_API = 'https://pay.api.xrocket.exchange';
const SITE = 'https://albakov184-glitch.github.io/ultra-spread/';
const ADMIN_ID = 6928515440;

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

// Заблокирован ли аккаунт этого человека (блокирует владелец в админке бота). Тогда ни входа, ни приложения
async function blockedTg(id: number) {
  const { data, error } = await admin.from('tg_users').select('user_id').eq('tg_id', id).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const { data: u, error: ue } = await admin.auth.admin.getUserById(data.user_id);
  if (ue) throw ue;
  const until = u?.user?.banned_until;
  return !!until && Date.parse(until) > Date.now();
}

// Вход: находим или создаём аккаунт этого человека Telegram и выдаём приложению сессию Supabase
async function signIn(tg: TgUser) {
  try {
    const user = await userFor(tg);
    // Ник для поиска в админке бота: таблицу пишет только сервер, в отличие от данных профиля
    await admin.from('tg_users').update({ username: tg.username ?? null }).eq('tg_id', tg.id).then(() => {}, () => {});
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
}

// Вход на сайте через бота (12-tglogin.sql). Сайт придумывает случайный номер запроса и открывает бота
// по ссылке t.me/P2ProAppBot?start=login_НОМЕР. Человек жмёт в боте «Войти», а сайт всё это время спрашивает здесь:
// подтвердили ли. Номер живёт 5 минут и срабатывает один раз
const LOGIN_TTL = 5 * 60e3;
async function webLogin(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) return json({ error: 'bad' }, 400);
  const { data: row, error } = await admin.from('login_requests').select('*').eq('id', id).maybeSingle();
  if (error) { console.error('login_requests', error); return json({ error: 'server' }, 500); }
  if (!row || row.status === 'new') return json({ status: 'wait' });   // бот ещё не открыли или не нажали «Войти»
  if (row.status === 'no') return json({ status: 'no' });
  if (row.status !== 'ok' || Date.now() - Date.parse(row.created_at) > LOGIN_TTL) return json({ status: 'expired' });
  const tg = row.tg as TgUser;
  if (!tg?.id) return json({ status: 'expired' });
  // Не смогли проверить блокировку — не пускаем (сайт спросит снова через 2 секунды)
  const blocked = await blockedTg(tg.id).catch(() => null);
  if (blocked === null) return json({ status: 'wait' });
  if (blocked) return json({ error: 'blocked' }, 403);
  if (await subscribed(tg.id) === false) return json({ error: 'sub' }, 403);   // запрос остаётся: после подписки сайт спросит снова
  // Забираем подтверждение одним запросом: второй раз по тому же номеру войти нельзя
  const { data: claimed } = await admin.from('login_requests').update({ status: 'used' }).eq('id', id).eq('status', 'ok').select('id');
  if (!claimed?.length) return json({ status: 'expired' });
  const res = await signIn(tg);
  // Сбой при выдаче сессии — возвращаем подтверждение, чтобы сайт мог войти со следующей попытки
  if (res.status >= 500) await admin.from('login_requests').update({ status: 'ok' }).eq('id', id).eq('status', 'used').then(() => {}, () => {});
  return res;
}

/* ================= xRocket Pay: оплата криптой на сайте (15-xrocket.sql) ================= */
// Ответ xRocket. Не ответил за 20 секунд или нет связи — не зависаем, а возвращаем ошибку с причиной
// deno-lint-ignore no-explicit-any
const xr = (path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> => fetch(XR_API + path, { ...init, signal: AbortSignal.timeout(20000),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${XR_TOKEN}`, ...(init.headers ?? {}) } })
  .then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }))
  .catch((e) => ({ ok: false, status: 0, data: { title: e?.name === 'TimeoutError' ? 'xRocket не ответил за 20 секунд' : 'нет связи с xRocket', detail: String(e?.message ?? e).slice(0, 100) } }));
const tgSend = (chat: number, text: string, markup?: unknown) => fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) }) }).catch(() => null);

// Счёт на PRO в xRocket. Цена в рублях (персональная из админки или обычная), платят в USDT по курсу
async function xrInvoice(body: { xr_invoice?: string; access_token?: string }) {
  if (!XR_TOKEN) return json({ error: 'xr_off' }, 503);
  const period = body.xr_invoice === 'y' ? 'y' : 'm';
  const { data: ud, error: ue } = await admin.auth.getUser(typeof body.access_token === 'string' ? body.access_token : '');
  if (ue || !ud?.user) return json({ error: 'auth' }, 401);
  if (ud.user.banned_until && Date.parse(ud.user.banned_until) > Date.now()) return json({ error: 'blocked' }, 403);
  const { data: cp } = await admin.from('custom_prices').select('rm, ry').eq('user_id', ud.user.id).maybeSingle();
  const price = (period === 'y' ? cp?.ry : cp?.rm) || RUB[period];
  const id = 'p2p_' + crypto.randomUUID().replace(/-/g, '');
  const { error: ie } = await admin.from('crypto_invoices').insert({ id, user_id: ud.user.id, period, price_rub: price });
  if (ie) { console.error('crypto_invoices', ie); return json({ error: 'db', detail: String(ie.message ?? '').slice(0, 200) }, 500); }
  const { data: t } = await admin.from('tg_users').select('tg_id').eq('user_id', ud.user.id).maybeSingle();
  // xRocket пока не умеет счёт в рублях с оплатой в крипте (валюта цены = валюта оплаты).
  // Поэтому цену в рублях переводим в USDT по курсу самой биржи xRocket и выставляем счёт в USDT
  const rate = await fetch('https://exchange.api.xrocket.exchange/api/v1/rates?base=RUB', { signal: AbortSignal.timeout(8000) })
    .then((x) => x.json()).then((j) => +j?.USDT?.rate).catch(() => 0);
  if (!(rate > 0)) return json({ error: 'rate', detail: 'не удалось получить курс USDT' }, 502);
  const usdt = (Math.ceil(price / rate * 100) / 100).toFixed(2);
  if (+usdt < 0.1) return json({ error: 'min', detail: `${price} ₽ = ${usdt} USDT — слишком маленькая сумма для оплаты криптой` }, 400);
  const req = {
    priceAmount: usdt, priceCurrency: 'USDT', payCurrencies: ['USDT'], numPayments: 1, clientInvoiceId: id,
    description: `P2Pro PRO ${period === 'y' ? 'на год' : 'на месяц'} · ${price} ₽`, expiresIn: 60 * 60e3,
    callback: { callbackUrl: `${SB_URL}/functions/v1/telegram-auth` }, url: { successUrl: SITE + '?paid=crypto', cancelUrl: SITE },
    customer: { id: ud.user.id, ...(t?.tg_id ? { telegramId: String(t.tg_id) } : {}) }, data: { u: ud.user.id, p: period, rub: price },
  };
  const r = await xr('/api/v1/invoices', { method: 'POST', body: JSON.stringify(req) });
  const inv = r.data?.data ?? r.data;
  if (!r.ok || !inv?.links) {
    console.error('xr invoice', r.status, r.data);
    // Причину отказа xRocket показываем в приложении — по ней понятно, что поправить (секретов в ней нет)
    const why = [r.status, r.data?.title, r.data?.detail ?? r.data?.message].filter(Boolean).join(' · ').slice(0, 200);
    return json({ error: 'xr', detail: why || 'нет ответа' }, 502);
  }
  await admin.from('crypto_invoices').update({ xr_id: String(inv.id ?? '') }).eq('id', id);
  return json({ id, usdt, link: inv.links.webLink || inv.links.telegramMiniAppLink || inv.links.telegramBotLink, tg: inv.links.telegramBotLink });
}

// Уведомление от xRocket об оплате. Подпись: HMAC-SHA256(секрет вебхука, "{Signature-Timestamp}.{тело}") в hex
async function xrWebhook(req: Request, raw: string) {
  const ts = req.headers.get('signature-timestamp') ?? '', sig = (req.headers.get('signature') ?? '').toLowerCase();
  if (!XR_SECRET || !ts || !sig) return new Response('forbidden', { status: 403 });
  if (Math.abs(Date.now() - Number(ts)) > 15 * 60e3) return new Response('stale', { status: 403 });   // старое уведомление не принимаем повторно
  if (!same(hex(await hmac(enc.encode(XR_SECRET), `${ts}.${raw}`)), sig)) return new Response('forbidden', { status: 403 });
  let w: { data?: { event?: string; invoice?: { id?: string; clientInvoiceId?: string; status?: string; priceAmount?: string; priceCurrency?: string } } } = {};
  try { w = JSON.parse(raw); } catch (_) { return new Response('bad', { status: 400 }); }
  const inv = w.data?.invoice;
  if (w.data?.event !== 'invoice_status_changed' || inv?.status !== 'paid' || !/^p2p_[a-f0-9]{32}$/.test(inv.clientInvoiceId ?? '')) return new Response('ok');
  // Перепроверяем у самого xRocket, что счёт действительно оплачен
  const chk = await xr('/api/v1/invoice?clientInvoiceId=' + inv.clientInvoiceId);
  const live = chk.data?.data ?? chk.data;
  if (!chk.ok || live?.status !== 'paid') { console.error('xr check', chk.status, live?.status); return new Response('not paid', { status: 409 }); }
  const { data: g, error } = await admin.rpc('crypto_grant_pro', { p_invoice: inv.clientInvoiceId, p_amount: String(live.priceAmount ?? inv.priceAmount ?? ''), p_currency: String(live.priceCurrency ?? inv.priceCurrency ?? '') });
  if (error) { console.error('crypto grant', error); return new Response('retry', { status: 500 }); }   // xRocket пришлёт ещё раз
  const res = g as { fresh: boolean; user_id?: string; period?: string; price_rub?: number; pro_until?: string };
  if (res.fresh && res.user_id) {
    const until = res.pro_until ? new Date(res.pro_until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(' г.', '') : '';
    const { data: t } = await admin.from('tg_users').select('tg_id, username').eq('user_id', res.user_id).maybeSingle();
    if (t?.tg_id) await tgSend(t.tg_id, `✅ <b>Оплата прошла!</b>\n\nP2Pro PRO ${res.period === 'y' ? 'на год' : 'на месяц'} — действует до <b>${until}</b>. Спасибо!`);
    const { data: u } = await admin.auth.admin.getUserById(res.user_id);
    const who = t?.username ? '@' + t.username : String(u?.user?.email ?? res.user_id).replace(/[<>&]/g, '');
    await tgSend(ADMIN_ID, `💎 <b>Оплата криптой ${res.price_rub} ₽</b>\nPRO · ${res.period === 'y' ? 'год' : 'месяц'}\n${who}\nСчёт: <code>${inv.clientInvoiceId}</code> · ${live.priceAmount ?? ''} ${live.priceCurrency ?? ''}`);
  }
  return new Response('ok');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!TOKEN || !SB_URL || !SERVICE) return json({ error: 'server' }, 500);
  const raw = await req.text().catch(() => '');
  if (req.headers.get('signature')) return xrWebhook(req, raw);   // уведомление от xRocket об оплате
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { /* не JSON */ }
  if (typeof body?.xr_invoice === 'string') {
    return xrInvoice(body).catch((e) => { console.error('xr invoice crash', e); return json({ error: 'crash', detail: String(e?.message ?? e).slice(0, 200) }, 500); });
  }
  if (typeof body?.web_login === 'string') return webLogin(body.web_login);
  const initData = typeof body?.initData === 'string' ? body.initData.slice(0, 8192) : '';
  const tg = initData ? await checkInit(initData) : null;
  if (tg === 'old') return json({ error: 'old' }, 401);
  if (!tg) return json({ error: 'bad' }, 401);
  const blocked = await blockedTg(tg.id).catch(() => null);
  if (blocked === null) return json({ error: 'server' }, 503);   // проверить не вышло — не пускаем
  if (blocked) return json({ error: 'blocked' }, 403);
  if (await subscribed(tg.id) === false) return json({ error: 'sub' }, 403);
  // Мини-апп при каждом открытии спрашивает только «подписан ли», без входа
  if (body?.check) return json({ ok: true });
  // Счёт на оплату PRO звёздами. PRO получит аккаунт, в который вошли в приложении (его токен), а не просто этот Telegram
  if (body?.invoice) {
    const period = body.invoice === 'y' ? 'y' : 'm';
    const { data: ud, error: ue } = await admin.auth.getUser(typeof body.access_token === 'string' ? body.access_token : '');
    if (ue || !ud?.user) return json({ error: 'auth' }, 401);
    if (ud.user.banned_until && Date.parse(ud.user.banned_until) > Date.now()) return json({ error: 'blocked' }, 403);
    // Персональная цена (задаёт владелец в админке бота), иначе обычная
    const { data: cp, error: ce } = await admin.from('custom_prices').select('m, y').eq('user_id', ud.user.id).maybeSingle();
    const amount = !ce && cp ? cp[period] : STARS[period];
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/createInvoiceLink`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: period === 'y' ? 'P2Pro PRO на год' : 'P2Pro PRO на месяц',
        description: 'История без ограничений, контрагенты и чёрный список, Excel и карточки без водяного знака',
        payload: JSON.stringify({ u: ud.user.id, p: period }), currency: 'XTR', prices: [{ label: 'P2Pro PRO', amount }],
      }) }).then((x) => x.json()).catch(() => null);
    if (!r?.ok) { console.error('invoice', r); return json({ error: 'server' }, 500); }
    return json({ link: r.result });
  }
  return signIn(tg);
});
