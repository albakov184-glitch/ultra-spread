// P2Pro — Telegram-бот @P2ProAppBot. Отвечает на /start и сообщения, открывает мини-апп.
// Работает как Edge Function в Supabase: Telegram присылает сюда каждое сообщение боту (webhook).
// Токен бота и секрет webhook хранятся в Supabase → Edge Functions → Secrets, в коде их нет.
// Для владельца (ADMIN_ID) бот — ещё и админ-панель (/admin). Остальным эти команды не отвечают.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? '';
const APP = 'https://albakov184-glitch.github.io/ultra-spread/';
const SUPPORT = 'https://t.me/MVSR_P2P';
const ADMIN_ID = 6928515440;   // Telegram id владельца. Telegram присылает его сам — подделать нельзя
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const keyboard = {
  inline_keyboard: [
    [{ text: '🚀 Открыть P2Pro', web_app: { url: APP } }],
    [{ text: 'Тарифы', url: APP + 'tariffs.html' }, { text: 'Поддержка', url: SUPPORT }],
    [{ text: 'Документы', url: APP + 'legal.html' }],
  ],
};

const WELCOME = (name: string) =>
  `Привет${name ? ', ' + name : ''}! 👋\n\n` +
  `<b>P2Pro</b> — калькулятор и дневник P2P-сделок.\n\n` +
  `• Чистая прибыль с учётом комиссий биржи и вывода\n` +
  `• Сделка, круг и треугольник\n` +
  `• История, аналитика и график прибыли\n` +
  `• Подбор курса, связки между биржами, контрагенты\n` +
  `• Данные в облаке — на телефоне и компьютере\n\n` +
  `Нажмите «Открыть P2Pro», чтобы начать. Это бесплатно.`;

const HELP =
  `Приложение открывается кнопкой <b>«Открыть P2Pro»</b> внизу или под этим сообщением.\n\n` +
  `Вопросы и предложения — в поддержку: @MVSR_P2P`;

const tg = (method: string, body: unknown) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()).catch(() => null);

async function send(chatId: number, text: string, buttons = true) {
  await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(buttons ? { reply_markup: keyboard } : {}) });
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/* ================= АДМИН-ПАНЕЛЬ ================= */
// /admin → меню: статистика, пользователи (карточка: PRO, блокировка), рассылка, промокоды, канал, поиск.
// Текстовые команды /stats, /user, /give, /revoke, /promo тоже работают. Обычный текст от владельца — поиск пользователя
// (или черновик рассылки/поста, если бот его ждёт). Раз в 10 минут Supabase будит бота (09-cron.sql) — см. tick()
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const DAY = 864e5, PAGE = 10;
const CHANNEL = '@P2ProChannel';
const BOT_LINK = 'https://t.me/P2ProAppBot?start=channel';   // в канале кнопка мини-аппа не работает — ведём в бота
const date = (v: string | number | null | undefined) => v ? new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(' г.', '') : '—';
const isTg = (email?: string) => /@telegram\.invalid$/i.test(email ?? '');
type AUser = { id: string; email?: string; created_at: string; last_sign_in_at?: string; banned_until?: string | null; user_metadata?: Record<string, unknown> };
type Pay = { ts: string; amount: number; period?: string; method?: string; days?: number };
type Sub = { user_id: string; pro_since: string | null; pro_until: string | null; auto_renew: boolean; pay_method: string | null; period: string; payments: Pay[]; reminded_for?: string | null } | null;
type Btn = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
type Msg = { message_id: number; chat: { id: number; type: string }; from?: { id: number; first_name?: string }; text?: string };
const kb = (rows: Btn[][]) => ({ inline_keyboard: rows });
const isPro = (s: Sub) => !!s?.pro_until && Date.parse(s.pro_until) > Date.now();
const isBanned = (u: AUser) => !!u.banned_until && Date.parse(u.banned_until) > Date.now();
const FREE_METHODS = ['gift', 'promo'];
const STARS: Record<string, number> = { m: 350, y: 2650 };   // цены PRO в звёздах. Такие же — в telegram-auth и в приложении
// Цена для конкретного человека: персональная (11-prices.sql, задаётся в карточке) или обычная
async function priceOf(userId: string): Promise<{ m: number; y: number; custom: boolean }> {
  const { data, error } = await admin.from('custom_prices').select('m, y').eq('user_id', userId).maybeSingle();
  return !error && data ? { m: data.m, y: data.y, custom: true } : { m: STARS.m, y: STARS.y, custom: false };
}
const pct = (v: number, base: number) => Math.round((1 - v / base) * 100);
const openBtn = (text = '🚀 Открыть P2Pro') => kb([[{ text, web_app: { url: APP } }]]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Долгую работу (рассылку) доделываем после ответа Telegram, иначе он решит, что бот завис, и пришлёт запрос снова
const background = (p: Promise<unknown>) => {
  const er = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const safe = p.catch((e) => console.error('background', e));
  return er?.waitUntil ? er.waitUntil(safe) : safe;
};

// Память бота в таблице bot_state (08-admin.sql)
async function stGet<T>(key: string, def: T): Promise<T> {
  const { data } = await admin.from('bot_state').select('value').eq('key', key).maybeSingle();
  return (data?.value as T) ?? def;
}
async function stSet(key: string, value: unknown) {
  await admin.from('bot_state').upsert({ key, value, updated_at: new Date().toISOString() });
}
async function stTake<T>(key: string): Promise<T | null> {   // забрать и удалить одним запросом: двойное нажатие не отправит дважды
  const { data } = await admin.from('bot_state').delete().eq('key', key).select('value');
  return (data?.[0]?.value as T) ?? null;
}

const MENU = () => kb([
  [{ text: '📊 Статистика', callback_data: 'st' }, { text: '👥 Пользователи', callback_data: 'l:0' }],
  [{ text: '📣 Рассылка', callback_data: 'bc' }, { text: '🎟 Промокоды', callback_data: 'pl' }],
  [{ text: '📢 Канал', callback_data: 'ch' }, { text: '🔍 Поиск', callback_data: 'fs' }],
]);
const toMenu = (extra: Btn[] = []) => kb([[...extra, { text: '‹ Меню', callback_data: 'm' }]]);
const ADMIN_HELP = `<b>🛠 Админ-панель P2Pro</b>\n\nВыберите раздел. Чтобы найти пользователя, просто пришлите мне @ник, почту или Telegram id.\n\n` +
  `Команды: /stats, /user @ник, /give @ник 30, /revoke @ник, /promo КОД ДНИ [ЛИМИТ] [СРОК_ДНЕЙ], /price @ник МЕСЯЦ [ГОД], /refund НОМЕР_ПЛАТЕЖА, /cancel`;

// Все аккаунты (Supabase отдаёт страницами по 1000), новые сверху
async function allUsers(): Promise<AUser[]> {
  const out: AUser[] = [];
  for (let page = 1; page < 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    out.push(...(data.users as AUser[]));
    if (data.users.length < 1000) break;
  }
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

async function userById(id: string): Promise<AUser | null> {
  const { data } = await admin.auth.admin.getUserById(id);
  return (data?.user as AUser) ?? null;
}

// Ищем по @нику Telegram, Telegram id или почте
async function findUser(q: string): Promise<AUser | null> {
  q = q.trim().replace(/^https?:\/\/t\.me\//i, '');
  if (/^\d{4,15}$/.test(q)) {
    const { data } = await admin.from('tg_users').select('user_id').eq('tg_id', Number(q)).maybeSingle();
    return data ? userById(data.user_id) : null;
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) return (await allUsers()).find((u) => u.email?.toLowerCase() === q.toLowerCase()) ?? null;
  const nick = q.replace(/^@/, '');
  if (!/^\w{3,32}$/.test(nick)) return null;
  // Ник берём из tg_users — его пишет только сервер при входе. Данные профиля пользователь может подменить
  const { data: rows, error } = await admin.from('tg_users').select('user_id, username').ilike('username', nick.replace(/_/g, '\\_'));
  if (!error && rows?.length === 1) return userById(rows[0].user_id);
  if (!error && rows && rows.length > 1) return null;
  // Кто входил до обновления — ника в таблице ещё нет: ищем в профиле, но только среди Telegram-аккаунтов и только при единственном совпадении
  const hits = (await allUsers()).filter((u) => isTg(u.email) && String(u.user_metadata?.tg_username ?? '').toLowerCase() === nick.toLowerCase());
  return hits.length === 1 ? hits[0] : null;
}

const nameOf = (u: AUser) => String(u.user_metadata?.name ?? '').slice(0, 40) || 'без имени';
const contactOf = (u: AUser) => isTg(u.email) ? (u.user_metadata?.tg_username ? '@' + u.user_metadata.tg_username : 'Telegram без ника') : (u.email ?? '');
const who = (u: AUser) => `<b>${esc(nameOf(u))}</b> · ${esc(contactOf(u))}`;

async function tgIdOf(userId: string): Promise<number | null> {
  const { data } = await admin.from('tg_users').select('tg_id').eq('user_id', userId).maybeSingle();
  return data?.tg_id ?? null;
}
async function tgNick(userId: string): Promise<string> {
  const { data, error } = await admin.from('tg_users').select('username').eq('user_id', userId).maybeSingle();
  return error ? '' : data?.username ?? '';
}
async function subOf(userId: string): Promise<Sub> {
  const { data } = await admin.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
  return data as Sub;
}
async function allSubs(): Promise<NonNullable<Sub>[]> {
  const { data } = await admin.from('subscriptions').select('user_id, pro_until, auto_renew, pay_method, payments');
  return (data ?? []) as NonNullable<Sub>[];
}
const mskDay = (t: number) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
// Оплата в рублях (карта, СБП). Звёзды считаем отдельно, подарки и промокоды — не деньги
const realPay = (p: Pay) => +p.amount > 0 && !FREE_METHODS.includes(p.method ?? '') && p.method !== 'stars';
const starPay = (p: Pay) => p.method === 'stars' && +p.amount > 0;

/* ---------- Статистика ---------- */
async function statsText() {
  const users = await allUsers(), subs = await allSubs(), now = Date.now();
  const tgN = users.filter((u) => isTg(u.email)).length, banned = users.filter(isBanned).length;
  const since = (d: number) => users.filter((u) => now - Date.parse(u.created_at) < d * DAY).length;
  const active = users.filter((u) => u.last_sign_in_at && now - Date.parse(u.last_sign_in_at) < 7 * DAY).length;
  const pro = subs.filter(isPro), gifts = pro.filter((s) => FREE_METHODS.includes(s.pay_method ?? '')).length;
  // Выручка за текущий месяц по Москве
  const month = mskDay(now).slice(0, 7);
  let rev = 0, pays = 0, stars = 0, starN = 0;
  for (const s of subs) for (const p of s.payments ?? []) {
    if (!mskDay(Date.parse(p.ts)).startsWith(month)) continue;
    if (realPay(p)) { rev += +p.amount; pays++; }
    if (p.method === 'stars') { stars += +p.amount; if (+p.amount > 0) starN++; }   // возвраты записаны с минусом
  }
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('deleted', false);
  // График новых пользователей за 14 дней
  const days: [string, number][] = [];
  for (let i = 13; i >= 0; i--) days.push([mskDay(now - i * DAY), 0]);
  for (const u of users) { const d = days.find((x) => x[0] === mskDay(Date.parse(u.created_at))); if (d) d[1]++; }
  const max = Math.max(1, ...days.map((d) => d[1]));
  const chart = days.map(([d, n]) => `${d.slice(8, 10)}.${d.slice(5, 7)} ${'█'.repeat(Math.round(n / max * 12)) || '·'} ${n}`).join('\n');
  return `<b>📊 Статистика P2Pro</b>\n\n` +
    `👥 Пользователей: <b>${users.length}</b>\n   через Telegram: ${tgN} · по почте: ${users.length - tgN}${banned ? ` · заблокировано: ${banned}` : ''}\n` +
    `🆕 Новых за сутки: ${since(1)} · за неделю: ${since(7)} · за месяц: ${since(30)}\n` +
    `🔑 Входили за неделю: ${active}\n\n` +
    `⭐ PRO сейчас: <b>${pro.length}</b> (подарки и промокоды: ${gifts})\n` +
    `💰 Выручка за месяц: <b>${rev.toLocaleString('ru-RU')} ₽</b> · оплат: ${pays}\n⭐ Звёздами за месяц: <b>${stars.toLocaleString('ru-RU')} ⭐</b> · оплат: ${starN}\n📒 Сделок в базе: ${trades ?? 0}\n\n` +
    `<b>Новые пользователи за 14 дней</b>\n<pre>${chart}</pre>`;
}

/* ---------- Пользователи ---------- */
async function listView(page: number) {
  const users = await allUsers(), pages = Math.max(1, Math.ceil(users.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const pro = new Set((await allSubs()).filter(isPro).map((x) => x.user_id));
  const { data: tgs } = await admin.from('tg_users').select('user_id, username');
  const nicks = new Map((tgs ?? []).filter((x: { username?: string }) => x.username).map((x: { user_id: string; username: string }) => [x.user_id, x.username]));
  const view = (u: AUser) => nicks.has(u.id) ? { ...u, user_metadata: { ...u.user_metadata, tg_username: nicks.get(u.id) } } : u;
  const rows: Btn[][] = users.slice(page * PAGE, page * PAGE + PAGE)
    .map(view).map((u) => [{ text: `${isBanned(u) ? '🚫 ' : pro.has(u.id) ? '⭐ ' : ''}${nameOf(u)} | ${contactOf(u)}`.slice(0, 60), callback_data: `u:${u.id}:${page}` }]);
  rows.push([{ text: '‹‹', callback_data: `l:${page - 1}` }, { text: `${page + 1}/${pages}`, callback_data: 'nop' }, { text: '››', callback_data: `l:${page + 1}` }]);
  rows.push([{ text: '🔍 Поиск', callback_data: 'fs' }, { text: '‹ Меню', callback_data: 'm' }]);
  return { text: `<b>👥 Пользователи</b> · всего ${users.length}\n\nНажмите на пользователя, чтобы открыть карточку. ⭐ — есть PRO, 🚫 — заблокирован.`, markup: kb(rows) };
}

async function cardView(u: AUser, back = 0) {   // back — страница списка, куда вернуться
  const s = await subOf(u.id), tgId = await tgIdOf(u.id), nick = await tgNick(u.id), price = await priceOf(u.id);
  if (nick) u = { ...u, user_metadata: { ...u.user_metadata, tg_username: nick } };   // проверенный ник вместо того, что в профиле
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('user_id', u.id).eq('deleted', false);
  const how = s?.pay_method === 'gift' ? ' (подарок)' : s?.pay_method === 'promo' ? ' (промокод)' : s?.pay_method === 'stars' ? ' (звёзды)' : s?.auto_renew ? ' · автопродление' : '';
  const text = `<b>👤 Пользователь</b>\n\n${who(u)}\n` + (tgId ? `Telegram id: <code>${tgId}</code>\n` : '') +
    `Регистрация: ${date(u.created_at)}\nПоследний вход: ${date(u.last_sign_in_at)}\nСделок: ${trades ?? 0}\n\n` +
    (isPro(s) ? `⭐ PRO до <b>${date(s!.pro_until)}</b>${how}` : 'Тариф: Free') +
    `\n💲 Цена: ${price.m} ⭐ / ${price.y} ⭐ в год${price.custom ? ` <b>(персональная, −${pct(price.m, STARS.m)}%)</b>` : ' (обычная)'}` +
    (isBanned(u) ? '\n\n🚫 <b>Аккаунт заблокирован</b>' : '');
  const id = u.id;
  const rows: Btn[][] = [
    [{ text: '🎁 +7 дн', callback_data: `g:${id}:7:${back}` }, { text: '🎁 +30 дн', callback_data: `g:${id}:30:${back}` }],
    [{ text: '🎁 +90 дн', callback_data: `g:${id}:90:${back}` }, { text: '🎁 +365 дн', callback_data: `g:${id}:365:${back}` }],
  ];
  rows.push([{ text: '💲 Изменить цену', callback_data: `pr:${id}:${back}` }]);
  if (isPro(s)) rows.push([{ text: '⛔ Забрать PRO', callback_data: `r:${id}:${back}` }]);
  rows.push([isBanned(u) ? { text: '✅ Разблокировать', callback_data: `ub:${id}:${back}` } : { text: '🚫 Заблокировать', callback_data: `b:${id}:${back}` }]);
  rows.push([{ text: '‹ К списку', callback_data: `l:${back}` }, { text: '‹ Меню', callback_data: 'm' }]);
  return { text, markup: kb(rows) };
}

// Выдать PRO: дни прибавляются к текущему сроку. Одним действием на сервере (admin_gift_pro): двойное нажатие не потеряет дни
async function giveDays(u: AUser, days: number) {
  const { data, error } = await admin.rpc('admin_gift_pro', { p_user: u.id, p_days: days });
  if (error) throw error;
  const until = (data as { pro_until: string }).pro_until;
  const notified = await notify(u.id, `🎁 <b>Вам подарен P2Pro PRO</b> на ${days} дн.\n\nPRO действует до <b>${date(until)}</b>: история без ограничений, контрагенты, Excel и карточки без водяного знака.`, openBtn());
  return { until, notified };
}

async function revokePro(u: AUser) {
  const s = await subOf(u.id);
  if (!isPro(s)) return { was: false, notified: false };
  const { error } = await admin.from('subscriptions').update({ pro_until: new Date().toISOString(), auto_renew: false }).eq('user_id', u.id);
  if (error) throw error;
  const notified = await notify(u.id, `ℹ️ <b>Подписка P2Pro PRO отключена.</b>\n\nВаши сделки и данные сохранены, приложение работает на тарифе Free. Если это ошибка или есть вопросы — напишите в поддержку.`,
    kb([[{ text: '💬 Поддержка', url: SUPPORT }]]));
  return { was: true, notified };
}

// Блокировка: Supabase перестаёт пускать в аккаунт (вход и продление сессии), приложение показывает экран «Аккаунт заблокирован»
async function setBan(u: AUser, on: boolean) {
  if (on && await tgIdOf(u.id) === ADMIN_ID) throw new Error('Свой аккаунт заблокировать нельзя');
  const { error } = await admin.auth.admin.updateUserById(u.id, { ban_duration: on ? '876000h' : 'none' });
  if (error) throw error;
  return on
    ? notify(u.id, `🚫 <b>Ваш аккаунт P2Pro заблокирован.</b>\n\nЧтобы узнать причину и разблокировать аккаунт, напишите в поддержку.`, kb([[{ text: '💬 Поддержка', url: SUPPORT }]]))
    : notify(u.id, `✅ <b>Ваш аккаунт P2Pro разблокирован.</b>\n\nМожно снова пользоваться приложением.`, openBtn());
}

// Сообщение пользователю. Дойдёт, только если он хоть раз запускал бота
async function notify(userId: string, text: string, markup: unknown) {
  const tgId = await tgIdOf(userId);
  if (!tgId) return false;
  const r = await tg('sendMessage', { chat_id: tgId, text, parse_mode: 'HTML', reply_markup: markup });
  return !!r?.ok;
}
const noteOf = (u: AUser, ok: boolean) => ok ? '\n📨 Пользователю отправлено уведомление.' : isTg(u.email) ? '\n⚠️ Уведомление не дошло: пользователь не запускал бота.' : '\n⚠️ Уведомление не отправлено: аккаунт по почте, без Telegram.';
const NOT_FOUND = 'Не нашёл пользователя. Ник ищется у тех, кто входил в P2Pro через Telegram; остальных ищите по почте.';

/* ---------- Рассылка ---------- */
type Aud = 'all' | 'pro' | 'exp' | 'free';
const AUD: Record<Aud, string> = { all: 'всем', pro: 'с PRO', exp: 'у кого PRO кончается за 7 дней', free: 'без PRO' };
async function recipients(aud: Aud): Promise<number[]> {
  const { data: tgs } = await admin.from('tg_users').select('tg_id, user_id');
  const subs = new Map((await allSubs()).map((s) => [s.user_id, s]));
  const banned = new Set((await allUsers()).filter(isBanned).map((u) => u.id));
  const now = Date.now();
  return (tgs ?? []).filter((t: { user_id: string }) => {
    if (banned.has(t.user_id)) return false;
    const s = subs.get(t.user_id) ?? null, pro = isPro(s);
    return aud === 'all' || (aud === 'pro' && pro) || (aud === 'free' && !pro) || (aud === 'exp' && pro && Date.parse(s!.pro_until!) - now <= 7 * DAY);
  }).map((t: { tg_id: number }) => t.tg_id);
}
async function bcMenu() {
  const n = await Promise.all((['all', 'pro', 'exp', 'free'] as Aud[]).map((a) => recipients(a).then((r) => r.length)));
  return { text: `<b>📣 Рассылка</b>\n\nКому отправить? Получат только те, кто входил через Telegram и не заблокирован.`, markup: kb([
    [{ text: `👥 Всем (${n[0]})`, callback_data: 'ba:all' }, { text: `⭐ С PRO (${n[1]})`, callback_data: 'ba:pro' }],
    [{ text: `⏳ PRO ≤ 7 дн (${n[2]})`, callback_data: 'ba:exp' }, { text: `🆓 Без PRO (${n[3]})`, callback_data: 'ba:free' }],
    [{ text: '‹ Меню', callback_data: 'm' }]]) };
}
async function broadcast(fromChat: number, msgId: number, aud: Aud) {
  const ids = await recipients(aud);
  const markup = aud === 'exp' || aud === 'free' ? openBtn('⭐ Продлить PRO') : openBtn();
  let ok = 0;
  const one = async (id: number) => {
    let r = await tg('copyMessage', { chat_id: id, from_chat_id: fromChat, message_id: msgId, reply_markup: markup });
    if (r?.error_code === 429) { await sleep((r.parameters?.retry_after ?? 3) * 1000); r = await tg('copyMessage', { chat_id: id, from_chat_id: fromChat, message_id: msgId, reply_markup: markup }); }
    if (r?.ok) ok++;
  };
  // Пачками по 25 раз в секунду: Telegram пускает ~30 сообщений в секунду, а функция живёт ограниченное время
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map(one));
    if (i + 25 < ids.length) await sleep(1000);
  }
  await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', text: `📣 <b>Рассылка ${AUD[aud]} завершена</b>\nДоставлено: ${ok} из ${ids.length}${ids.length - ok ? `\nНе доставлено ${ids.length - ok} — эти люди остановили бота.` : ''}` });
}

/* ---------- Канал ---------- */
const TIPS = [
  'Считайте прибыль <b>после всех комиссий</b>: биржи, вывода и банка. Спред 2% легко превращается в 0,5% чистыми.',
  'Ведите список контрагентов. Отметка «надёжный» или «чёрный список» экономит время и нервы на следующих сделках.',
  'Перед сделкой посчитайте <b>курс безубытка</b> — ниже него продавать нельзя, иначе круг уйдёт в минус.',
  'Связки между биржами дают больший спред, но учитывайте комиссию сети при переводе USDT. TRC20 обычно дешевле.',
  'Ставьте цель на день. Когда видишь прогресс, проще остановиться вовремя и не лезть в рискованные сделки.',
  'Не принимайте деньги от третьих лиц: оплата должна приходить с карты на имя покупателя в ордере.',
  'Раз в неделю смотрите аналитику: какая биржа и какой банк приносят больше прибыли — туда и смещайте объём.',
  'Мейкер или тейкер? Мейкер выставляет объявление и ждёт, тейкер берёт готовое. У мейкера спред выше, но и ожидание дольше.',
  'Сохраняйте чеки и историю сделок: при вопросах от банка по 115-ФЗ проще подтвердить происхождение денег.',
  'Делитесь результатами карточкой сделки — в PRO она без водяного знака и с процентами вместо сумм, если нужно.',
];
async function postTip(force = false) {
  const ap = await stGet('autopost', { on: false, idx: 0, last: 0 });
  if (!force && !ap.on) return false;
  const tip = TIPS[ap.idx % TIPS.length];
  const r = await tg('sendMessage', { chat_id: CHANNEL, parse_mode: 'HTML', disable_web_page_preview: true,
    text: `💡 <b>Совет P2P</b>\n\n${tip}\n\n🧮 Считайте сделки в P2Pro — бесплатно.`, reply_markup: kb([[{ text: '🚀 Открыть P2Pro', url: BOT_LINK }]]) });
  if (r?.ok) await stSet('autopost', { ...ap, idx: ap.idx + 1, last: Date.now() });
  return !!r?.ok;
}
async function chMenu() {
  const ap = await stGet('autopost', { on: false, idx: 0, last: 0 });
  return { text: `<b>📢 Канал ${CHANNEL}</b>\n\nАвтопосты: <b>${ap.on ? 'включены' : 'выключены'}</b> — раз в неделю бот публикует совет по P2P с кнопкой P2Pro.` +
    (ap.last ? `\nПоследний автопост: ${date(ap.last)}` : '') + `\n\nЧтобы бот мог публиковать, у него в канале должно быть право «Публикация сообщений».`, markup: kb([
    [{ text: ap.on ? '⏸ Выключить автопосты' : '▶️ Включить автопосты', callback_data: 'ap' }],
    [{ text: '✍️ Написать пост', callback_data: 'cp' }, { text: '💡 Совет сейчас', callback_data: 'tip' }],
    [{ text: '‹ Меню', callback_data: 'm' }]]) };
}

/* ---------- Промокоды ---------- */
type Promo = { code: string; days: number; max_uses: number | null; uses: number; expires_at: string | null; active: boolean };
const promoLine = (p: Promo) => `${p.active ? '✅' : '⏸'} ${p.code} · ${p.days} дн · ${p.uses}${p.max_uses ? '/' + p.max_uses : ''}`;
async function promoList() {
  const { data } = await admin.from('promo_codes').select('*').order('created_at', { ascending: false }).limit(20);
  const list = (data ?? []) as Promo[];
  const rows: Btn[][] = list.map((p) => [{ text: promoLine(p), callback_data: `pc:${p.code}` }]);
  rows.push([{ text: '‹ Меню', callback_data: 'm' }]);
  return { text: `<b>🎟 Промокоды</b>${list.length ? '' : '\n\nПока нет ни одного.'}\n\nСоздать: <code>/promo КОД ДНИ ЛИМИТ СРОК</code>\nНапример <code>/promo START30 30 100 14</code> — 30 дней PRO, 100 активаций, действует 14 дней. Лимит и срок можно не писать.\n\nПользователь вводит код в приложении: Профиль → «Есть промокод?»`, markup: kb(rows) };
}
async function promoCard(code: string) {
  const { data: p } = await admin.from('promo_codes').select('*').eq('code', code).maybeSingle() as { data: Promo | null };
  if (!p) return promoList();
  return { text: `<b>🎟 ${p.code}</b>\n\n${p.days} дн. PRO\nАктиваций: ${p.uses}${p.max_uses ? ' из ' + p.max_uses : ' (без лимита)'}\n` +
    `Действует: ${p.expires_at ? 'до ' + date(p.expires_at) : 'бессрочно'}\nСтатус: ${p.active ? '✅ активен' : '⏸ выключен'}`, markup: kb([
    [{ text: p.active ? '⏸ Выключить' : '▶️ Включить', callback_data: `pt:${p.code}` }, { text: '🗑 Удалить', callback_data: `pd:${p.code}` }],
    [{ text: '‹ Промокоды', callback_data: 'pl' }, { text: '‹ Меню', callback_data: 'm' }]]) };
}
async function promoCreate(args: string[]) {
  const [raw = '', d = '', lim = '', exp = ''] = args, code = raw.toUpperCase(), days = Number(d), max = lim ? Number(lim) : null, ttl = exp ? Number(exp) : null;
  if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !Number.isInteger(days) || days < 1 || days > 3650 || (max !== null && (!Number.isInteger(max) || max < 1)) || (ttl !== null && (!Number.isInteger(ttl) || ttl < 1)))
    return 'Напишите так: <code>/promo КОД ДНИ ЛИМИТ СРОК</code>\nКОД — латиница и цифры, 3–32 знака. ДНИ — от 1 до 3650. ЛИМИТ и СРОК (в днях) — по желанию.';
  const { error } = await admin.from('promo_codes').insert({ code, days, max_uses: max, expires_at: ttl ? new Date(Date.now() + ttl * DAY).toISOString() : null });
  if (error) return error.code === '23505' ? `Код ${code} уже есть.` : 'Ошибка: ' + esc(error.message);
  return `✅ Промокод <code>${code}</code> создан: ${days} дн. PRO${max ? `, ${max} активаций` : ''}${ttl ? `, действует до ${date(Date.now() + ttl * DAY)}` : ''}.`;
}

/* ---------- Оплата звёздами ---------- */
// Счёт создаёт функция telegram-auth (по запросу мини-аппа). Telegram перед списанием спрашивает нас — проверяем счёт
async function preCheckout(q: { id: string; currency: string; total_amount: number; invoice_payload: string }) {
  let ok = false, why = 'Счёт устарел — откройте оплату в P2Pro заново';
  try {
    const p = JSON.parse(q.invoice_payload);
    const u = p?.u ? await userById(String(p.u)) : null;
    const price = u ? await priceOf(u.id) : null;
    if (q.currency === 'XTR' && u && (p?.p === 'm' || p?.p === 'y') && price![p.p as 'm' | 'y'] === q.total_amount) { ok = !isBanned(u); if (!ok) why = 'Аккаунт заблокирован — напишите в поддержку'; }
  } catch (_) { /* битый payload */ }
  await tg('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: why });
}
// Оплата прошла: выдаём PRO (один платёж — одна выдача) и сообщаем покупателю и владельцу
async function paid(msg: Msg & { successful_payment: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string } }) {
  const sp = msg.successful_payment;
  let p: { u?: string; p?: string } = {};
  try { p = JSON.parse(sp.invoice_payload); } catch (_) { /* не наш счёт */ }
  const period = p.p === 'y' ? 'y' : 'm';
  const { data, error } = await admin.rpc('stars_grant_pro', { p_user: p.u, p_period: period, p_charge: sp.telegram_payment_charge_id, p_stars: sp.total_amount, p_tg: msg.from?.id ?? null });
  if (error) {
    console.error('stars grant', error);
    await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', text: `⚠️ <b>Оплата звёздами не применилась</b>\n${sp.total_amount} ⭐ от ${msg.from?.id}\nПлатёж: <code>${esc(sp.telegram_payment_charge_id)}</code>\nОшибка: ${esc(error.message)}` });
    await send(msg.chat.id, 'Оплата получена, но PRO не включился автоматически. Мы уже разбираемся — напишите в поддержку, если PRO не появится в течение часа.', false);
    return;
  }
  if (!(data as { fresh: boolean }).fresh) return;   // Telegram прислал тот же платёж повторно
  const until = (data as { pro_until: string }).pro_until;
  await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', reply_markup: openBtn(),
    text: `✅ <b>Оплата прошла!</b>\n\nP2Pro PRO ${period === 'y' ? 'на год' : 'на месяц'} — действует до <b>${date(until)}</b>. Спасибо!` });
  const u = p.u ? await userById(p.u) : null;
  await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML',
    text: `💰 <b>Оплата ${sp.total_amount} ⭐</b>\nPRO · ${period === 'y' ? 'год' : 'месяц'}\n${u ? who(u) : esc(String(p.u))}\nПлатёж: <code>${esc(sp.telegram_payment_charge_id)}</code>` });
}
// Возврат звёзд: /refund НОМЕР_ПЛАТЕЖА (номер приходит в уведомлении об оплате)
async function refund(charge: string) {
  if (!charge) return 'Напишите так: <code>/refund НОМЕР_ПЛАТЕЖА</code> — номер есть в уведомлении об оплате.';
  const { data: row } = await admin.from('star_payments').select('tg_id, refunded').eq('charge_id', charge).maybeSingle();
  if (!row) return 'Платёж не найден.';
  if (row.refunded) return 'По этому платежу уже сделан возврат.';
  if (!row.tg_id) return 'У платежа нет Telegram id — вернуть звёзды автоматически нельзя.';
  const r = await tg('refundStarPayment', { user_id: row.tg_id, telegram_payment_charge_id: charge });
  // Уже возвращено в Telegram (например, прошлая попытка не дописала базу) — просто доделываем запись
  if (!r?.ok && !/ALREADY_REFUNDED/i.test(r?.description ?? '')) return 'Telegram не принял возврат: ' + esc(r?.description ?? 'нет ответа');
  const { data, error } = await admin.rpc('stars_refund', { p_charge: charge });
  if (error) return 'Звёзды вернули, но срок PRO не уменьшился: ' + esc(error.message) + '\nПовторите /refund — запись доделается.';
  if (!(data as { ok: boolean }).ok) return 'По этому платежу уже сделан возврат.';
  await tg('sendMessage', { chat_id: row.tg_id, parse_mode: 'HTML', reply_markup: kb([[{ text: '💬 Поддержка', url: SUPPORT }]]),
    text: `↩️ <b>Возврат ${(data as { stars: number }).stars} ⭐</b>\n\nЗвёзды вернулись на ваш баланс Telegram, оплаченные дни PRO отменены.` });
  return `↩️ Возврат ${(data as { stars: number }).stars} ⭐ сделан, дни PRO сняты.`;
}

/* ---------- Персональная цена ---------- */
async function priceView(u: AUser, back: number) {
  const p = await priceOf(u.id), id = u.id;
  return { text: `<b>💲 Цена PRO для</b> ${who(u)}\n\nСейчас: <b>${p.m} ⭐</b> в месяц · <b>${p.y} ⭐</b> в год${p.custom ? ' (персональная)' : ' (обычная)'}\n` +
    `Обычная: ${STARS.m} ⭐ / ${STARS.y} ⭐\n\nВыберите скидку или задайте точную цену командой:\n<code>/price ${esc(contactOf(u))} 250 1900</code> — месяц и год в звёздах (год можно не писать).\n\nЧеловек увидит новую цену в окне оплаты и получит сообщение, если цена ниже обычной.`,
    markup: kb([
      [10, 20, 30].map((d) => ({ text: `−${d}%`, callback_data: `ps:${id}:${d}:${back}` })),
      [40, 50, 70].map((d) => ({ text: `−${d}%`, callback_data: `ps:${id}:${d}:${back}` })),
      ...(p.custom ? [[{ text: '↩️ Вернуть обычную цену', callback_data: `px:${id}:${back}` }]] : []),
      [{ text: '‹ К карточке', callback_data: `u:${id}:${back}` }]]) };
}
async function setPrice(u: AUser, m: number, y?: number) {
  y = y ?? Math.max(1, Math.round(m * STARS.y / STARS.m));   // год — с той же скидкой, что и месяц
  if (!Number.isInteger(m) || m < 1 || m > 100000 || !Number.isInteger(y) || y < 1 || y > 1000000) throw new Error('Цена — целое число звёзд от 1');
  const { error } = await admin.from('custom_prices').upsert({ user_id: u.id, m, y, updated_at: new Date().toISOString() });
  if (error) throw error;
  const notified = m < STARS.m ? await notify(u.id, `🎁 <b>Персональная цена P2Pro PRO для вас</b>\n\n<s>${STARS.m}</s> <b>${m} ⭐</b> в месяц · <s>${STARS.y}</s> <b>${y} ⭐</b> в год.\n\nОткройте приложение: Профиль → «Подключить PRO».`, openBtn('⭐ Подключить PRO')) : false;
  return { m, y, notified };
}

/* ---------- Вход на сайт через бота (12-tglogin.sql) ---------- */
// Сайт открывает бота по ссылке ?start=login_НОМЕР. Спрашиваем «Войти или отмена»; сайт сам узнает ответ у telegram-auth
const LOGIN_TTL = 5 * 60e3;
async function loginPrompt(msg: Msg) {
  const id = (msg.text ?? '').trim().slice('/start login_'.length);
  if (!/^[a-f0-9]{32}$/.test(id)) return send(msg.chat.id, 'Ссылка для входа неверная. Нажмите «Войти через Telegram» на сайте ещё раз.', false);
  await admin.from('login_requests').upsert({ id }, { onConflict: 'id', ignoreDuplicates: true });
  await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML',
    text: `🔐 <b>Вход на сайт P2Pro</b>\n\nНажмите «Войти», если вы сейчас входите на сайт P2Pro в браузере.\n\n⚠️ Если вы ничего не открывали или эту ссылку вам кто-то прислал — нажмите «Отмена»: иначе этот человек войдёт в ваш аккаунт.`,
    reply_markup: kb([[{ text: '✅ Войти', callback_data: `lg:${id}` }, { text: '✖️ Отмена', callback_data: `ln:${id}` }]]) });
}
async function loginAnswer(cq: { id: string; data?: string; from: { id: number; first_name?: string; last_name?: string; username?: string }; message?: { chat: { id: number }; message_id: number } }) {
  const [k, id = ''] = String(cq.data).split(':'), yes = k === 'lg';
  const patch = yes ? { status: 'ok', tg: { id: cq.from.id, first_name: cq.from.first_name, last_name: cq.from.last_name, username: cq.from.username } } : { status: 'no' };
  const { data } = await admin.from('login_requests').update(patch).eq('id', id).eq('status', 'new').gt('created_at', new Date(Date.now() - LOGIN_TTL).toISOString()).select('id');
  const done = !!data?.length;
  const text = !done ? 'Эта ссылка для входа уже использована или устарела. Нажмите «Войти через Telegram» на сайте ещё раз.'
    : yes ? '✅ <b>Вход подтверждён.</b>\n\nВернитесь в браузер, где открыт сайт P2Pro, — вы уже вошли.' : '✖️ Вход отменён.';
  if (cq.message) await tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text, parse_mode: 'HTML' });
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: done ? (yes ? 'Вход подтверждён' : 'Отменено') : 'Ссылка устарела' });
}

/* ---------- Ответы ---------- */
// Новое сообщение или замена текущего (когда нажали кнопку)
async function show(chatId: number, msgId: number | null, text: string, markup: unknown) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) };
  if (msgId) {
    const r = await tg('editMessageText', { ...body, message_id: msgId });
    if (r?.ok || /not modified/.test(r?.description ?? '')) return;
  }
  await tg('sendMessage', body);
}

async function adminCallback(cq: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } }) {
  const chatId = cq.message?.chat.id ?? ADMIN_ID, msgId = cq.message?.message_id ?? null;
  const [k, a = '', b = '', c = ''] = String(cq.data ?? '').split(':');
  let toastText = '';
  const view = async (v: { text: string; markup: unknown }) => show(chatId, msgId, v.text, v.markup);
  try {
    // Любая другая кнопка отменяет ожидание текста рассылки/поста: иначе следующий поиск по @нику стал бы рассылкой
    if (!['ba', 'cp', 'go', 'no', 'nop'].includes(k)) await stSet('await', null);
    if (k === 'm') { await stSet('await', null); await show(chatId, msgId, ADMIN_HELP, MENU()); }
    else if (k === 'st') await show(chatId, msgId, await statsText(), toMenu([{ text: '🔄 Обновить', callback_data: 'st' }]));
    else if (k === 'l') await view(await listView(Number(a) || 0));
    else if (k === 'fs') await show(chatId, msgId, '🔍 Пришлите @ник, почту или Telegram id пользователя.', toMenu());
    // рассылка
    else if (k === 'bc') await view(await bcMenu());
    else if (k === 'ba' && a in AUD) {
      await stSet('await', { kind: 'bc', aud: a, at: Date.now() });
      await show(chatId, msgId, `📣 Рассылка <b>${AUD[a as Aud]}</b>.\n\nПришлите сообщение: текст, фото с подписью или видео. Я покажу, как оно выглядит, и спрошу подтверждение.\nПод сообщением будет кнопка P2Pro.`, toMenu([{ text: 'Отмена', callback_data: 'bc' }]));
    }
    // канал
    else if (k === 'ch') await view(await chMenu());
    else if (k === 'ap') { const ap = await stGet('autopost', { on: false, idx: 0, last: 0 }); await stSet('autopost', { ...ap, on: !ap.on }); toastText = ap.on ? 'Автопосты выключены' : 'Автопосты включены'; await view(await chMenu()); }
    else if (k === 'tip') toastText = await postTip(true) ? 'Совет опубликован' : 'Не удалось: дайте боту право публикации в канале';
    else if (k === 'cp') {
      await stSet('await', { kind: 'post', at: Date.now() });
      await show(chatId, msgId, `✍️ Пришлите пост для ${CHANNEL}: текст, фото с подписью или видео. Перед публикацией я спрошу подтверждение. Под постом будет кнопка «Открыть P2Pro».`, toMenu([{ text: 'Отмена', callback_data: 'ch' }]));
    }
    // отправка черновика рассылки или поста
    else if (k === 'go') {
      const d = await stTake<{ kind: string; aud?: Aud; chat: number; mid: number }>('draft');
      if (!d) toastText = 'Уже отправлено или отменено';
      else if (d.kind === 'post') {
        const r = await tg('copyMessage', { chat_id: CHANNEL, from_chat_id: d.chat, message_id: d.mid, reply_markup: kb([[{ text: '🚀 Открыть P2Pro', url: BOT_LINK }]]) });
        await show(chatId, msgId, r?.ok ? `✅ Пост опубликован в ${CHANNEL}.` : `⚠️ Не удалось опубликовать: дайте боту право «Публикация сообщений» в канале.`, toMenu([{ text: '📢 Канал', callback_data: 'ch' }]));
      } else {
        await show(chatId, msgId, `📣 Отправляю ${AUD[d.aud ?? 'all']}… Итог пришлю отдельным сообщением.`, toMenu());
        background(broadcast(d.chat, d.mid, d.aud ?? 'all'));
      }
    }
    else if (k === 'no') { await stTake('draft'); await show(chatId, msgId, 'Отменено.', toMenu()); }
    // промокоды
    else if (k === 'pl') await view(await promoList());
    else if (k === 'pc') await view(await promoCard(a));
    else if (k === 'pt') { const { data: p } = await admin.from('promo_codes').select('active').eq('code', a).maybeSingle(); if (p) await admin.from('promo_codes').update({ active: !p.active }).eq('code', a); await view(await promoCard(a)); }
    else if (k === 'pd') await show(chatId, msgId, `Удалить промокод <b>${esc(a)}</b>? Уже выданные дни PRO у пользователей останутся.`, kb([[{ text: '🗑 Да, удалить', callback_data: `pdd:${a}` }, { text: 'Отмена', callback_data: `pc:${a}` }]]));
    else if (k === 'pdd') { await admin.from('promo_codes').delete().eq('code', a); toastText = 'Удалено'; await view(await promoList()); }
    // пользователь
    else if (['u', 'g', 'r', 'rr', 'b', 'bb', 'ub', 'pr', 'ps', 'px'].includes(k)) {
      const u = await userById(a);
      const page = Number(k === 'g' || k === 'ps' ? c : b) || 0;
      if (!u) toastText = 'Пользователь не найден';
      else if (k === 'u') await view(await cardView(u, page));
      else if (k === 'pr') await view(await priceView(u, page));
      else if (k === 'ps') { const r = await setPrice(u, Math.max(1, Math.round(STARS.m * (1 - Number(b) / 100))), Math.max(1, Math.round(STARS.y * (1 - Number(b) / 100)))); toastText = `Цена: ${r.m} ⭐ / ${r.y} ⭐`; const v = await cardView(u, page); await show(chatId, msgId, v.text + (r.notified ? '\n\n📨 Пользователю отправлено сообщение о новой цене.' : ''), v.markup); }
      else if (k === 'px') { await admin.from('custom_prices').delete().eq('user_id', u.id); toastText = 'Обычная цена'; await view(await cardView(u, page)); }
      else if (k === 'r') await show(chatId, msgId, `Забрать PRO у ${who(u)}?\nПользователю придёт сообщение с кнопкой поддержки.`,
        kb([[{ text: '⛔ Да, забрать', callback_data: `rr:${u.id}:${page}` }, { text: 'Отмена', callback_data: `u:${u.id}:${page}` }]]));
      else if (k === 'rr') { const r = await revokePro(u); toastText = r.was ? 'PRO отключён' : 'PRO уже не было'; const v = await cardView(u, page); await show(chatId, msgId, v.text + (r.was ? '\n' + noteOf(u, r.notified) : ''), v.markup); }
      else if (k === 'b') await show(chatId, msgId, `Заблокировать ${who(u)}?\nОн не сможет войти в P2Pro и получит сообщение с кнопкой поддержки. Данные сохранятся.`,
        kb([[{ text: '🚫 Да, заблокировать', callback_data: `bb:${u.id}:${page}` }, { text: 'Отмена', callback_data: `u:${u.id}:${page}` }]]));
      else if (k === 'bb' || k === 'ub') {
        const ok = await setBan(u, k === 'bb'); toastText = k === 'bb' ? 'Заблокирован' : 'Разблокирован';
        const v = await cardView((await userById(u.id)) ?? u, page); await show(chatId, msgId, v.text + '\n' + noteOf(u, ok), v.markup);
      } else {
        const days = Number(b);
        if (!Number.isInteger(days) || days < 1 || days > 3650) toastText = 'Неверное число дней';
        else { const r = await giveDays(u, days); toastText = `Выдано +${days} дн.`; const v = await cardView(u, page); await show(chatId, msgId, v.text + '\n' + noteOf(u, r.notified), v.markup); }
      }
    }
  } catch (e) {
    console.error('admin', e);
    toastText = String((e as Error)?.message ?? 'Ошибка сервера').slice(0, 180);
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: toastText || undefined });
}

// Сообщение от владельца: черновик рассылки/поста, команда или поиск. false — пусть отвечает обычный бот
async function adminMessage(msg: Msg): Promise<boolean> {
  const chatId = msg.chat.id, text = (msg.text ?? '').trim();
  const view0 = (v: { text: string; markup: unknown }) => show(chatId, null, v.text, v.markup);
  if (text.startsWith('/start')) return false;
  try {
    const aw = await stGet<{ kind: string; aud?: Aud; at: number } | null>('await', null);
    if (aw && Date.now() - aw.at < 60 * 60e3 && !text.startsWith('/')) {
      await stSet('await', null);
      await stSet('draft', { kind: aw.kind, aud: aw.aud, chat: chatId, mid: msg.message_id });
      const n = aw.kind === 'bc' ? (await recipients(aw.aud ?? 'all')).length : 0;
      await show(chatId, null, aw.kind === 'post' ? `Опубликовать это сообщение в ${CHANNEL}?` : `Отправить это сообщение <b>${AUD[aw.aud ?? 'all']}</b>? Получателей: <b>${n}</b>.`,
        kb([[{ text: aw.kind === 'post' ? '✅ Опубликовать' : `✅ Отправить (${n})`, callback_data: 'go' }, { text: 'Отмена', callback_data: 'no' }]]));
      return true;
    }
    if (!text) return false;
    const [cmd, a = '', b = ''] = text.split(/\s+/), args = text.split(/\s+/).slice(1);
    const c = cmd.toLowerCase().replace(/@\w+$/, '');
    if (c === '/admin') {
      await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: [
        { command: 'admin', description: 'Админ-панель' }, { command: 'stats', description: 'Статистика' },
        { command: 'user', description: 'Карточка: /user @ник' }, { command: 'give', description: 'Выдать PRO: /give @ник 30' },
        { command: 'revoke', description: 'Забрать PRO: /revoke @ник' }, { command: 'promo', description: 'Промокод: /promo КОД ДНИ' },
        { command: 'price', description: 'Цена: /price @ник 250 1900' }, { command: 'refund', description: 'Возврат звёзд: /refund НОМЕР' }, { command: 'cancel', description: 'Отменить рассылку/пост' }, { command: 'start', description: 'Открыть P2Pro' } ] });
      await stSet('await', null);
      await show(chatId, null, ADMIN_HELP, MENU());
    } else if (c === '/cancel') { await stSet('await', null); await stTake('draft'); await show(chatId, null, 'Отменено.', MENU()); }
    else if (c === '/stats') await show(chatId, null, await statsText(), toMenu([{ text: '🔄 Обновить', callback_data: 'st' }]));
    else if (c === '/promo') await show(chatId, null, await promoCreate(args), kb([[{ text: '🎟 Промокоды', callback_data: 'pl' }]]));
    else if (c === '/refund') await show(chatId, null, await refund(a), null);
    else if (c === '/price') {
      const u = a ? await findUser(a) : null, m = Number(b), y = args[2] ? Number(args[2]) : undefined;
      if (!u) await show(chatId, null, a ? NOT_FOUND : 'Напишите так: <code>/price @ник 250 1900</code> — цена за месяц и за год в звёздах', null);
      else if (!b) await view0(await priceView(u, 0));
      else { const r = await setPrice(u, m, y); await show(chatId, null, `✅ ${who(u)}\nПерсональная цена: <b>${r.m} ⭐</b> / <b>${r.y} ⭐</b> в год.${r.notified ? '\n📨 Пользователю отправлено сообщение.' : ''}`, kb([[{ text: '👤 Карточка', callback_data: `u:${u.id}` }]])); }
    }
    else if (c === '/user' || !c.startsWith('/')) {
      const q = c === '/user' ? a : text;
      const u = q ? await findUser(q) : null;
      if (u) { const v = await cardView(u); await show(chatId, null, v.text, v.markup); }
      else await show(chatId, null, q ? NOT_FOUND : 'Напишите так: <code>/user @ник</code>', toMenu());
    } else if (c === '/give') {
      const days = Number(b), u = a ? await findUser(a) : null;
      if (!Number.isInteger(days) || days < 1 || days > 3650) await show(chatId, null, 'Напишите так: <code>/give @ник 30</code> — число дней от 1 до 3650', null);
      else if (!u) await show(chatId, null, NOT_FOUND, null);
      else { const r = await giveDays(u, days); await show(chatId, null, `✅ ${who(u)}\nPRO на ${days} дн. — до <b>${date(r.until)}</b>.${noteOf(u, r.notified)}`, kb([[{ text: '👤 Карточка', callback_data: `u:${u.id}` }]])); }
    } else if (c === '/revoke') {
      const u = a ? await findUser(a) : null;
      if (!u) await show(chatId, null, a ? NOT_FOUND : 'Напишите так: <code>/revoke @ник</code>', null);
      else { const r = await revokePro(u); await show(chatId, null, r.was ? `⛔ ${who(u)}\nPRO отключён, тариф Free.${noteOf(u, r.notified)}` : `${who(u)}\nPRO и так не было.`, null); }
    } else return false;
  } catch (e) {
    console.error('admin', e);
    await show(chatId, null, 'Ошибка сервера: ' + esc(String((e as Error)?.message ?? e).slice(0, 200)), null);
  }
  return true;
}

/* ================= ПО РАСПИСАНИЮ (09-cron.sql, каждые 10 минут) ================= */
async function tick() {
  const now = Date.now();
  // 1. Новые пользователи и оплаты — уведомления владельцу. При первом запуске только запоминаем время
  const seen = await stGet<{ at: string } | null>('seen', null);
  const nowIso = new Date().toISOString();   // всё, что появится после этой отметки, покажем в следующий раз
  if (seen?.at) {
    const since = Date.parse(seen.at);
    const fresh = (await allUsers()).filter((u) => Date.parse(u.created_at) > since && Date.parse(u.created_at) <= Date.parse(nowIso)).reverse();
    if (fresh.length) await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML',
      text: (fresh.length === 1 ? '🆕 <b>Новый пользователь</b>\n' : `🆕 <b>Новых пользователей: ${fresh.length}</b>\n`) + fresh.slice(0, 10).map(who).join('\n') + (fresh.length > 10 ? '\n…' : '') });
    const { data: subs } = await admin.from('subscriptions').select('user_id, payments').gt('updated_at', seen.at);
    for (const s of (subs ?? []) as NonNullable<Sub>[]) for (const p of s.payments ?? []) {
      if (!realPay(p) || Date.parse(p.ts) <= since || Date.parse(p.ts) > Date.parse(nowIso)) continue;   // о звёздах бот сообщает сразу при оплате
      const u = await userById(s.user_id);
      await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML',
        text: `💰 <b>Оплата ${(+p.amount).toLocaleString('ru-RU')} ₽</b>\nPRO · ${p.period === 'y' ? 'год' : 'месяц'}${(p as { auto?: boolean }).auto ? ' · автопродление' : ''}\n${u ? who(u) : s.user_id}` });
    }
  }
  await stSet('seen', { at: nowIso });
  // Старые запросы входа на сайт больше не нужны
  await admin.from('login_requests').delete().lt('created_at', new Date(now - DAY).toISOString()).then(() => {}, () => {});

  const hourMsk = new Date(now + 3 * 3600e3).getUTCHours();
  // 2. Раз в день после 12:00 МСК — напоминания «PRO закончится через 3 дня»
  const daily = await stGet('daily', { day: '' });
  if (daily.day !== mskDay(now) && hourMsk >= 12) { await stSet('daily', { day: mskDay(now) }); await remindExpiring(); }
  // 3. Раз в неделю — совет в канал, если автопосты включены
  const ap = await stGet('autopost', { on: false, idx: 0, last: 0 });
  if (ap.on && hourMsk >= 12 && now - ap.last > 6.5 * DAY) await postTip();
}

async function remindExpiring() {
  const now = Date.now();
  const { data } = await admin.from('subscriptions').select('user_id, pro_until, auto_renew, pay_method, reminded_for')
    .gt('pro_until', new Date(now).toISOString()).lte('pro_until', new Date(now + 3 * DAY).toISOString());
  for (const s of (data ?? []) as NonNullable<Sub>[]) {
    if (s.reminded_for && Date.parse(s.reminded_for) === Date.parse(s.pro_until!)) continue;   // уже напоминали про этот срок
    if (s.auto_renew && !FREE_METHODS.includes(s.pay_method ?? '')) continue;                   // продлится сам
    const left = Math.max(1, Math.ceil((Date.parse(s.pro_until!) - now) / DAY));
    await notify(s.user_id, `⏳ <b>PRO закончится через ${left} ${left === 1 ? 'день' : 'дня'}</b> — ${date(s.pro_until)}.\n\nПродлите, чтобы сохранить историю без ограничений, контрагентов и Excel.`, openBtn('⭐ Продлить PRO'));
    await admin.from('subscriptions').update({ reminded_for: s.pro_until }).eq('user_id', s.user_id);
  }
}

Deno.serve(async (req) => {
  // Принимаем запросы только от Telegram и от расписания Supabase: оба присылают секрет, который мы задали
  if (!SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  if (update?.cron) { if (TOKEN && SERVICE) await tick().catch((e) => console.error('tick', e)); return new Response('ok'); }
  const isAdmin = (id?: number) => id === ADMIN_ID && !!SERVICE && !!TOKEN;
  // Оплата звёздами: проверка перед списанием и успешный платёж
  if (update?.pre_checkout_query) { await preCheckout(update.pre_checkout_query).catch((e) => console.error('precheckout', e)); return new Response('ok'); }
  if (update?.message?.successful_payment) { await paid(update.message).catch((e) => console.error('paid', e)); return new Response('ok'); }
  // Нажатие кнопки в админ-панели
  const cq = update?.callback_query;
  if (cq && /^l[gn]:/.test(cq.data ?? '') && SERVICE) { await loginAnswer(cq).catch((e) => console.error('login', e)); return new Response('ok'); }
  if (cq) {
    if (isAdmin(cq.from?.id)) await adminCallback(cq).catch(() => {});
    else await tg('answerCallbackQuery', { callback_query_id: cq.id });
    return new Response('ok');
  }
  const msg: Msg | undefined = update?.message;
  // Отвечаем только в личных чатах; на ошибки Telegram всё равно получает «ok», иначе будет слать повторно
  if (msg?.chat?.type === 'private' && TOKEN) {
    const text: string = msg.text ?? '';
    try {
      if (text.startsWith('/start login_') && SERVICE) { await loginPrompt(msg); return new Response('ok'); }
      if (isAdmin(msg.from?.id) && await adminMessage(msg)) return new Response('ok');
      if (text.startsWith('/start')) await send(msg.chat.id, WELCOME(esc((msg.from?.first_name ?? '').slice(0, 40))));
      else await send(msg.chat.id, HELP);
    } catch (_) { /* сеть Telegram недоступна — пропускаем */ }
  }
  return new Response('ok');
});
