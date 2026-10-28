// P2Pro — Telegram-бот @P2ProAppBot. Отвечает на /start и сообщения, открывает мини-апп.
// Работает как Edge Function в Supabase: Telegram присылает сюда каждое сообщение боту (webhook).
// Токен бота и секрет webhook хранятся в Supabase → Edge Functions → Secrets, в коде их нет.
// Для владельца (ADMIN_ID) бот — ещё и админ-панель (/admin). Остальным эти команды не отвечают.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? '';
const APP = 'https://p2pro.app/';
const SUPPORT = 'https://t.me/MVSR_P2P';
const ADMIN_ID = 6928515440;   // Telegram id владельца. Telegram присылает его сам — подделать нельзя
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const keyboard = {
  inline_keyboard: [
    [{ text: '🚀 Открыть P2Pro', web_app: { url: APP } }],
    [{ text: '💬 Поддержка', url: SUPPORT }],
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
  `Нажмите «Открыть P2Pro», чтобы начать. Это бесплатно.\n\n` +
  `💱 <b>Курс USDT</b> — карточка с курсом биржи прямо сейчас\n📊 <b>Мой день</b> и 📅 <b>Мой месяц</b> — ваша прибыль без открытия приложения`;

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
type Msg = { message_id: number; chat: { id: number; type: string }; from?: { id: number; first_name?: string; username?: string }; text?: string };
const kb = (rows: Btn[][]) => ({ inline_keyboard: rows });
const isPro = (s: Sub) => !!s?.pro_until && Date.parse(s.pro_until) > Date.now();
const isBanned = (u: AUser) => !!u.banned_until && Date.parse(u.banned_until) > Date.now();
const FREE_METHODS = ['gift', 'promo', 'trial'];
const STARS: Record<string, number> = { m: 350, y: 2650 };   // цены PRO в звёздах. Такие же — в telegram-auth и в приложении
const RUB: Record<string, number> = { m: 490, y: 3990 };     // цены PRO в рублях (оплата криптой на сайте). Такие же — в telegram-auth и в приложении
type Price = { m: number; y: number; rm: number; ry: number; custom: boolean };
// Цена для конкретного человека: персональная (11-prices.sql и 15-xrocket.sql, задаётся в карточке) или обычная
async function priceOf(userId: string): Promise<Price> {
  let { data, error } = await admin.from('custom_prices').select('m, y, rm, ry').eq('user_id', userId).maybeSingle();
  if (error) ({ data, error } = await admin.from('custom_prices').select('m, y').eq('user_id', userId).maybeSingle());   // 15-xrocket.sql ещё не запущен
  const d = !error && data ? data as { m: number; y: number; rm?: number | null; ry?: number | null } : null;
  return { m: d?.m ?? STARS.m, y: d?.y ?? STARS.y, rm: d?.rm || RUB.m, ry: d?.ry || RUB.y, custom: !!d };
}
const priceLine = (p: Price) => `${p.m} ⭐ / ${p.y} ⭐ · ${p.rm.toLocaleString('ru-RU')} ₽ / ${p.ry.toLocaleString('ru-RU')} ₽`;
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
  [{ text: '📢 Канал', callback_data: 'ch' }, { text: '💱 Курс в канал', callback_data: 'rc' }],
  [{ text: '⏰ Запланировано', callback_data: 'sl' }, { text: '🌅 Утренний отчёт', callback_data: 'rp' }],
  [{ text: '🔍 Поиск', callback_data: 'fs' }, { text: '🛡 Чёрный список', callback_data: 'bl:m' }],
  [{ text: '🖥 Веб-админка', callback_data: 'wa' }],
]);
const toMenu = (extra: Btn[] = []) => kb([[...extra, { text: '‹ Меню', callback_data: 'm' }]]);
const ADMIN_HELP = `<b>🛠 Админ-панель P2Pro</b>\n\nВыберите раздел. Чтобы найти пользователя, просто пришлите мне @ник, почту или Telegram id.\n\n` +
  `Команды: /stats, /user @ник, /give @ник 30, /revoke @ник, /promo КОД ДНИ [ЛИМИТ] [СРОК_ДНЕЙ], /price @ник МЕСЯЦ [ГОД], /pricerub @ник МЕСЯЦ [ГОД], /refund НОМЕР_ПЛАТЕЖА, /cancel`;

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
  return await rowsAll<NonNullable<Sub>>('subscriptions', 'user_id, pro_until, auto_renew, pay_method, payments', 'user_id');
}
const mskDay = (t: number) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
// Оплата в рублях (карта, СБП). Звёзды считаем отдельно, подарки и промокоды — не деньги
const realPay = (p: Pay) => +p.amount > 0 && !FREE_METHODS.includes(p.method ?? '') && p.method !== 'stars';
const cryptoPay = (p: Pay) => p.method === 'crypto' && +p.amount > 0;
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
  let rev = 0, pays = 0, stars = 0, starN = 0, cr = 0, crN = 0;
  for (const s of subs) for (const p of s.payments ?? []) {
    if (!mskDay(Date.parse(p.ts)).startsWith(month)) continue;
    if (realPay(p)) { rev += +p.amount; pays++; }
    if (cryptoPay(p)) { cr += +p.amount; crN++; }
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
    `⭐ PRO сейчас: <b>${pro.length}</b> (подарки, промокоды, пробный: ${gifts})\n` +
    `💰 Выручка за месяц: <b>${rev.toLocaleString('ru-RU')} ₽</b> · оплат: ${pays}${crN ? `\n   из них криптой: ${cr.toLocaleString('ru-RU')} ₽ · оплат: ${crN}` : ''}\n⭐ Звёздами за месяц: <b>${stars.toLocaleString('ru-RU')} ⭐</b> · оплат: ${starN}\n📒 Сделок в базе: ${trades ?? 0}\n\n` +
    `<b>Новые пользователи за 14 дней</b>\n<pre>${chart}</pre>`;
}

/* ---------- Пользователи ---------- */
async function listView(page: number) {
  const users = await allUsers(), pages = Math.max(1, Math.ceil(users.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const pro = new Set((await allSubs()).filter(isPro).map((x) => x.user_id));
  const tgs = await rowsAll<TgRow>('tg_users', 'user_id, tg_id, username', 'tg_id');
  const nicks = new Map(tgs.filter((x) => x.username).map((x) => [x.user_id, x.username as string]));
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
  // Подробности: когда последний раз что-то записывал, последние оплаты и подарки, промокоды, итоги дня
  const { data: last } = await admin.from('trades').select('updated_at').eq('user_id', u.id).order('updated_at', { ascending: false }).limit(1);
  const { data: promos } = await admin.from('promo_uses').select('code, used_at').eq('user_id', u.id);
  const { data: tgRow } = await admin.from('tg_users').select('daily_off').eq('user_id', u.id).maybeSingle();
  const PAY_NAME: Record<string, string> = { stars: 'звёзды', gift: 'подарок', promo: 'промокод', trial: 'пробный', card: 'карта', sbp: 'СБП', usdt: 'USDT', crypto: 'крипта' };
  const pays = (s?.payments ?? []).slice(0, 5).map((p) => `• ${date(p.ts)} · ${p.method === 'stars' ? `${p.amount} ⭐` : +p.amount ? `${(+p.amount).toLocaleString('ru-RU')} ₽` : `${p.days ?? ''} дн.`} · ${PAY_NAME[p.method ?? ''] ?? esc(p.method ?? '')}${(p as { paid?: string }).paid ? ` (${esc((p as { paid?: string }).paid!)})` : ''}${(p as { refund?: boolean }).refund ? ' (возврат)' : ''}`);
  const how = s?.pay_method === 'gift' ? ' (подарок)' : s?.pay_method === 'promo' ? ' (промокод)' : s?.pay_method === 'trial' ? ' (пробный)' : s?.pay_method === 'stars' ? ' (звёзды)' : s?.pay_method === 'crypto' ? ' (крипта)' : s?.auto_renew ? ' · автопродление' : '';
  const text = `<b>👤 Пользователь</b>\n\n${who(u)}\n` + (tgId ? `Telegram id: <code>${tgId}</code>\n` : '') +
    `Регистрация: ${date(u.created_at)}\nПоследний вход: ${date(u.last_sign_in_at)}\nСделок: ${trades ?? 0}${last?.[0] ? ` · последняя запись ${date(last[0].updated_at)}` : ''}\n` +
    (tgRow ? `Итоги дня: ${tgRow.daily_off ? 'отключены' : 'приходят'}\n` : '') + '\n' +
    (isPro(s) ? `⭐ PRO до <b>${date(s!.pro_until)}</b>${how}` : 'Тариф: Free') +
    `\n💲 Цена (месяц / год): ${priceLine(price)}${price.custom ? ' <b>(персональная)</b>' : ' (обычная)'}` +
    (pays.length ? `\n\n💳 <b>Оплаты и подарки</b>\n${pays.join('\n')}` : '') +
    (promos?.length ? `\n🎟 Промокоды: ${promos.map((p: { code: string }) => esc(p.code)).join(', ')}` : '') +
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
  const tgs = await rowsAll<TgRow>('tg_users', 'tg_id, user_id', 'tg_id');
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
    const g = p?.g ? await userById(String(p.g)) : null;   // подарок: кому
    if (q.currency === 'XTR' && u && (p?.p === 'm' || p?.p === 'y') && price![p.p as 'm' | 'y'] === q.total_amount && (!p?.g || g)) { ok = !isBanned(u); if (!ok) why = 'Аккаунт заблокирован — напишите в поддержку'; }
  } catch (_) { /* битый payload */ }
  await tg('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: why });
}
// Оплата прошла: выдаём PRO (один платёж — одна выдача) и сообщаем покупателю и владельцу
async function paid(msg: Msg & { successful_payment: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string } }) {
  const sp = msg.successful_payment;
  let p: { u?: string; p?: string; g?: string } = {};
  try { p = JSON.parse(sp.invoice_payload); } catch (_) { /* не наш счёт */ }
  const period = p.p === 'y' ? 'y' : 'm';
  // Подарок: PRO получает друг (g), платёж и возврат звёзд — у покупателя
  const { data, error } = await admin.rpc('stars_grant_pro', { p_user: p.g || p.u, p_period: period, p_charge: sp.telegram_payment_charge_id, p_stars: sp.total_amount, p_tg: msg.from?.id ?? null });
  if (error) {
    console.error('stars grant', error);
    await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', text: `⚠️ <b>Оплата звёздами не применилась</b>\n${sp.total_amount} ⭐ от ${msg.from?.id}\nПлатёж: <code>${esc(sp.telegram_payment_charge_id)}</code>\nОшибка: ${esc(error.message)}` });
    await send(msg.chat.id, 'Оплата получена, но PRO не включился автоматически. Мы уже разбираемся — напишите в поддержку, если PRO не появится в течение часа.', false);
    return;
  }
  if (!(data as { fresh: boolean }).fresh) return;   // Telegram прислал тот же платёж повторно
  const until = (data as { pro_until: string }).pro_until;
  const u = p.u ? await userById(p.u) : null, g = p.g ? await userById(p.g) : null;
  if (g) {
    await giftNotify(g.id, u, period, until);
    await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', reply_markup: openBtn(),
      text: `🎁 <b>Подарок отправлен!</b>\n\n${esc(nameOf(g))} получил P2Pro PRO ${period === 'y' ? 'на год' : 'на месяц'} — до <b>${date(until)}</b>. Мы сообщили ему в боте. Спасибо!` });
  } else await tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', reply_markup: openBtn(),
    text: `✅ <b>Оплата прошла!</b>\n\nP2Pro PRO ${period === 'y' ? 'на год' : 'на месяц'} — действует до <b>${date(until)}</b>. Спасибо!` });
  await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML',
    text: `💰 <b>Оплата ${sp.total_amount} ⭐</b>${g ? ' · 🎁 подарок' : ''}\nPRO · ${period === 'y' ? 'год' : 'месяц'}\n${u ? who(u) : esc(String(p.u))}${g ? `\n→ для ${who(g)}` : ''}\nПлатёж: <code>${esc(sp.telegram_payment_charge_id)}</code>` });
}
// Сообщение другу о подарке
async function giftNotify(toId: string, from: AUser | null, period: string, until: string) {
  // Ник дарителя — из tg_users (пишет только сервер): ник в профиле человек может подменить на чужой
  const nick = from ? await tgNick(from.id) : null;
  const fromName = from ? (nick ? '@' + nick : nameOf(from)) : 'Друг';
  return notify(toId, `🎁 <b>Вам подарили P2Pro PRO!</b>\n\n${esc(fromName)} подарил вам PRO ${period === 'y' ? 'на год' : 'на месяц'} — действует до <b>${date(until)}</b>.\n\nБезлимитная история, контрагенты, Excel, график и уведомления о курсе уже включены.`, openBtn('🚀 Открыть P2Pro'));
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
  return { text: `<b>💲 Цена PRO для</b> ${who(u)}\n\nСейчас (месяц / год): <b>${priceLine(p)}</b>${p.custom ? ' (персональная)' : ' (обычная)'}\n` +
    `Обычная: ${STARS.m} ⭐ / ${STARS.y} ⭐ · ${RUB.m} ₽ / ${RUB.y.toLocaleString('ru-RU')} ₽\n\n⭐ — оплата звёздами в Telegram, ₽ — оплата криптой (USDT по курсу) в приложении и на сайте.\n\n` +
    `Кнопка скидки меняет обе цены. Точная цена командой:\n<code>/price ${esc(contactOf(u))} 250 1900</code> — в звёздах\n<code>/pricerub ${esc(contactOf(u))} 350 2900</code> — в рублях\n(год можно не писать — посчитается с той же скидкой).\n\nЧеловек увидит новую цену в окне оплаты и получит сообщение, если цена ниже обычной.`,
    markup: kb([
      [10, 20, 30].map((d) => ({ text: `−${d}%`, callback_data: `ps:${id}:${d}:${back}` })),
      [40, 50, 70].map((d) => ({ text: `−${d}%`, callback_data: `ps:${id}:${d}:${back}` })),
      ...(p.custom ? [[{ text: '↩️ Вернуть обычную цену', callback_data: `px:${id}:${back}` }]] : []),
      [{ text: '‹ К карточке', callback_data: `u:${id}:${back}` }]]) };
}
// cur: 'stars' — цена в звёздах, 'rub' — в рублях. Вторая валюта остаётся как была
async function setPrice(u: AUser, m: number, y?: number, cur: 'stars' | 'rub' = 'stars') {
  const B = cur === 'rub' ? RUB : STARS, sign = cur === 'rub' ? ' ₽' : ' ⭐';
  y = y ?? Math.max(1, Math.round(m * B.y / B.m));   // год — с той же скидкой, что и месяц
  if (!Number.isInteger(m) || m < 1 || m > 100000 || !Number.isInteger(y) || y < 1 || y > 1000000) throw new Error(`Цена — целое число${sign} от 1`);
  const p = await priceOf(u.id);
  const row = cur === 'rub' ? { m: p.m, y: p.y, rm: m, ry: y } : { m, y };
  const { error } = await admin.from('custom_prices').upsert({ user_id: u.id, ...row, updated_at: new Date().toISOString() });
  if (error) throw error;
  const f = (v: number) => v.toLocaleString('ru-RU');
  const notified = m < B.m ? await notify(u.id, `🎁 <b>Персональная цена P2Pro PRO для вас</b>\n\n<s>${f(B.m)}</s> <b>${f(m)}${sign}</b> в месяц · <s>${f(B.y)}</s> <b>${f(y)}${sign}</b> в год` +
    (cur === 'rub' ? ' — при оплате криптовалютой (USDT).\n\nОткройте приложение: Профиль → «Подключить PRO» → «Крипта».' : '.\n\nОткройте приложение: Профиль → «Подключить PRO».'),
    openBtn(cur === 'rub' ? '💎 Подключить PRO' : '⭐ Подключить PRO')) : false;
  return { m, y, notified };
}
// Скидка кнопкой: сразу и в звёздах, и в рублях, одним сообщением человеку
async function setDiscount(u: AUser, d: number) {
  const k = (v: number) => Math.max(1, Math.round(v * (1 - d / 100))), r = { m: k(STARS.m), y: k(STARS.y), rm: k(RUB.m), ry: k(RUB.y) };
  const { error } = await admin.from('custom_prices').upsert({ user_id: u.id, ...r, updated_at: new Date().toISOString() });
  if (error) {   // 15-xrocket.sql ещё не запущен — меняем только звёзды
    const s = await setPrice(u, r.m, r.y);
    return { ...r, rm: RUB.m, ry: RUB.y, notified: s.notified };
  }
  const notified = await notify(u.id, `🎁 <b>Персональная скидка ${d}% на P2Pro PRO</b>\n\n` +
    `В Telegram (звёзды): <s>${STARS.m}</s> <b>${r.m} ⭐</b> в месяц · <s>${STARS.y}</s> <b>${r.y} ⭐</b> в год\n` +
    `Криптой (USDT): <s>${RUB.m} ₽</s> <b>${r.rm} ₽</b> · <s>${RUB.y.toLocaleString('ru-RU')} ₽</s> <b>${r.ry.toLocaleString('ru-RU')} ₽</b>\n\nОткройте приложение: Профиль → «Подключить PRO».`, openBtn('⭐ Подключить PRO'));
  return { ...r, notified };
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

/* ---------- Итоги дня (14-daily.sql) ---------- */
// В 23:59 МСК расписание будит бота ({cron:'daily'}): он находит всех, у кого сегодня были сделки, и для каждого
// вызывает сам себя ({daily_user}) — каждая карточка рисуется в отдельном запуске, чтобы хватило ресурсов.
// Команда /itogi присылает итоги прямо сейчас. Карточка — PNG из SVG (resvg), шрифты лежат на сайте в /fonts
const CUR: Record<string, string> = { RUB: '₽', USD: '$' };
const money = (v: number, cur: string, dec = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('ru-RU', { minimumFractionDigits: dec, maximumFractionDigits: dec })} ${CUR[cur] ?? cur}`;
const plural = (n: number, a: string, b: string, c: string) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
type DayTrade = { ts: string; data: { profit?: number; sum?: number; cur?: string; ex?: string; bank?: string } };

async function daySummary(userId: string, day: string) {
  const start = Date.parse(day + 'T00:00:00+03:00');
  const { data } = await admin.from('trades').select('ts, data').eq('user_id', userId).eq('deleted', false)
    .gte('ts', new Date(start).toISOString()).lt('ts', new Date(start + DAY).toISOString());
  const list = ((data ?? []) as DayTrade[]).filter((t) => t.data && isFinite(+t.data.profit!));
  if (!list.length) return null;
  // Основная валюта — в которой больше всего сделок; остальные покажем строкой ниже
  const byCur = new Map<string, DayTrade[]>();
  for (const t of list) { const c = t.data.cur || 'RUB'; byCur.set(c, [...(byCur.get(c) ?? []), t]); }
  const [cur, main] = [...byCur.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const profit = main.reduce((a, t) => a + (+t.data.profit! || 0), 0), turnover = main.reduce((a, t) => a + (+t.data.sum! || 0), 0);
  const best = Math.max(...main.map((t) => +t.data.profit! || 0));
  const count = (k: (t: DayTrade) => string) => { const m = new Map<string, number>(); for (const t of list) { const v = k(t); if (v) m.set(v, (m.get(v) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const exes = count((t) => t.data.ex ?? '').map((e) => e[0]);
  const pair = count((t) => [t.data.ex, t.data.bank].filter(Boolean).join(' · '))[0];
  const others = [...byCur.entries()].filter(([c]) => c !== cur).map(([c, l]) => money(l.reduce((a, t) => a + (+t.data.profit! || 0), 0), c));
  const { data: prof } = await admin.from('profiles').select('settings').eq('id', userId).maybeSingle();
  const goal = cur === 'RUB' ? +(prof?.settings?.goal ?? 0) || 0 : 0;
  return { n: list.length, cur, profit, turnover, best, exes, pair, others, goal, rateOff: !!prof?.settings?.rateOff };
}
// Биржевой курс USDT в рублях на конец дня — с биржи xRocket (тот же, что в калькуляторе). Не ответила — без курса
async function usdtRate(): Promise<{ rate: number; ch: number } | null> {
  try {
    const j = await fetch('https://exchange.api.xrocket.exchange/api/v1/rates?base=RUB', { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const rate = +j?.USDT?.rate;
    return rate > 0 ? { rate, ch: +j.USDT.rateChangePercent24h || 0 } : null;
  } catch (_) { return null; }
}
const rub2 = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let rsv: Promise<{ Resvg: new (svg: string, o: unknown) => { render(): { asPng(): Uint8Array } }; fonts: Uint8Array[] }> | null = null;
function renderer() {
  return rsv ??= (async () => {
    const m = await import('npm:@resvg/resvg-wasm@2.6.2');
    await m.initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm'));
    const fonts = await Promise.all(['Unbounded-800', 'Onest-400', 'Onest-600', 'JetBrainsMono-600'].map((f) =>
      fetch(`${APP}fonts/${f}.ttf`).then((r) => { if (!r.ok) throw new Error('font ' + f); return r.arrayBuffer(); }).then((b) => new Uint8Array(b))));
    return { Resvg: m.Resvg, fonts };
  })().catch((e) => { rsv = null; throw e; });
}

function dayCardSvg(d: { pro: boolean; date: string; rate: string; title: string; big: string; pos: boolean; sub: string; count: string; turnover: string; best: string; goalLabel: string; goal: string; pair: string }) {
  const W = 1080, H = 1350, x = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const col = d.pos ? '#3CD38A' : '#FF6B6B', bw = (W - 220) / 2;
  const box = (bx: number, by: number, w: number, label: string, value: string) => `<rect x="${bx}" y="${by}" width="${w}" height="150" rx="26" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".08"/>
    <text x="${bx + 34}" y="${by + 54}" font-family="Onest" font-size="28" fill="#8691A2">${x(label)}</text>
    <text x="${bx + 34}" y="${by + 112}" font-family="JetBrains Mono" font-weight="600" font-size="40" fill="#E8ECF2">${x(value)}</text>`;
  let grid = '', wm = '';
  for (let i = 1; i < 12; i++) grid += `<line x1="${i * 90}" y1="0" x2="${i * 90}" y2="${H}" stroke="#fff" stroke-opacity=".025"/>`;
  for (let i = 1; i < 15; i++) grid += `<line x1="0" y1="${i * 90}" x2="${W}" y2="${i * 90}" stroke="#fff" stroke-opacity=".025"/>`;
  if (!d.pro) for (let k = -4; k <= 4; k++) wm += `<text x="0" y="${k * 260}" text-anchor="middle" font-family="Unbounded" font-weight="800" font-size="110" fill="#fff" fill-opacity=".065">P2Pro · FREE</text>`;
  const bigSize = Math.min(136, Math.floor(880 / (d.big.length * 0.74)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="g1" cx="22%" cy="16%" r="60%"><stop offset="0" stop-color="#F2B54B" stop-opacity=".22"/><stop offset="1" stop-color="#F2B54B" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="90%" cy="85%" r="55%"><stop offset="0" stop-color="${col}" stop-opacity=".14"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="#0C0F14"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>${grid}
  <rect x="100" y="100" width="120" height="120" rx="32" fill="#F2B54B"/>
  <text x="160" y="172" text-anchor="middle" font-family="Unbounded" font-weight="800" font-size="46" fill="#1B1405">P2</text>
  <text x="160" y="200" text-anchor="middle" font-family="Unbounded" font-weight="800" font-size="15" letter-spacing="5" fill="#1B1405">PRO</text>
  <text x="250" y="160" font-family="Unbounded" font-weight="800" font-size="48" fill="#E8ECF2">P2Pro</text>
  <text x="250" y="202" font-family="Onest" font-size="28" fill="#8691A2">Учёт P2P-сделок</text>
  <text x="${W - 100}" y="${d.rate ? 152 : 168}" text-anchor="end" font-family="Onest" font-size="28" fill="#8691A2">${x(d.date)}</text>
  ${d.rate ? `<text x="${W - 100}" y="198" text-anchor="end" font-family="JetBrains Mono" font-weight="600" font-size="24" fill="#8691A2">${x(d.rate)}</text>` : ''}
  <text x="100" y="360" font-family="Onest" font-weight="600" font-size="30" letter-spacing="9" fill="#F2B54B">ИТОГИ ДНЯ</text>
  <text x="100" y="430" font-family="Unbounded" font-weight="800" font-size="46" fill="#E8ECF2">${x(d.title)}</text>
  <text x="96" y="580" font-family="Unbounded" font-weight="800" font-size="${bigSize}" fill="${col}">${x(d.big)}</text>
  <text x="100" y="644" font-family="Onest" font-size="32" fill="#8691A2">${x(d.sub)}</text>
  ${box(100, 700, bw, 'Сделок', d.count)}${box(120 + bw, 700, bw, 'Оборот', d.turnover)}
  ${box(100, 870, bw, 'Лучшая сделка', d.best)}${box(120 + bw, 870, bw, d.goalLabel, d.goal)}
  ${box(100, 1040, W - 200, 'Чаще всего', d.pair)}
  <line x1="100" y1="${H - 140}" x2="${W - 100}" y2="${H - 140}" stroke="#fff" stroke-opacity=".1"/>
  <text x="100" y="${H - 84}" font-family="Onest" font-size="30" fill="#8691A2">Посчитано в P2Pro</text>
  <text x="${W - 100}" y="${H - 84}" text-anchor="end" font-family="Onest" font-weight="600" font-size="30" fill="#F2B54B">@P2ProAppBot</text>
  <g transform="translate(${W / 2} ${H / 2}) rotate(-26)">${wm}</g></svg>`;
}

const dayButtons = (off: boolean) => kb([[{ text: '🚀 Открыть P2Pro', web_app: { url: APP } }],
  [off ? { text: '🔔 Присылать итоги каждый день', callback_data: 'don' } : { text: '🔕 Не присылать итоги', callback_data: 'doff' }]]);

// Итоги дня одному человеку. manual — по команде /itogi: присылаем, даже если итоги отключены, и отвечаем, когда сделок нет
async function dailySend(userId: string, day: string, manual = false) {
  const { data: t } = await admin.from('tg_users').select('tg_id, daily_off').eq('user_id', userId).maybeSingle();
  if (!t?.tg_id || (t.daily_off && !manual)) return;
  const d = await daySummary(userId, day);
  const dateLong = new Date(Date.parse(day + 'T12:00:00+03:00')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
  if (!d) {
    if (manual) await tg('sendMessage', { chat_id: t.tg_id, text: `📊 Сегодня (${dateLong}) сделок пока нет.\n\nЗапишите сделку в P2Pro — итоги дня придут в 23:59.`, reply_markup: dayButtons(!!t.daily_off) });
    return;
  }
  const pro = isPro(await subOf(userId)), avg = d.profit / d.n, xr = d.rateOff ? null : await usdtRate();
  const pct = d.turnover ? d.profit / d.turnover * 100 : 0, goalPct = d.goal ? Math.round(d.profit / d.goal * 100) : 0;
  const title = `${d.n} ${plural(d.n, 'сделка', 'сделки', 'сделок')}${d.exes.length ? ' · ' + d.exes.slice(0, 2).join(', ') : ''}`.slice(0, 34);
  const text = `📊 <b>Итоги дня · ${dateLong}</b>\n\n` +
    `💰 Прибыль: <b>${money(d.profit, d.cur)}</b>${d.others.length ? ` (и ${d.others.join(', ')})` : ''}\n` +
    `🔁 Сделок: ${d.n} · оборот ${Math.round(d.turnover).toLocaleString('ru-RU')} ${CUR[d.cur] ?? d.cur}\n` +
    `🏆 Лучшая сделка: ${money(d.best, d.cur)}\n` +
    (d.goal ? `🎯 Цель ${d.goal.toLocaleString('ru-RU')} ₽: ${goalPct >= 100 ? `выполнена на ${goalPct}% ✅` : `${goalPct}%`}\n` : '') +
    (d.pair ? `🔥 Чаще всего: ${esc(d.pair[0])} (${d.pair[1]})\n` : '') +
    (xr ? `💱 Курс USDT на конец дня: ${rub2(xr.rate)} ₽ (${xr.ch >= 0 ? '+' : '−'}${rub2(Math.abs(xr.ch))}% за сутки) · биржа xRocket\n` : '') +
    (pro ? '' : `\n<i>Карточка без водяного знака — в PRO.</i>`);
  let png: Uint8Array | null = null;
  try {
    const r = await renderer();
    const svg = dayCardSvg({ pro, date: dateLong, rate: xr ? `USDT ${rub2(xr.rate)} ₽ · xRocket` : '', title, big: money(d.profit, d.cur), pos: d.profit >= 0,
      sub: `${pct >= 0 ? '+' : ''}${pct.toFixed(2).replace('.', ',')}% к обороту · средняя ${money(avg, d.cur)}`,
      count: String(d.n), turnover: `${Math.round(d.turnover).toLocaleString('ru-RU')} ${CUR[d.cur] ?? d.cur}`, best: money(d.best, d.cur, 0),
      goalLabel: d.goal ? `Цель ${d.goal.toLocaleString('ru-RU')} ₽` : 'Средняя сделка', goal: d.goal ? `${goalPct}%${goalPct >= 100 ? ' ✓' : ''}` : money(avg, d.cur, 0),
      pair: d.pair ? `${d.pair[0]} · ${d.pair[1]} ${plural(d.pair[1], 'раз', 'раза', 'раз')}`.slice(0, 40) : '—' });
    png = new r.Resvg(svg, { font: { fontBuffers: r.fonts, defaultFontFamily: 'Onest', loadSystemFonts: false }, fitTo: { mode: 'width', value: 1080 } }).render().asPng();
  } catch (e) { console.error('day card', e); }
  if (png) {
    const fd = new FormData();
    fd.append('chat_id', String(t.tg_id)); fd.append('caption', text); fd.append('parse_mode', 'HTML');
    fd.append('reply_markup', JSON.stringify(dayButtons(!!t.daily_off)));
    fd.append('photo', new Blob([png], { type: 'image/png' }), `P2Pro-${day}.png`);
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd }).then((x) => x.json()).catch(() => null);
    if (r?.ok) return;
  }
  await tg('sendMessage', { chat_id: t.tg_id, text, parse_mode: 'HTML', reply_markup: dayButtons(!!t.daily_off) });   // картинка не вышла — хотя бы текст
}

async function dailyFanout() {
  const day = mskDay(Date.now()), start = Date.parse(day + 'T00:00:00+03:00');
  const { data: rows } = await admin.from('trades').select('user_id').eq('deleted', false)
    .gte('ts', new Date(start).toISOString()).lt('ts', new Date(start + DAY).toISOString());
  const withTrades = new Set((rows ?? []).map((r: { user_id: string }) => r.user_id));
  const tgs = await rowsAll<{ user_id: string; daily_off: boolean | null }>('tg_users', 'user_id, daily_off', 'tg_id');
  const banned = new Set((await allUsers()).filter(isBanned).map((u) => u.id));
  const ids = tgs.filter((t) => withTrades.has(t.user_id) && !t.daily_off && !banned.has(t.user_id)).map((t) => t.user_id);
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map((uid: string) => fetch(`${SB_URL}/functions/v1/telegram-bot`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify({ daily_user: uid, day }) }).catch(() => {})));
  }
}

async function dailyToggle(cq: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number }; message_id: number } }) {
  const off = cq.data === 'doff';
  await admin.from('tg_users').update({ daily_off: off }).eq('tg_id', cq.from.id);
  if (cq.message) await tg('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: dayButtons(off) });
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: off ? 'Итоги дня больше не придут. Получить вручную: /itogi' : 'Итоги будут приходить каждый день в 23:59' });
}

/* ---------- Курс USDT: история, уведомления (16-rate-gifts.sql) и карточка в канал ---------- */
// Раз в 10 минут: записываем курс (для графика в приложении) и проверяем уведомления «выше / ниже»
async function rateTick(now: number) {
  const r = await usdtRate(); if (!r) return;
  await admin.from('rate_history').insert({ usdt: r.rate }).then(() => {}, () => {});
  await admin.from('rate_history').delete().lt('ts', new Date(now - 8 * DAY).toISOString()).then(() => {}, () => {});
  const { data: al } = await admin.from('rate_alerts').select('id, user_id, dir, price').is('fired_at', null);
  for (const a of (al ?? []) as { id: number; user_id: string; dir: string; price: number }[]) {
    if (a.dir === 'above' ? r.rate < +a.price : r.rate > +a.price) continue;
    if (!isPro(await subOf(a.user_id))) continue;   // уведомления — в PRO; закончится PRO — подождут продления
    const { data: upd } = await admin.from('rate_alerts').update({ fired_at: new Date(now).toISOString() }).eq('id', a.id).is('fired_at', null).select('id');
    if (!upd?.length) continue;   // уже сработало в параллельном запуске
    await notify(a.user_id, `🔔 <b>Курс USDT ${a.dir === 'above' ? 'выше' : 'ниже'} ${rub2(+a.price)} ₽</b>\n\nСейчас на бирже xRocket: <b>${rub2(r.rate)} ₽</b> (${r.ch >= 0 ? '+' : '−'}${rub2(Math.abs(r.ch))}% за сутки).\n\nНовое уведомление можно поставить в P2Pro: калькулятор → строка курса.`, openBtn('💱 Открыть P2Pro'));
  }
}
type RatePost = { on: boolean; times: number[]; done: Record<string, string> };   // times — часы по МСК; done — в какой день час уже опубликован
const RP_DEF: RatePost = { on: false, times: [10, 20], done: {} };
const RP_HOURS = [8, 9, 10, 12, 14, 16, 18, 20, 22];
const RP_FIATS: [string, string, string][] = [['KZT', 'Тенге', '₸'], ['UAH', 'Гривна', '₴'], ['BYN', 'Бел. рубль', 'Br'], ['EUR', 'Евро', '€'], ['KGS', 'Сом', 'с'], ['UZS', 'Сум', 'сум']];
async function fiatRate(base: string) {
  try { const j = await fetch(`https://exchange.api.xrocket.exchange/api/v1/rates?base=${base}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()); return +j?.USDT?.rate || 0; }
  catch (_) { return 0; }
}
function rateCardSvg(d: { when: string; rate: string; ch: number; hist: number[]; fiats: { name: string; v: string }[] }) {
  const W = 1080, H = 1080, x = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const up = d.ch >= 0, col = up ? '#3CD38A' : '#FF6B6B';
  let chart = '';
  if (d.hist.length > 2) {
    const lo = Math.min(...d.hist), hi = Math.max(...d.hist), pad = (hi - lo) * .15 || .05, cw = W - 200, ch = 170, y0 = 470;
    const pts = d.hist.map((v, i) => `${(100 + i / (d.hist.length - 1) * cw).toFixed(1)},${(y0 + ch - (v - lo + pad) / (hi - lo + 2 * pad) * ch).toFixed(1)}`);
    chart = `<path d="M${pts.join(' L')} L${100 + cw},${y0 + ch} L100,${y0 + ch}Z" fill="url(#cg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${pts[pts.length - 1].split(',')[0]}" cy="${pts[pts.length - 1].split(',')[1]}" r="10" fill="${col}"/>
      <text x="100" y="${y0 + ch + 44}" font-family="Onest" font-size="26" fill="#8691A2">24 часа назад</text><text x="${W - 100}" y="${y0 + ch + 44}" text-anchor="end" font-family="Onest" font-size="26" fill="#8691A2">сейчас</text>`;
  }
  const cell = (i: number, f: { name: string; v: string }) => { const cx = 100 + (i % 3) * 300, cy = 770 + Math.floor(i / 3) * 120;
    return `<rect x="${cx}" y="${cy}" width="280" height="104" rx="22" fill="#fff" fill-opacity=".045" stroke="#fff" stroke-opacity=".08"/>
      <text x="${cx + 26}" y="${cy + 40}" font-family="Onest" font-size="24" fill="#8691A2">${x(f.name)}</text>
      <text x="${cx + 26}" y="${cy + 82}" font-family="Onest" font-weight="600" font-size="34" fill="#E8ECF2">${x(f.v)}</text>`; };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="g1" cx="20%" cy="12%" r="60%"><stop offset="0" stop-color="#F2B54B" stop-opacity=".22"/><stop offset="1" stop-color="#F2B54B" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="88%" cy="55%" r="50%"><stop offset="0" stop-color="${col}" stop-opacity=".13"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>
    <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".3"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="#0C0F14"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
  <rect x="100" y="90" width="100" height="100" rx="28" fill="#F2B54B"/>
  <text x="150" y="150" text-anchor="middle" font-family="Unbounded" font-weight="800" font-size="38" fill="#1B1405">P2</text>
  <text x="150" y="174" text-anchor="middle" font-family="Unbounded" font-weight="800" font-size="13" letter-spacing="4" fill="#1B1405">PRO</text>
  <text x="226" y="138" font-family="Unbounded" font-weight="800" font-size="40" fill="#E8ECF2">Курс USDT</text>
  <text x="226" y="178" font-family="Onest" font-size="26" fill="#8691A2">${x(d.when)}</text>
  <text x="100" y="300" font-family="Onest" font-weight="600" font-size="28" letter-spacing="8" fill="#F2B54B">USDT → РУБЛЬ</text>
  <text x="94" y="420" font-family="Unbounded" font-weight="800" font-size="120" fill="#E8ECF2">${x(d.rate)}</text>
  <rect x="${W - 330}" y="345" width="230" height="64" rx="32" fill="${col}" fill-opacity=".14"/>
  <text x="${W - 215}" y="388" text-anchor="middle" font-family="JetBrains Mono" font-weight="600" font-size="30" fill="${col}">${up ? '▲' : '▼'} ${x(rub2(Math.abs(d.ch)))}%</text>
  ${chart}
  ${d.fiats.map((f, i) => cell(i, f)).join('')}
  <text x="100" y="${H - 50}" font-family="Onest" font-size="26" fill="#8691A2">Биржа xRocket · за 1 USDT</text>
  <text x="${W - 100}" y="${H - 50}" text-anchor="end" font-family="Onest" font-weight="600" font-size="26" fill="#F2B54B">@P2ProAppBot</text></svg>`;
}
// Карточка курса: в канал (chat = CHANNEL) или владельцу для предпросмотра. Рисуется в отдельном запуске функции
async function ratePost(chat: number | string, btn?: Btn) {
  const main = await usdtRate(); if (!main) return false;
  const vals = await Promise.all(RP_FIATS.map(([c]) => fiatRate(c)));
  const { data: hist } = await admin.from('rate_history').select('usdt').gte('ts', new Date(Date.now() - DAY).toISOString()).order('ts');
  const now = new Date();
  const when = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) + ', ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) + ' МСК';
  const fiats = RP_FIATS.map(([, name, sym], i) => ({ name, v: vals[i] ? `${vals[i] >= 1000 ? Math.round(vals[i]).toLocaleString('ru-RU') : rub2(vals[i])} ${sym}` : '—' }));
  const caption = `💱 <b>Курс USDT · ${esc(when)}</b>\n\n🇷🇺 <b>${rub2(main.rate)} ₽</b> (${main.ch >= 0 ? '+' : '−'}${rub2(Math.abs(main.ch))}% за сутки)\n` +
    RP_FIATS.map(([, name], i) => vals[i] ? `${name}: ${fiats[i].v}` : '').filter(Boolean).join(' · ') +
    `\n\nБиржа xRocket. Считайте P2P-сделки в P2Pro — бесплатно.`;
  const markup = kb([[btn ?? { text: '🚀 Открыть P2Pro', url: BOT_LINK }]]);
  try {
    const r = await renderer();
    const svg = rateCardSvg({ when, rate: `${rub2(main.rate)} ₽`, ch: main.ch, hist: ((hist ?? []) as { usdt: number }[]).map((h) => +h.usdt), fiats });
    const png = new r.Resvg(svg, { font: { fontBuffers: r.fonts, defaultFontFamily: 'Onest', loadSystemFonts: false }, fitTo: { mode: 'width', value: 1080 } }).render().asPng();
    const fd = new FormData();
    fd.append('chat_id', String(chat)); fd.append('caption', caption); fd.append('parse_mode', 'HTML'); fd.append('reply_markup', JSON.stringify(markup));
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'P2Pro-rate.png');
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd }).then((x) => x.json()).catch(() => null);
    if (res?.ok) return true;
    console.error('rate post', res);
  } catch (e) { console.error('rate card', e); }
  const t = await tg('sendMessage', { chat_id: chat, text: caption, parse_mode: 'HTML', reply_markup: markup });   // картинка не вышла — хотя бы текст
  return !!t?.ok;
}
const selfCall = (body: unknown) => fetch(`${SB_URL}/functions/v1/telegram-bot`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(body) }).then((r) => r.text()).catch(() => '');
async function rcMenu() {
  const rp = await stGet<RatePost>('ratepost', RP_DEF);
  const hh = (h: number) => String(h).padStart(2, '0') + ':00';
  return { text: `<b>💱 Курс в канал ${CHANNEL}</b>\n\nБот сам рисует карточку: курс USDT в рублях, изменение и график за сутки, тенге, гривна, бел. рубль, евро, сом и сум. Под постом — кнопка P2Pro.\n\n` +
    `Автопубликация: <b>${rp.on ? 'включена' : 'выключена'}</b>\nВремя (МСК): <b>${rp.times.length ? [...rp.times].sort((a, b) => a - b).map(hh).join(', ') : 'не выбрано'}</b>\n\nНажмите на час, чтобы добавить или убрать его.`, markup: kb([
    [{ text: rp.on ? '⏸ Выключить' : '▶️ Включить', callback_data: 'rct' }],
    RP_HOURS.slice(0, 5).map((h) => ({ text: (rp.times.includes(h) ? '✅ ' : '') + hh(h), callback_data: `rch:${h}` })),
    RP_HOURS.slice(5).map((h) => ({ text: (rp.times.includes(h) ? '✅ ' : '') + hh(h), callback_data: `rch:${h}` })),
    [{ text: '👁 Прислать мне', callback_data: 'rcp' }, { text: '📤 Опубликовать сейчас', callback_data: 'rcn' }],
    [{ text: '‹ Меню', callback_data: 'm' }]]) };
}

/* ---------- Отложенные рассылки и посты ---------- */
type Sched = { id: string; kind: string; aud?: Aud; chat: number; mid: number; at: number };
const whenText = (t: number) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) + ' МСК';
// «18:30» — сегодня (или завтра, если уже прошло), «25.10 10:00» — в этот день. Время московское
function parseWhen(t: string): number | null {
  const m = t.trim().match(/^(?:(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+)?(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const now = Date.now(), msk = new Date(now + 3 * 3600e3), h = +m[4], mi = +m[5];
  const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : msk.getUTCFullYear(), mo = m[2] ? +m[2] - 1 : msk.getUTCMonth(), d = m[1] ? +m[1] : msk.getUTCDate();
  if (h > 23 || mi > 59 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  let at = Date.UTC(y, mo, d, h, mi) - 3 * 3600e3;
  if (new Date(at + 3 * 3600e3).getUTCDate() !== d) return null;   // 31.02 и подобные — нет такой даты
  if (!m[1] && at <= now) at += DAY;
  return at > now && at - now < 60 * DAY ? at : null;
}
async function schedList() {
  const list = (await stGet<Sched[]>('sched', [])).sort((a, b) => a.at - b.at);
  const what = (s: Sched) => s.kind === 'post' ? `пост в ${CHANNEL}` : `рассылка ${AUD[s.aud ?? 'all']}`;
  return { text: `<b>⏰ Запланировано</b>\n\n` + (list.length ? list.map((s) => `• ${whenText(s.at)} — ${what(s)}`).join('\n') + '\n\nНажмите, чтобы отменить. Отправка — с точностью до 10 минут.'
    : 'Пока ничего. Создайте рассылку или пост и нажмите «⏰ Запланировать».'), markup: kb([
    ...list.map((s) => [{ text: `✖ ${whenText(s.at)} · ${s.kind === 'post' ? 'пост' : 'рассылка'}`, callback_data: `sx:${s.id}` }]),
    [{ text: '‹ Меню', callback_data: 'm' }]]) };
}

/* ---------- Утренний отчёт владельцу ---------- */
async function morningReport() {
  const now = Date.now(), y = mskDay(now - DAY), start = Date.parse(y + 'T00:00:00+03:00'), end = start + DAY, inY = (t?: string | null) => !!t && Date.parse(t) >= start && Date.parse(t) < end;
  const users = await allUsers(), subs = await allSubs(), month = mskDay(now).slice(0, 7);
  let rub = 0, rubN = 0, cr = 0, crN = 0, st = 0, stN = 0, monthRub = 0;
  for (const s of subs) for (const p of s.payments ?? []) {
    if (realPay(p) && mskDay(Date.parse(p.ts)).startsWith(month)) monthRub += +p.amount;
    if (!inY(p.ts)) continue;
    if (cryptoPay(p)) { cr += +p.amount; crN++; } else if (realPay(p)) { rub += +p.amount; rubN++; }
    if (starPay(p)) { st += +p.amount; stN++; }
  }
  const pro = subs.filter(isPro), exp = pro.filter((s) => Date.parse(s.pro_until!) - now <= 3 * DAY).length;
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('deleted', false).gte('ts', new Date(start).toISOString()).lt('ts', new Date(end).toISOString());
  const fresh = users.filter((u) => inY(u.created_at)), active = users.filter((u) => inY(u.last_sign_in_at)).length, f = (v: number) => v.toLocaleString('ru-RU');
  await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', reply_markup: kb([[{ text: '📊 Статистика', callback_data: 'st' }, { text: '🌅 Настройки отчёта', callback_data: 'rp' }]]),
    text: `🌅 <b>Доброе утро! Итоги за ${date(start + 12 * 3600e3)}</b>\n\n` +
      `🆕 Новых пользователей: <b>${fresh.length}</b>${fresh.length ? '\n' + fresh.slice(0, 5).map(who).join('\n') + (fresh.length > 5 ? '\n…' : '') : ''}\n` +
      `🔑 Заходили: ${active} · 📒 Сделок записано: ${trades ?? 0}\n\n` +
      `💰 Оплаты: <b>${f(rub + cr)} ₽</b> (${rubN + crN} шт.)${crN ? ` · из них криптой ${f(cr)} ₽` : ''}\n⭐ Звёздами: <b>${f(st)} ⭐</b> (${stN} шт.)\n` +
      `📅 Выручка с начала месяца: <b>${f(monthRub)} ₽</b>\n\n⭐ PRO сейчас: ${pro.length}${exp ? ` · закончится за 3 дня: ${exp}` : ''}` });
}
async function rpMenu() {
  const rp = await stGet('report', { on: true, day: '' });
  return { text: `<b>🌅 Утренний отчёт</b>\n\nКаждое утро в 9:00 МСК: новые пользователи, кто заходил, сколько сделок, оплаты рублями, криптой и звёздами, выручка с начала месяца, у кого скоро закончится PRO.\n\nСейчас: <b>${rp.on ? 'включён' : 'выключен'}</b>`, markup: kb([
    [{ text: rp.on ? '⏸ Выключить' : '▶️ Включить', callback_data: 'rpt' }, { text: '📨 Прислать сейчас', callback_data: 'rpn' }],
    [{ text: '‹ Меню', callback_data: 'm' }]]) };
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
    if (!['ba', 'cp', 'go', 'no', 'nop', 'sq'].includes(k)) await stSet('await', null);
    if (k === 'm') { await stSet('await', null); await show(chatId, msgId, ADMIN_HELP, MENU()); }
    else if (k === 'wa') {   // одноразовый вход в админку (сайт или приложение «P2Pro Админ»): 5 минут, один раз
      const code = adminCode();
      await stSet('wa:' + code, { exp: Date.now() + 5 * 60e3 });
      await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🖥 <b>Вход в админку</b>\n\nКод для приложения «P2Pro Админ» (нажмите — скопируется):\n<code>${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}</code>\n\nИли откройте на сайте кнопкой ниже. Код и ссылка одноразовые, действуют 5 минут. Никому их не пересылайте.`,
        reply_markup: kb([[{ text: '🖥 Открыть на сайте', url: `${APP}admin#k=${code}` }]]) });
      toastText = 'Ссылка отправлена';
    }
    else if (k === 'bl') toastText = await blCallback(chatId, msgId, a, b, c);
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
    else if (k === 'no') { await stTake('draft'); await stSet('await', null); await show(chatId, msgId, 'Отменено.', toMenu()); }
    // отложить черновик: спрашиваем время
    else if (k === 'sq') {
      if (!await stGet('draft', null)) toastText = 'Уже отправлено или отменено';
      else { await stSet('await', { kind: 'when', at: Date.now() }); await show(chatId, msgId, '⏰ Когда отправить? Пришлите время по Москве:\n<code>18:30</code> — сегодня (или завтра, если уже прошло)\n<code>25.10 10:00</code> — в этот день', kb([[{ text: 'Отмена', callback_data: 'no' }]])); }
    }
    else if (k === 'sl') await view(await schedList());
    else if (k === 'sx') { const list = await stGet<Sched[]>('sched', []); await stSet('sched', list.filter((s) => s.id !== a)); toastText = 'Отменено'; await view(await schedList()); }
    // курс в канал
    else if (k === 'rc') await view(await rcMenu());
    else if (k === 'rct' || k === 'rch') {
      const rp = await stGet<RatePost>('ratepost', RP_DEF), day = mskDay(Date.now()), hour = new Date(Date.now() + 3 * 3600e3).getUTCHours();
      if (k === 'rct') rp.on = !rp.on;
      else { const h = Number(a); rp.times = rp.times.includes(h) ? rp.times.filter((x) => x !== h) : [...rp.times, h]; }
      // Уже прошедшие сегодня часы не публикуем задним числом
      for (const h of rp.times) if (h <= hour && rp.done[h] !== day) rp.done[h] = day;
      await stSet('ratepost', rp); toastText = k === 'rct' ? (rp.on ? 'Автопубликация включена' : 'Автопубликация выключена') : 'Сохранено';
      await view(await rcMenu());
    }
    else if (k === 'rcp' || k === 'rcn') { toastText = 'Рисую карточку…'; background(selfCall({ rate_post: k === 'rcn' ? 'channel' : 'admin' })); }
    // утренний отчёт
    else if (k === 'rp') await view(await rpMenu());
    else if (k === 'rpt') { const rp = await stGet('report', { on: true, day: '' }); await stSet('report', { ...rp, on: !rp.on }); toastText = rp.on ? 'Отчёт выключен' : 'Отчёт включён'; await view(await rpMenu()); }
    else if (k === 'rpn') { toastText = 'Собираю отчёт…'; background(morningReport()); }
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
      else if (k === 'ps') { const r = await setDiscount(u, Number(b)); toastText = `Цена: ${r.m} ⭐ · ${r.rm} ₽`; const v = await cardView(u, page); await show(chatId, msgId, v.text + (r.notified ? '\n\n📨 Пользователю отправлено сообщение о новой цене.' : ''), v.markup); }
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
/* ---------- Копия набора эмодзи/стикеров под своим названием ---------- */
// /copypack <ссылка t.me/addemoji/... или имя набора> [название]. Бот создаёт такой же набор на владельца,
// с чистым названием без чужих подписей. Файлы берутся с серверов Telegram, ничего не скачивается
type StSticker = { file_id: string; is_animated?: boolean; is_video?: boolean; emoji?: string; needs_repainting?: boolean };
async function copyPack(chatId: number, src: string, title: string) {
  // Ссылка может прийти со слэшем на конце или с названием через «/»: …/ИМЯ/P2Pro
  const [from, glued = ''] = src.replace(/^https?:\/\/t\.me\/(addemoji|addstickers)\//i, '').replace(/[?#].*$/, '').split('/');
  title = title.replace(/^ИМЯ\s*/i, '') || glued;
  if (!/^\w{1,64}$/.test(from)) return show(chatId, null, 'Пришлите так: <code>/copypack https://t.me/addemoji/ИМЯ P2Pro</code>\nПоследнее слово — название нового набора.', toMenu());
  const set = await tg('getStickerSet', { name: from });
  if (!set?.ok) return show(chatId, null, `Не нашёл набор <code>${esc(from)}</code>: ${esc(set?.description ?? 'нет ответа')}`, toMenu());
  const st = set.result as { title: string; sticker_type: string; stickers: StSticker[] };
  const me = await tg('getMe', {}); const bot = me?.result?.username ?? 'P2ProAppBot';
  const base = (title || st.title).replace(/@\w+/g, '').trim().slice(0, 64) || 'P2Pro';
  const fmt = (x: StSticker) => x.is_animated ? 'animated' : x.is_video ? 'video' : 'static';
  const input = (x: StSticker) => ({ sticker: x.file_id, format: fmt(x), emoji_list: [x.emoji || '⭐'] });
  const list = st.stickers;
  // Имя набора должно заканчиваться на _by_<бот>; если занято — добавляем цифру
  let name = '', res: { ok?: boolean; description?: string } | null = null;
  for (let k = 0; k < 5; k++) {
    name = `${base.toLowerCase().replace(/[^a-z0-9]/g, '') || 'pack'}${k ? k + 1 : ''}_by_${bot}`.slice(0, 64);
    res = await tg('createNewStickerSet', { user_id: ADMIN_ID, name, title: base, sticker_type: st.sticker_type,
      ...(st.sticker_type === 'custom_emoji' && list.some((x) => x.needs_repainting) ? { needs_repainting: true } : {}), stickers: list.slice(0, 50).map(input) });
    if (res?.ok || !/occupied|already/i.test(res?.description ?? '')) break;
  }
  if (!res?.ok) return show(chatId, null, `Не получилось создать набор: ${esc(res?.description ?? 'нет ответа')}`, toMenu());
  let fail = 0;
  for (const x of list.slice(50)) { const r = await tg('addStickerToSet', { user_id: ADMIN_ID, name, sticker: input(x) }); if (!r?.ok) fail++; }
  const link = `https://t.me/${st.sticker_type === 'custom_emoji' ? 'addemoji' : 'addstickers'}/${name}`;
  return show(chatId, null, `✅ Набор «${esc(base)}» готов: ${list.length - fail} из ${list.length}.\n${link}`, kb([[{ text: '➕ Открыть набор', url: link }], [{ text: '‹ Меню', callback_data: 'm' }]]));
}

async function adminMessage(msg: Msg): Promise<boolean> {
  const chatId = msg.chat.id, text = (msg.text ?? '').trim();
  const view0 = (v: { text: string; markup: unknown }) => show(chatId, null, v.text, v.markup);
  if (text.startsWith('/start')) return false;
  try {
    const aw = await stGet<{ kind: string; aud?: Aud; at: number; id?: number } | null>('await', null);
    // Чёрный список: своя причина отказа или свой тип нарушения — текстом
    if ((aw?.kind === 'blr' || aw?.kind === 'blk') && aw.id && Date.now() - aw.at < 60 * 60e3 && text && !text.startsWith('/')) {
      await stSet('await', null);
      if (aw.kind === 'blr') { await blDecide(aw.id, 'reject', { reason: text }); await show(chatId, null, `❌ Жалоба №${aw.id} отклонена: ${esc(text.slice(0, 300))}. Автор получил уведомление.`, toMenu()); }
      else { await blSetKind(aw.id, 'other', text); await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✏️ Жалоба №${aw.id}: тип — «${esc(text.slice(0, 60))}». Теперь одобрите или отклоните её:`, reply_markup: blKb(aw.id) }); }
      return true;
    }
    // Время для отложенной рассылки/поста
    if (aw?.kind === 'when' && Date.now() - aw.at < 60 * 60e3 && !text.startsWith('/')) {
      const at = parseWhen(text);
      if (!at) { await show(chatId, null, 'Не понял время. Пришлите так: <code>18:30</code> или <code>25.10 10:00</code> (по Москве, не дальше 60 дней).', kb([[{ text: 'Отмена', callback_data: 'no' }]])); return true; }
      await stSet('await', null);
      const d = await stTake<{ kind: string; aud?: Aud; chat: number; mid: number }>('draft');
      if (!d) { await show(chatId, null, 'Черновик уже отправлен или отменён.', toMenu()); return true; }
      const list = await stGet<Sched[]>('sched', []);
      list.push({ id: crypto.randomUUID().slice(0, 8), kind: d.kind, aud: d.aud, chat: d.chat, mid: d.mid, at });
      await stSet('sched', list);
      await show(chatId, null, `⏰ Запланировано на <b>${whenText(at)}</b>: ${d.kind === 'post' ? `пост в ${CHANNEL}` : `рассылка ${AUD[d.aud ?? 'all']}`}.\nНе удаляйте это сообщение из чата с ботом до отправки.`, kb([[{ text: '⏰ Запланировано', callback_data: 'sl' }, { text: '‹ Меню', callback_data: 'm' }]]));
      return true;
    }
    if (aw && aw.kind !== 'when' && Date.now() - aw.at < 60 * 60e3 && !text.startsWith('/')) {
      await stSet('await', null);
      await stSet('draft', { kind: aw.kind, aud: aw.aud, chat: chatId, mid: msg.message_id });
      const n = aw.kind === 'bc' ? (await recipients(aw.aud ?? 'all')).length : 0;
      await show(chatId, null, aw.kind === 'post' ? `Опубликовать это сообщение в ${CHANNEL}?` : `Отправить это сообщение <b>${AUD[aw.aud ?? 'all']}</b>? Получателей: <b>${n}</b>.`,
        kb([[{ text: aw.kind === 'post' ? '✅ Опубликовать' : `✅ Отправить (${n})`, callback_data: 'go' }], [{ text: '⏰ Запланировать', callback_data: 'sq' }, { text: 'Отмена', callback_data: 'no' }]]));
      return true;
    }
    if (!text) return false;
    const [cmd, a = '', b = ''] = text.split(/\s+/), args = text.split(/\s+/).slice(1);
    const c = cmd.toLowerCase().replace(/@\w+$/, '');
    if (c === '/basepost') { await blPost(chatId, true); return true; }
    if (c === '/copypack') { await copyPack(chatId, a, args.slice(1).join(' ')); return true; }
    if (c === '/admin') {
      await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: [
        { command: 'admin', description: 'Админ-панель' }, { command: 'stats', description: 'Статистика' }, { command: 'basepost', description: 'Пост-счётчик базы мошенников' },
        { command: 'user', description: 'Карточка: /user @ник' }, { command: 'give', description: 'Выдать PRO: /give @ник 30' },
        { command: 'revoke', description: 'Забрать PRO: /revoke @ник' }, { command: 'promo', description: 'Промокод: /promo КОД ДНИ' },
        { command: 'price', description: 'Цена в ⭐: /price @ник 250 1900' }, { command: 'pricerub', description: 'Цена в ₽: /pricerub @ник 350 2900' }, { command: 'refund', description: 'Возврат звёзд: /refund НОМЕР' }, { command: 'cancel', description: 'Отменить рассылку/пост' }, { command: 'start', description: 'Открыть P2Pro' } ] });
      await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть P2Pro' }, { command: 'itogi', description: 'Итоги дня прямо сейчас' }] });
      await stSet('await', null);
      await show(chatId, null, ADMIN_HELP, MENU());
    } else if (c === '/cancel') { await stSet('await', null); await stTake('draft'); await show(chatId, null, 'Отменено.', MENU()); }
    else if (c === '/stats') await show(chatId, null, await statsText(), toMenu([{ text: '🔄 Обновить', callback_data: 'st' }]));
    else if (c === '/promo') await show(chatId, null, await promoCreate(args), kb([[{ text: '🎟 Промокоды', callback_data: 'pl' }]]));
    else if (c === '/refund') await show(chatId, null, await refund(a), null);
    else if (c === '/price' || c === '/pricerub') {
      const rub = c === '/pricerub', sign = rub ? '₽' : '⭐';
      const u = a ? await findUser(a) : null, m = Number(b), y = args[2] ? Number(args[2]) : undefined;
      if (!u) await show(chatId, null, a ? NOT_FOUND : rub ? 'Напишите так: <code>/pricerub @ник 350 2900</code> — цена за месяц и за год в рублях (оплата криптой на сайте)' : 'Напишите так: <code>/price @ник 250 1900</code> — цена за месяц и за год в звёздах', null);
      else if (!b) await view0(await priceView(u, 0));
      else { const r = await setPrice(u, m, y, rub ? 'rub' : 'stars'); await show(chatId, null, `✅ ${who(u)}\nПерсональная цена: <b>${r.m} ${sign}</b> / <b>${r.y} ${sign}</b> в год.${r.notified ? '\n📨 Пользователю отправлено сообщение.' : ''}`, kb([[{ text: '👤 Карточка', callback_data: `u:${u.id}` }]])); }
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
      if (!realPay(p) || cryptoPay(p) || Date.parse(p.ts) <= since || Date.parse(p.ts) > Date.parse(nowIso)) continue;   // о звёздах и крипте сообщаем сразу при оплате
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
  await trialEnded().catch((e) => console.error('trial', e));
  // 3. Раз в неделю — совет в канал, если автопосты включены
  const ap = await stGet('autopost', { on: false, idx: 0, last: 0 });
  if (ap.on && hourMsk >= 12 && now - ap.last > 6.5 * DAY) await postTip();
  // 4. Курс: история для графика и уведомления «выше / ниже»
  await rateTick(now).catch((e) => console.error('rate tick', e));
  // 5. Карточка курса в канал по расписанию (рисуется в отдельном запуске)
  const rp = await stGet<RatePost>('ratepost', RP_DEF), today = mskDay(now);
  if (rp.on) {
    const due = rp.times.filter((h) => hourMsk >= h && hourMsk < h + 2 && rp.done[h] !== today);
    if (due.length) { due.forEach((h) => rp.done[h] = today); await stSet('ratepost', rp); await selfCall({ rate_post: 'channel' }); }
  }
  // 6. Отложенные рассылки и посты
  const sched = await stGet<Sched[]>('sched', []), dueS = sched.filter((s) => s.at <= now);
  if (dueS.length) {
    // Сначала убираем из списка (перечитав его — владелец мог только что что-то добавить): следующий запуск не отправит второй раз
    const sent = new Set(dueS.map((s) => s.id));
    await stSet('sched', (await stGet<Sched[]>('sched', [])).filter((s) => !sent.has(s.id)));
    for (const s of dueS) {
      if (s.kind === 'post') {
        const r = await tg('copyMessage', { chat_id: CHANNEL, from_chat_id: s.chat, message_id: s.mid, reply_markup: kb([[{ text: '🚀 Открыть P2Pro', url: BOT_LINK }]]) });
        await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', text: r?.ok ? `⏰ Отложенный пост опубликован в ${CHANNEL}.` : `⚠️ Отложенный пост не опубликован: ${esc(r?.description ?? 'нет ответа')}` });
      } else background(broadcast(s.chat, s.mid, s.aud ?? 'all'));
    }
  }
  // 7. Утренний отчёт владельцу в 9:00 МСК
  const rep = await stGet('report', { on: true, day: '' });
  if (rep.on && hourMsk >= 9 && rep.day !== today) { await stSet('report', { ...rep, day: today }); await morningReport().catch((e) => console.error('report', e)); }
  // 8. Возврат ушедших — раз в день после 12:00 МСК
  const wb = await stGet('winback', { day: '' });
  if (hourMsk >= 12 && wb.day !== today) { await stSet('winback', { day: today }); background(winback().catch((e) => console.error('winback', e))); }
}

// Пробный период закончился и PRO не купили — пишем один раз, с итогами недели
async function trialEnded() {
  const { data } = await admin.from('pro_trials').select('user_id, started_at, ends_at').eq('ended_sent', false).lt('ends_at', new Date().toISOString()).limit(50);
  for (const t of (data ?? []) as { user_id: string; started_at: string; ends_at: string }[]) {
    await admin.from('pro_trials').update({ ended_sent: true }).eq('user_id', t.user_id);
    const s = await subOf(t.user_id);
    if (!s || isPro(s)) continue;   // купил PRO — напоминать не о чем
    const { data: tr } = await admin.from('trades').select('data').eq('user_id', t.user_id).eq('deleted', false).gte('ts', t.started_at).lt('ts', t.ends_at);
    const rub = ((tr ?? []) as { data: { profit?: number; cur?: string } }[]).filter((x) => (x.data?.cur || 'RUB') === 'RUB' && isFinite(+x.data?.profit!));
    const sum = rub.reduce((a, x) => a + (+x.data.profit! || 0), 0);
    const stats = tr?.length ? `\n\nЗа эти 7 дней: ${tr.length} ${plural(tr.length, 'сделка', 'сделки', 'сделок')}${rub.length ? ` · прибыль ${money(sum, 'RUB')}` : ''}.` : '';
    await notify(t.user_id, `🎁 <b>Пробный PRO закончился</b>${stats}\n\nСделки сохранены, но в бесплатной версии история и аналитика видны только за последние 7 дней. Оформите PRO — и всё снова откроется: календарь прибыли, связки, контрагенты, график курса и Excel.`, openBtn('⭐ Оформить PRO'));
  }
}

async function remindExpiring() {
  const now = Date.now();
  const { data } = await admin.from('subscriptions').select('user_id, pro_until, auto_renew, pay_method, reminded_for')
    .gt('pro_until', new Date(now).toISOString()).lte('pro_until', new Date(now + 3 * DAY).toISOString());
  for (const s of (data ?? []) as NonNullable<Sub>[]) {
    if (s.reminded_for && Date.parse(s.reminded_for) === Date.parse(s.pro_until!)) continue;   // уже напоминали про этот срок
    if (s.auto_renew && !FREE_METHODS.includes(s.pay_method ?? '')) continue;                   // продлится сам
    const left = Math.max(1, Math.ceil((Date.parse(s.pro_until!) - now) / DAY));
    if (s.pay_method === 'trial') {   // пробный: напоминаем только накануне
      if (Date.parse(s.pro_until!) - now > 1.5 * DAY) continue;
      const when = mskDay(Date.parse(s.pro_until!)) === mskDay(now) ? 'Сегодня' : 'Завтра';
      await notify(s.user_id, `⏳ <b>${when} закончится пробный PRO</b> — ${date(s.pro_until)}.\n\nПотом история и аналитика будут только за последние 7 дней, а календарь прибыли, связки, контрагенты, график курса и Excel закроются. Оформите PRO, чтобы ничего не потерять.`, openBtn('⭐ Оформить PRO'));
    } else await notify(s.user_id, `⏳ <b>PRO закончится через ${left} ${left === 1 ? 'день' : 'дня'}</b> — ${date(s.pro_until)}.\n\nПродлите, чтобы сохранить историю без ограничений, контрагентов и Excel.`, openBtn('⭐ Продлить PRO'));
    await admin.from('subscriptions').update({ reminded_for: s.pro_until }).eq('user_id', s.user_id);
  }
}

/* ---------- Кнопки под /start: курс, мой день, мой месяц, PRO ---------- */
const appBtn = (text = '🚀 Открыть P2Pro', q = ''): Btn => ({ text, web_app: { url: APP + q } });
// Пробный PRO: показываем, если человек ещё не был в PRO и не брал пробный (проверяет и сервер при включении)
async function trialFree(userId: string | null, tgId: number) {
  const { data: tr } = await admin.from('pro_trials').select('user_id').eq('tg_id', tgId).limit(1);
  if (tr?.length) return false;
  if (!userId) return true;
  const s = await subOf(userId);
  return !s?.pro_until && !(s?.payments ?? []).length;
}
async function userOfTg(tgId: number): Promise<string | null> {
  const { data } = await admin.from('tg_users').select('user_id').eq('tg_id', tgId).maybeSingle();
  return data?.user_id ?? null;
}
async function startKb(tgId: number) {
  let pro: Btn = appBtn('🎁 7 дней PRO', '?trial=1');
  if (SERVICE) try {
    const uid = await userOfTg(tgId);
    if (!(await trialFree(uid, tgId))) pro = { text: '⭐ Мой PRO', callback_data: 'my:pro' };
  } catch (e) { console.error('start kb', e); }
  return kb([[appBtn()], [{ text: '💱 Курс USDT', callback_data: 'my:rate' }, { text: '📊 Мой день', callback_data: 'my:day' }],
    [{ text: '📅 Мой месяц', callback_data: 'my:month' }, pro], [{ text: '💬 Поддержка', url: SUPPORT }]]);
}
// Итоги месяца по Москве: прибыль, сделки, средняя за день, лучший день и сравнение с теми же днями прошлого месяца
async function monthText(userId: string) {
  const now = Date.now(), today = mskDay(now), [y, m, d] = today.split('-').map(Number);
  const start = Date.parse(`${today.slice(0, 7)}-01T00:00:00+03:00`);
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y, pStart = Date.parse(`${py}-${String(pm).padStart(2, '0')}-01T00:00:00+03:00`);
  const pDays = new Date(Date.UTC(py, pm, 0)).getUTCDate(), pEnd = pStart + Math.min(d, pDays) * DAY;   // те же числа прошлого месяца
  const { data } = await admin.from('trades').select('ts, data').eq('user_id', userId).eq('deleted', false).gte('ts', new Date(pStart).toISOString()).lt('ts', new Date(now + DAY).toISOString());
  const all = ((data ?? []) as DayTrade[]).filter((t) => t.data && isFinite(+t.data.profit!) && (t.data.cur || 'RUB') === 'RUB');
  const cur = all.filter((t) => Date.parse(t.ts) >= start), prev = all.filter((t) => Date.parse(t.ts) < pEnd && Date.parse(t.ts) >= pStart);
  const sum = (l: DayTrade[], k: 'profit' | 'sum') => l.reduce((a, t) => a + (+t.data[k]! || 0), 0);
  const MON = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MON_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
  const title = `📅 <b>${MON[m - 1][0].toUpperCase() + MON[m - 1].slice(1)} ${y}</b> · по ${d} число`;
  if (!cur.length) return `${title}\n\nВ этом месяце сделок в рублях пока нет. Запишите сделку в P2Pro — и здесь появятся итоги.`;
  const byDay = new Map<string, number>();
  for (const t of cur) { const k = mskDay(Date.parse(t.ts)); byDay.set(k, (byDay.get(k) ?? 0) + (+t.data.profit! || 0)); }
  const p = sum(cur, 'profit'), best = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0], pp = sum(prev, 'profit');
  const bestDate = new Date(Date.parse(best[0] + 'T12:00:00+03:00')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
  const g = prev.length && pp > 0 ? Math.round((p - pp) / pp * 100) : null;
  return `${title}\n\n💰 Прибыль: <b>${money(p, 'RUB')}</b>\n🔁 Сделок: ${cur.length} · оборот ${Math.round(sum(cur, 'sum')).toLocaleString('ru-RU')} ₽\n` +
    `📆 Торговых дней: ${byDay.size} · в среднем ${money(p / byDay.size, 'RUB')} за день\n🏆 Лучший день: ${bestDate} · ${money(best[1], 'RUB')}` +
    (g !== null ? `\n📈 К ${MON_DAT[pm - 1]} за те же дни: <b>${g >= 0 ? '▲ +' : '▼ −'}${Math.abs(g)}%</b>` : '');
}
async function paidBack(chat: number, tgId: number) {
  const uid = await userOfTg(tgId), s = uid ? await subOf(uid) : null;
  if (isPro(s) && s!.payments?.[0] && Date.now() - Date.parse(s!.payments[0].ts) < 30 * 60e3)
    return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: `✅ <b>Оплата прошла!</b>\n\nPRO действует до <b>${date(s!.pro_until)}</b>. Спасибо!`, reply_markup: kb([[appBtn()]]) });
  return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: '⏳ <b>Проверяем оплату</b>\n\nОбычно это занимает до минуты. Как только PRO включится, бот пришлёт сообщение.', reply_markup: kb([[appBtn()]]) });
}
const rateAsked = new Map<number, number>();
// Защита от спама: не больше 20 нажатий и сообщений за 30 секунд от одного человека (оплаты не ограничиваем).
// Счётчик живёт в памяти функции — этого хватает, чтобы закликивание не нагружало бота и Telegram
const hits = new Map<number, number[]>();
function flood(id: number) {
  const now = Date.now(), list = (hits.get(id) ?? []).filter((t) => now - t < 30e3);
  list.push(now); hits.set(id, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 30e3) hits.delete(k);
  return list.length > 20;
}
// Итоги дня рисуют картинку — по запросу не чаще раза в 15 секунд
const dayAsked = new Map<number, number>();
const dayBusy = (id: number) => { const busy = Date.now() - (dayAsked.get(id) ?? 0) < 15e3; if (!busy) dayAsked.set(id, Date.now()); return busy; };
async function myCallback(cq: { id: string; data?: string; from?: { id: number }; message?: { chat: { id: number } } }) {
  const tgId = cq.from?.id ?? 0, chat = cq.message?.chat.id ?? tgId, a = (cq.data ?? '').slice(3);
  // Карточку курса рисуем не чаще раза в 20 секунд на человека
  const busy = a === 'rate' && Date.now() - (rateAsked.get(tgId) ?? 0) < 20e3;
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: busy ? 'Карточка уже отправлена — курс обновится через минуту' : a === 'rate' ? 'Рисуем карточку курса…' : undefined });
  if (a === 'rate') {
    if (busy) return;
    rateAsked.set(tgId, Date.now());
    const ok = await ratePost(chat, appBtn());
    if (!ok) await tg('sendMessage', { chat_id: chat, text: 'Не получилось получить курс с биржи — попробуйте через минуту.' });
    return;
  }
  const uid = await userOfTg(tgId);
  if (!uid) return tg('sendMessage', { chat_id: chat, text: 'Сначала откройте P2Pro через Telegram — кнопка ниже. Это бесплатно.', reply_markup: kb([[appBtn()]]) });
  if (a === 'day') return dayBusy(tgId) ? undefined : dailySend(uid, mskDay(Date.now()), true);
  const s = await subOf(uid);
  if (a === 'month') {
    if (!isPro(s)) {
      const free = await trialFree(uid, tgId);
      return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: '📅 <b>Итоги месяца — в PRO</b>\n\nПрибыль за месяц, средняя за день, лучший день и рост к прошлому месяцу. В бесплатной версии — итоги дня по кнопке «📊 Мой день».',
        reply_markup: kb([[appBtn(free ? '🎁 7 дней PRO бесплатно' : '⭐ Оформить PRO', free ? '?trial=1' : '?plans=1')]]) });
    }
    return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: await monthText(uid), reply_markup: kb([[appBtn('📊 Открыть аналитику')]]) });
  }
  if (a === 'pro') {
    if (!isPro(s)) return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: '⭐ <b>Сейчас тариф Free</b>\n\nИстория и аналитика — за последние 7 дней. В PRO: вся история, календарь прибыли, связки, контрагенты, график курса и Excel.', reply_markup: kb([[appBtn('⭐ Оформить PRO', '?plans=1')]]) });
    const left = Math.max(1, Math.ceil((Date.parse(s!.pro_until!) - Date.now()) / DAY));
    const how = s!.pay_method === 'trial' ? 'пробный период' : s!.pay_method === 'gift' ? 'подарок' : s!.pay_method === 'promo' ? 'промокод' : s!.auto_renew ? 'с автопродлением' : 'без автопродления';
    return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: `⭐ <b>PRO активен</b> · ${how}\n\nДействует до <b>${date(s!.pro_until)}</b> — осталось ${left} ${plural(left, 'день', 'дня', 'дней')}.`, reply_markup: kb([[appBtn(s!.pay_method === 'trial' ? '⭐ Оставить PRO' : '⭐ Продлить PRO', '?plans=1')]]) });
  }
}

/* ================= ВЕБ-АДМИНКА (p2pro.app/admin) ================= */
// Страница admin.html шлёт сюда { admin_api: 'действие', access_token, ... }. Пускаем только владельца:
// сессию проверяет Supabase, а Telegram id этого аккаунта должен совпасть с ADMIN_ID. Уведомления в бот приходят как раньше
const ACORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const aj = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...ACORS, 'content-type': 'application/json' } });
type ATrade = { user_id: string; ts: string; updated_at: string; data: { ex?: string; bank?: string; profit?: number; sum?: number; cur?: string; mode?: string } };
// Все сделки, только нужные поля (Supabase отдаёт по 1000 строк)
async function allTrades(cols = 'user_id, ts, updated_at'): Promise<ATrade[]> {
  const out: ATrade[] = [];
  for (let from = 0; from < 500000; from += 1000) {
    const { data, error } = await admin.from('trades').select(cols).eq('deleted', false).range(from, from + 999);
    if (error) throw error;
    out.push(...(data as unknown as ATrade[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
const nameOfU = (u: AUser) => String(u.user_metadata?.name ?? '').slice(0, 40) || (isTg(u.email) ? 'Telegram' : (u.email ?? '').split('@')[0]);
async function nicksMap() {
  const data = await rowsAll<TgRow>('tg_users', 'user_id, tg_id, username', 'tg_id');
  return new Map(data.map((x: { user_id: string; tg_id: number; username: string | null }) => [x.user_id, x]));
}
const payKind = (p: Pay & { refund?: boolean; currency?: string }) => p.method === 'stars' ? 'stars' : FREE_METHODS.includes(p.method ?? '') ? 'free' : 'rub';

async function adminDash() {
  const [users, subs, nicks, trades] = await Promise.all([allUsers(), allSubs(), nicksMap(), allTrades()]);
  const now = Date.now(), days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(mskDay(now - i * DAY));
  const idx = new Map(days.map((d, i) => [d, i])), z = () => days.map(() => 0);
  const signups = z(), rub = { sbp: z(), card: z(), crypto: z(), other: z() }, stars = z(), active = z();
  for (const u of users) { const i = idx.get(mskDay(Date.parse(u.created_at))); if (i != null) signups[i]++; }
  const tradeDays = new Map<string, Set<string>>();
  for (const t of trades) { const d = mskDay(Date.parse(t.ts)); const i = idx.get(d); if (i == null) continue; if (!tradeDays.has(d)) tradeDays.set(d, new Set()); tradeDays.get(d)!.add(t.user_id); }
  days.forEach((d, i) => active[i] = tradeDays.get(d)?.size ?? 0);
  let total = { rub: 0, stars: 0, n: 0 }, today = { rub: 0, stars: 0, n: 0 }, week = { rub: 0, stars: 0, n: 0 }, month = { rub: 0, stars: 0, n: 0 };
  const recent: unknown[] = [], byUser = new Map(users.map((u) => [u.id, u]));
  for (const s of subs) for (const p of (s.payments ?? []) as (Pay & { refund?: boolean })[]) {
    const k = payKind(p); if (k === 'free') continue;
    const t = Date.parse(p.ts), d = mskDay(t), i = idx.get(d), a = +p.amount || 0;
    const add = (o: typeof total) => { if (k === 'stars') o.stars += a; else o.rub += a; if (a > 0) o.n++; };
    add(total); if (d === mskDay(now)) add(today); if (now - t < 7 * DAY) add(week); if (i != null) add(month);
    if (i != null) { if (k === 'stars') stars[i] += a; else (rub[(p.method as 'sbp' | 'card' | 'crypto')] ?? rub.other)[i] += a; }
    const u = byUser.get(s.user_id), nk = nicks.get(s.user_id);
    recent.push({ ts: p.ts, amount: a, method: p.method, period: p.period, refund: !!p.refund, user: s.user_id, name: u ? nameOfU(u) : '—', nick: nk?.username ?? null });
  }
  (recent as { ts: string }[]).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const pro = subs.filter(isPro), byMethod: Record<string, number> = {};
  for (const s of pro) byMethod[s.pay_method ?? 'other'] = (byMethod[s.pay_method ?? 'other'] ?? 0) + 1;
  const trials = await rowsAll<{ user_id: string; started_at: string }>('pro_trials', 'user_id, started_at', 'started_at');
  const subBy = new Map(subs.map((s) => [s.user_id, s]));
  const converted = (trials ?? []).filter((t: { user_id: string; started_at: string }) => (subBy.get(t.user_id)?.payments ?? [])
    .some((p) => payKind(p) !== 'free' && +p.amount > 0 && Date.parse(p.ts) > Date.parse(t.started_at))).length;
  const since = (n: number) => users.filter((u) => now - Date.parse(u.created_at) < n * DAY).length;
  return {
    users: { total: users.length, tg: users.filter((u) => isTg(u.email)).length, banned: users.filter(isBanned).length, d1: since(1), d7: since(7), d30: since(30),
      seen7: users.filter((u) => u.last_sign_in_at && now - Date.parse(u.last_sign_in_at) < 7 * DAY).length },
    pro: { now: pro.length, byMethod, trialActive: pro.filter((s) => s.pay_method === 'trial').length },
    trials: { total: (trials ?? []).length, converted },
    trades: { total: trades.length, d7: trades.filter((t) => now - Date.parse(t.ts) < 7 * DAY).length },
    money: { total, today, week, month },
    days, signups, rub, stars, active, recent: recent.slice(0, 12),
  };
}

async function adminUsers() {
  const [users, subs, nicks, trades] = await Promise.all([allUsers(), allSubs(), nicksMap(), allTrades()]);
  const subBy = new Map(subs.map((s) => [s.user_id, s])), tr = new Map<string, { n: number; last: number }>();
  for (const t of trades) { const x = tr.get(t.user_id) ?? { n: 0, last: 0 }; x.n++; x.last = Math.max(x.last, Date.parse(t.updated_at)); tr.set(t.user_id, x); }
  return users.map((u) => {
    const s = subBy.get(u.id) ?? null, nk = nicks.get(u.id), t = tr.get(u.id);
    const paid = (s?.payments ?? []).filter((p) => payKind(p) === 'rub').reduce((a, p) => a + (+p.amount || 0), 0);
    return { id: u.id, name: nameOfU(u), nick: nk?.username ?? null, tg: nk?.tg_id ?? null, email: isTg(u.email) ? null : u.email ?? null,
      created: u.created_at, seen: u.last_sign_in_at ?? null, banned: isBanned(u), pro: isPro(s), until: s?.pro_until ?? null, method: s?.pay_method ?? null,
      trades: t?.n ?? 0, lastTrade: t?.last ? new Date(t.last).toISOString() : null, paid };
  });
}

// Аватарку в профиле человек может подменить на любой адрес (например, чтобы узнать IP владельца) — показываем только из нашего хранилища
const ownAvatar = (v: unknown) => typeof v === 'string' && v.startsWith(`${SB_URL}/storage/v1/object/public/avatars/`) ? v : null;
async function adminUser(id: string) {
  const u = await userById(id); if (!u) return null;
  const [s, price, nicks] = await Promise.all([subOf(id), priceOf(id), nicksMap()]);
  const { data: tr } = await admin.from('trades').select('ts, data').eq('user_id', id).eq('deleted', false).order('ts', { ascending: false }).limit(500);
  const list = (tr ?? []) as { ts: string; data: ATrade['data'] }[], profit: Record<string, number> = {};
  for (const t of list) { const c = t.data.cur ?? 'RUB'; profit[c] = (profit[c] ?? 0) + (+(t.data.profit ?? 0) || 0); }
  const { data: promos } = await admin.from('promo_uses').select('code, used_at').eq('user_id', id);
  const { data: trial } = await admin.from('pro_trials').select('started_at, ends_at').eq('user_id', id).maybeSingle();
  const nk = nicks.get(id);
  return { id, name: nameOfU(u), nick: nk?.username ?? null, tg: nk?.tg_id ?? null, email: isTg(u.email) ? null : u.email ?? null,
    created: u.created_at, seen: u.last_sign_in_at ?? null, banned: isBanned(u), avatar: ownAvatar(u.user_metadata?.avatar),
    sub: s ? { pro: isPro(s), since: s.pro_since, until: s.pro_until, method: s.pay_method, period: s.period, payments: s.payments ?? [] } : null,
    price, trial: trial ?? null, promos: promos ?? [], tradeCount: list.length, profit,
    trades: list.slice(0, 15).map((t) => ({ ts: t.ts, ex: t.data.ex ?? '', bank: t.data.bank ?? '', mode: t.data.mode ?? 'deal', sum: +(t.data.sum ?? 0), profit: +(t.data.profit ?? 0), cur: t.data.cur ?? 'RUB' })) };
}

// Рассылка текстом со страницы: тот же список получателей, что и в боте, итог придёт владельцу в бот
async function broadcastText(text: string, aud: Aud) {
  const ids = await recipients(aud), markup = aud === 'exp' || aud === 'free' ? openBtn('⭐ Продлить PRO') : openBtn();
  let ok = 0;
  const one = async (id: number) => {
    let r = await tg('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });
    if (r?.error_code === 429) { await sleep((r.parameters?.retry_after ?? 3) * 1000); r = await tg('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup }); }
    if (r?.ok) ok++;
  };
  for (let i = 0; i < ids.length; i += 25) { await Promise.all(ids.slice(i, i + 25).map(one)); if (i + 25 < ids.length) await sleep(1000); }
  await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', text: `📣 <b>Рассылка ${AUD[aud]} (с сайта) завершена</b>\nДоставлено: ${ok} из ${ids.length}` });
}
// Текст рассылки и личного сообщения: экранируем всё, кроме **жирного** — его превращаем в <b>
const fmtText = (t: string) => esc(t.slice(0, 3500)).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

/* ---------- Партнёрские ссылки ---------- */
// Ссылка партнёра: https://t.me/P2ProAppBot?start=p_КОД. Доля партнёра — процент со всех оплат людей, пришедших по ней.
// Сами деньги никуда не уходят: админка только считает, сколько должны партнёру, выплаты владелец отмечает вручную
const PCODE = /^[a-z0-9_]{2,24}$/;
const partnerLink = (code: string) => `https://t.me/P2ProAppBot?start=p_${code}`;
// Запоминаем только новых: у кого ещё нет аккаунта P2Pro и кто не пришёл раньше по другой ссылке
async function partnerJoin(from: { id: number; first_name?: string; username?: string }, raw: string) {
  const code = raw.toLowerCase();
  if (!PCODE.test(code)) return;
  const { data: p } = await admin.from('partners').select('name, active').eq('code', code).maybeSingle();
  if (!p?.active) return;
  const { data: had } = await admin.from('tg_users').select('tg_id').eq('tg_id', from.id).maybeSingle();
  if (had) return;
  const name = (from.username ? '@' + from.username : from.first_name ?? '').slice(0, 64);
  const { data: ins, error } = await admin.from('partner_refs').upsert({ tg_id: from.id, code, name }, { onConflict: 'tg_id', ignoreDuplicates: true }).select('tg_id');
  if (error || !ins?.length) return;
  await tg('sendMessage', { chat_id: ADMIN_ID, parse_mode: 'HTML', text: `🤝 По ссылке партнёра <b>${esc(p.name || code)}</b> пришёл новый человек: ${esc(name) || 'без имени'}` });
}
// Таблица целиком (Supabase отдаёт по 1000 строк)
// Сортировка по ключу обязательна: без неё страницы могут повторять или терять строки
// deno-lint-ignore no-explicit-any
async function rowsAll<T>(table: string, cols: string, key: string, where?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 1e6; from += 1000) {
    const base = admin.from(table).select(cols);
    const { data, error } = await (where ? where(base) : base).order(key).range(from, from + 999);
    if (error) throw error;
    out.push(...(data as unknown as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
type TgRow = { user_id: string; tg_id: number; username: string | null };
type PRow = { code: string; name: string; pct: number; note: string; active: boolean; created_at: string };
type PRef = { tg_id: number; code: string; name: string; at: string };
type PPay = { id: number; code: string; amount: number; cur: string; note: string; at: string };
const r2 = (v: number) => Math.round(v * 100) / 100;
// Всё по партнёрам сразу: кто пришёл, сколько заплатил после перехода, доля партнёра, выплачено и долг
async function partnerData() {
  const [ps, refs, pays, tgs, subs] = await Promise.all([
    rowsAll<PRow>('partners', '*', 'code'), rowsAll<PRef>('partner_refs', 'tg_id, code, name, at', 'tg_id'), rowsAll<PPay>('partner_payouts', '*', 'id'),
    rowsAll<TgRow>('tg_users', 'user_id, tg_id, username', 'tg_id'), allSubs()]);
  const tgBy = new Map(tgs.map((t) => [Number(t.tg_id), t])), subBy = new Map(subs.map((s) => [s.user_id, s]));
  const people = refs.map((r) => {
    const t = tgBy.get(Number(r.tg_id)), s = t ? subBy.get(t.user_id) : undefined;
    let rub = 0, stars = 0, n = 0;
    // Считаем только оплаты после перехода по ссылке. Возвраты записаны отрицательной суммой — они уменьшают долю
    for (const p of (s?.payments ?? []) as Pay[]) {
      if (Date.parse(p.ts) < Date.parse(r.at)) continue;
      const k = payKind(p); if (k === 'free') continue;
      if (k === 'stars') stars += +p.amount || 0; else rub += +p.amount || 0;
      if (+p.amount > 0) n++;
    }
    return { tg: Number(r.tg_id), code: r.code, at: r.at, label: r.name, user: t?.user_id ?? null, nick: t?.username ?? null, registered: !!t, pro: isPro(s ?? null), rub, stars, n };
  });
  const list = ps.map((p) => {
    const mine = people.filter((x) => x.code === p.code), pp = pays.filter((x) => x.code === p.code), k = +p.pct / 100;
    const rub = mine.reduce((a, x) => a + x.rub, 0), stars = mine.reduce((a, x) => a + x.stars, 0);
    const paidRub = pp.filter((x) => x.cur === 'rub').reduce((a, x) => a + +x.amount, 0), paidStars = pp.filter((x) => x.cur === 'stars').reduce((a, x) => a + +x.amount, 0);
    const shareRub = r2(Math.max(0, rub) * k), shareStars = Math.floor(Math.max(0, stars) * k);
    return { ...p, pct: +p.pct, link: partnerLink(p.code), joined: mine.length, registered: mine.filter((x) => x.registered).length, payers: mine.filter((x) => x.n > 0).length,
      pro: mine.filter((x) => x.pro).length, rub: r2(rub), stars, shareRub, shareStars, paidRub: r2(paidRub), paidStars, owedRub: r2(shareRub - paidRub), owedStars: shareStars - paidStars };
  });
  return { list, people, pays };
}
async function partnerSave(b: Record<string, unknown>) {
  const code = String(b.code ?? '').trim().toLowerCase(), pct = Number(b.pct);
  if (!PCODE.test(code)) throw new Error('Код — от 2 до 24 знаков: латиница, цифры, _');
  if (!Number.isFinite(pct) || pct < 0 || pct > 90) throw new Error('Процент — от 0 до 90');
  const row = { name: String(b.name ?? '').trim().slice(0, 60), pct: r2(pct), note: String(b.note ?? '').trim().slice(0, 300), active: b.active !== false };
  if (b.create) {
    const { error } = await admin.from('partners').insert({ code, ...row });
    if (error) throw new Error(error.code === '23505' ? 'Такой код уже занят' : error.message);
  } else {
    const { data, error } = await admin.from('partners').update(row).eq('code', code).select('code');
    if (error) throw error; if (!data?.length) throw new Error('Партнёр не найден');
  }
}

// Выгрузка пользователей в таблицу (CSV, открывается в Excel): файл приходит владельцу в бот — так он доступен и с телефона
const CSV_HEAD = ['Имя', 'Ник', 'Telegram id', 'Почта', 'Регистрация', 'Последний вход', 'Статус', 'PRO до', 'Способ', 'Сделок', 'Последняя сделка', 'Заплатил, ₽', 'Партнёр'];
const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // чтобы Excel не принял имя за формулу
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const mskTime = (v: string | null) => v ? new Date(Date.parse(v) + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
const METHOD_RU: Record<string, string> = { sbp: 'СБП', card: 'Карта', crypto: 'Крипта', stars: 'Звёзды', gift: 'Подарок', promo: 'Промокод', trial: 'Пробный' };
async function usersExport() {
  const [users, refs] = await Promise.all([adminUsers(), rowsAll<PRef>('partner_refs', 'tg_id, code', 'tg_id')]);
  const refBy = new Map(refs.map((r) => [Number(r.tg_id), r.code]));
  const rows = users.map((u) => [u.name, u.nick ? '@' + u.nick : '', u.tg ?? '', u.email ?? '', mskTime(u.created), mskTime(u.seen),
    u.banned ? 'Заблокирован' : u.pro ? (u.method === 'trial' ? 'Пробный' : 'PRO') : 'Free', u.pro ? mskTime(u.until) : '', u.method ? METHOD_RU[u.method] ?? u.method : '',
    u.trades, mskTime(u.lastTrade), u.paid || '', u.tg ? refBy.get(Number(u.tg)) ?? '' : '']);
  const csv = '﻿' + [CSV_HEAD, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
  const name = `P2Pro-users-${mskDay(Date.now())}.csv`, fd = new FormData();
  fd.append('chat_id', String(ADMIN_ID)); fd.append('caption', `👥 Пользователи P2Pro: ${users.length}. Файл открывается в Excel и Google Таблицах`);
  fd.append('document', new Blob([csv], { type: 'text/csv' }), name);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: fd }).then((x) => x.json()).catch(() => null);
  return { ok: true, n: users.length, sent: !!r?.ok, csv, name };
}

/* ---------- Общий чёрный список мошенников (22-blacklist.sql) ---------- */
// Пользователь PRO жалуется на ник со скрином → владельцу приходит жалоба с кнопками (и она же в админке) →
// одобренные жалобы и есть общая база. Кто пожаловался, другим не показываем. Скрины — в закрытом хранилище bl-proofs
const BL_KINDS: Record<string, string> = { nopay: 'Не оплатил', cancel: 'Отменил после оплаты', fake: 'Фейковый чек', third: 'Третьи лица', rude: 'Грубость, угрозы', other: 'Другое' };
const BL_REASONS = ['Нет доказательств на скрине', 'Спор по сделке, не мошенничество', 'Повторная жалоба'];
const BL_REWARDS: Record<string, string> = { d3: '+3 дня PRO', d7: '+7 дней PRO', d30: '+30 дней PRO', p20: 'скидка 20%', p50: 'скидка 50%', no: 'без награды' };
type BlRow = { id: number; nick: string; shown: string; kind: string; kind_text: string; note: string; proofs: string[]; reporter: string | null;
  status: string; reason: string; reward: string; created_at: string; decided_at: string | null };
type BlSum = { nick: string; shown: string; n: number; first: string; last: string; added: string; kinds: Record<string, number> };
// Ник для поиска: без @, без лишних пробелов, в нижнем регистре. Так же ник ищется у контрагентов в приложении
const blNick = (v: unknown) => String(v ?? '').trim().replace(/^@+/, '').replace(/\s+/g, ' ').slice(0, 40).toLowerCase();
const blOkNick = (n: string) => n.length >= 2 && !/[\u0000-\u001f<>]/.test(n);
const blKind = (r: { kind: string; kind_text: string }) => (r.kind === 'other' && r.kind_text) ? r.kind_text : BL_KINDS[r.kind] ?? 'Другое';
const blAt = (n: string) => '@' + n;

// Сводка по одобренным жалобам: сколько, когда первая и последняя, какие нарушения
function blSummary(rows: BlRow[]) {
  const m = new Map<string, BlSum>();
  for (const r of rows) {
    const s = m.get(r.nick) ?? { nick: r.nick, shown: r.shown || r.nick, n: 0, first: r.created_at, last: r.created_at, added: r.decided_at ?? r.created_at, kinds: {} };
    s.n++; if (r.created_at < s.first) s.first = r.created_at; if (r.created_at > s.last) s.last = r.created_at;
    const d = r.decided_at ?? r.created_at; if (d < s.added) s.added = d;
    const k = blKind(r); s.kinds[k] = (s.kinds[k] ?? 0) + 1;
    m.set(r.nick, s);
  }
  return m;
}
const BL_COLS = 'id, nick, shown, kind, kind_text, note, proofs, reporter, status, reason, reward, created_at, decided_at';
async function blApproved(nicks?: string[]): Promise<BlRow[]> {
  if (nicks && !nicks.length) return [];
  if (nicks) {   // частями по 100: длинный список ников не влезет в один адрес запроса
    const out: BlRow[] = [];
    for (let i = 0; i < Math.min(nicks.length, 500); i += 100) {
      const { data, error } = await admin.from('bl_reports').select(BL_COLS).eq('status', 'approved').in('nick', nicks.slice(i, i + 100));
      if (error) throw error; out.push(...(data as BlRow[]));
    }
    return out;
  }
  return rowsAll<BlRow>('bl_reports', BL_COLS, 'id', (q) => q.eq('status', 'approved'));
}
async function blGet(id: number): Promise<BlRow | null> {
  const { data } = await admin.from('bl_reports').select(BL_COLS).eq('id', id).maybeSingle();
  return data as BlRow | null;
}
// Картинка из base64: только JPEG / PNG / WebP и не больше 2 МБ (проверяем по первым байтам, а не по названию)
function blImage(b64: unknown): { bytes: Uint8Array; type: string; ext: string } | null {
  if (typeof b64 !== 'string' || b64.length > 2.8e6) return null;
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0)); } catch (_) { return null; }
  if (bytes.length < 100 || bytes.length > 2097152) return null;
  const h = (i: number) => bytes[i];
  if (h(0) === 0xFF && h(1) === 0xD8 && h(2) === 0xFF) return { bytes, type: 'image/jpeg', ext: 'jpg' };
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4E && h(3) === 0x47) return { bytes, type: 'image/png', ext: 'png' };
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return { bytes, type: 'image/webp', ext: 'webp' };
  return null;
}
async function blUpload(dir: string, id: number, imgs: { bytes: Uint8Array; type: string; ext: string }[]) {
  const paths: string[] = [];
  for (const [i, im] of imgs.entries()) {
    const path = `${dir}/${id}-${i + 1}.${im.ext}`;
    const { error } = await admin.storage.from('bl-proofs').upload(path, im.bytes, { contentType: im.type, upsert: true });
    if (error) throw new Error('Не удалось сохранить скрин: ' + error.message);
    paths.push(path);
  }
  if (paths.length) await admin.from('bl_reports').update({ proofs: paths }).eq('id', id);
  return paths;
}
async function blSigned(paths: string[]) {
  if (!paths.length) return [];
  const { data } = await admin.storage.from('bl-proofs').createSignedUrls(paths, 3600);
  return (data ?? []).map((x: { signedUrl: string | null }) => x.signedUrl ?? null);   // порядок как у paths: пропуск — null
}
async function blDownload(path: string) {
  const { data } = await admin.storage.from('bl-proofs').download(path);
  return data ? new Uint8Array(await data.arrayBuffer()) : null;
}

// Жалоба владельцу в бот: скрины + текст + кнопки решения
const blKb = (id: number) => kb([[{ text: '✅ Одобрить', callback_data: `bl:a:${id}` }, { text: '❌ Отклонить', callback_data: `bl:x:${id}` }],
  [{ text: '✏️ Изменить тип нарушения', callback_data: `bl:t:${id}` }], [{ text: '🖥 Открыть в админке', url: `${APP}admin#bl` }]]);
async function blWho(uid: string | null) {
  if (!uid) return 'владелец (вручную)';
  const [u, nick, s] = await Promise.all([userById(uid), tgNick(uid), subOf(uid)]);
  return `${nick ? '@' + esc(nick) : esc(u ? nameOf(u) : 'без имени')}${isPro(s) ? ' (PRO)' : ''}`;
}
async function blOwnerCard(r: BlRow) {
  const inBase = (await blApproved([r.nick])).length;
  return `🚩 <b>Новая жалоба</b> · №${r.id}\n\n<b>На кого:</b> ${esc(blAt(r.shown || r.nick))}\n<b>Что случилось:</b> ${esc(blKind(r))}` +
    (r.note ? `\n«${esc(r.note.slice(0, 500))}»` : '') + `\n\n<b>От:</b> ${await blWho(r.reporter)}\n` +
    (inBase ? `В базе уже: ${inBase} ${plural(inBase, 'жалоба', 'жалобы', 'жалоб')} на этот ник` : 'Этого ника в базе ещё нет');
}
async function blNotifyOwner(r: BlRow, imgs: { bytes: Uint8Array; type: string; ext: string }[]) {
  const text = await blOwnerCard(r);
  if (imgs.length > 1) {   // несколько скринов — альбомом, кнопки отдельным сообщением
    const fd = new FormData();
    fd.append('chat_id', String(ADMIN_ID));
    fd.append('media', JSON.stringify(imgs.map((_, i) => ({ type: 'photo', media: `attach://p${i}` }))));
    imgs.forEach((im, i) => fd.append(`p${i}`, new Blob([im.bytes], { type: im.type }), `proof-${i + 1}.${im.ext}`));
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`, { method: 'POST', body: fd }).catch(() => null);
  } else if (imgs.length === 1 && text.length <= 1000) {
    const fd = new FormData();
    fd.append('chat_id', String(ADMIN_ID)); fd.append('caption', text); fd.append('parse_mode', 'HTML'); fd.append('reply_markup', JSON.stringify(blKb(r.id)));
    fd.append('photo', new Blob([imgs[0].bytes], { type: imgs[0].type }), `proof.${imgs[0].ext}`);
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd }).then((x) => x.json()).catch(() => null);
    if (res?.ok) return;
  }
  await tg('sendMessage', { chat_id: ADMIN_ID, text, parse_mode: 'HTML', reply_markup: blKb(r.id) });
}

// Предупреждение всем PRO, у кого этот ник в контрагентах (кроме автора жалобы). Шлём один раз — когда ник впервые попал в базу
async function blWarnContacts(nick: string, sum: BlSum, skip: string | null) {
  const rows = await rowsAll<{ user_id: string }>('counterparties', 'user_id, name_key', 'user_id', (q) => q.in('name_key', [nick, '@' + nick]).eq('deleted', false));
  const users = [...new Set(rows.map((x) => x.user_id))].filter((u) => u !== skip);
  if (!users.length) return 0;
  const subs = new Map((await allSubs()).map((s) => [s.user_id, s]));
  const kinds = Object.keys(sum.kinds).map((k) => k.toLowerCase()).join(', ');
  let n = 0;
  for (const uid of users) {
    if (!isPro(subs.get(uid) ?? null)) continue;
    const ok = await notify(uid, `⚠️ <b>Ваш контрагент ${esc(blAt(sum.shown))} отмечен как мошенник</b>\n` +
      `По нему ${sum.n} ${plural(sum.n, 'подтверждённая жалоба', 'подтверждённые жалобы', 'подтверждённых жалоб')}: ${esc(kinds)}.\n` +
      `Будьте осторожны и проверяйте поступление денег в банке, а не по чеку.`, kb([[{ text: '🛡 Подробнее в P2Pro', web_app: { url: APP } }]]));
    if (ok) n++;
    await sleep(40);
  }
  return n;
}

// Одобрить или отклонить. Меняем только жалобу «на проверке» — двойное нажатие не сработает дважды
async function blDecide(id: number, act: 'approve' | 'reject', o: { reason?: string; kind?: string; kindText?: string } = {}) {
  const patch: Record<string, unknown> = { status: act === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString() };
  if (act === 'reject') patch.reason = (o.reason ?? '').trim().slice(0, 300) || BL_REASONS[0];
  if (o.kind && o.kind in BL_KINDS) { patch.kind = o.kind; patch.kind_text = o.kind === 'other' ? (o.kindText ?? '').trim().slice(0, 60) : ''; }
  const { data, error } = await admin.from('bl_reports').update(patch).eq('id', id).eq('status', 'pending').select(BL_COLS);
  if (error) throw error;
  const r = (data as BlRow[])?.[0];
  if (!r) throw new Error('Жалоба уже рассмотрена или не найдена');
  if (act === 'reject') {
    const sent = r.reporter ? await notify(r.reporter, `❌ <b>Жалоба на ${esc(blAt(r.shown))} отклонена</b>\nПричина: ${esc(r.reason)}\n\nЕсли это ошибка — отправьте жалобу заново с более понятным скрином.`, openBtn()) : false;
    return { r, sent, warned: 0, n: 0 };
  }
  const sum = blSummary(await blApproved([r.nick])).get(r.nick)!;
  const sent = r.reporter ? await notify(r.reporter, `✅ <b>Ваша жалоба одобрена</b>\n${esc(blAt(r.shown))} добавлен в общую базу мошенников P2Pro. Спасибо, что помогаете другим!`, openBtn()) : false;
  const warned = sum.n === 1 ? await blWarnContacts(r.nick, sum, r.reporter) : 0;
  return { r, sent, warned, n: sum.n };
}
// Награда автору одобренной жалобы — один раз
async function blReward(id: number, reward: string) {
  if (!(reward in BL_REWARDS)) throw new Error('Неизвестная награда');
  const { data, error } = await admin.from('bl_reports').update({ reward }).eq('id', id).eq('status', 'approved').eq('reward', '').select(BL_COLS);
  if (error) throw error;
  const r = (data as BlRow[])?.[0];
  if (!r) throw new Error('Награда уже выбрана или жалоба не одобрена');
  if (!r.reporter || reward === 'no') return { r, sent: false };
  const u = await userById(r.reporter); if (!u) return { r, sent: false };
  if (reward.startsWith('d')) {
    const days = Number(reward.slice(1));
    const { data: g, error: ge } = await admin.rpc('admin_gift_pro', { p_user: u.id, p_days: days });
    if (ge) throw ge;
    const sent = await notify(u.id, `🎁 <b>Спасибо за жалобу на ${esc(blAt(r.shown))}!</b>\nВ благодарность — <b>+${days} ${plural(days, 'день', 'дня', 'дней')} PRO</b>. PRO действует до ${date((g as { pro_until: string }).pro_until)}.`, openBtn());
    return { r, sent };
  }
  await notify(u.id, `🎁 <b>Спасибо за жалобу на ${esc(blAt(r.shown))}!</b>\nВ благодарность — персональная скидка на PRO, подробности ниже.`, openBtn());
  const d = await setDiscount(u, Number(reward.slice(1)));
  return { r, sent: d.notified };
}
async function blSetKind(id: number, kind: string, text = '') {
  if (!(kind in BL_KINDS)) throw new Error('Неизвестный тип');
  const { error } = await admin.from('bl_reports').update({ kind, kind_text: kind === 'other' ? text.trim().slice(0, 60) : '' }).eq('id', id);
  if (error) throw error;
}
// Снять человека из базы (ошибка, апелляция): его одобренные жалобы становятся «сняты», предупреждение у всех пропадёт
async function blRemove(nick: string) {
  const { data, error } = await admin.from('bl_reports').update({ status: 'removed' }).eq('nick', blNick(nick)).eq('status', 'approved').select('id');
  if (error) throw error;
  return (data ?? []).length;
}
async function blCounts() {
  const n = async (s: string) => (await admin.from('bl_reports').select('id', { count: 'exact', head: true }).eq('status', s)).count ?? 0;
  const [pending, approved, rejected, base] = await Promise.all([n('pending'), n('approved'), n('rejected'), blApproved().then((r) => blSummary(r).size)]);
  return { pending, approved, rejected, base };
}

// Пост-счётчик для канала: карточка «В базе уже N мошенников» — без ников, только цифры
function blCardSvg(n: number, week: number) {
  const W = 1080, H = 1080;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="g1" cx="18%" cy="10%" r="70%"><stop offset="0" stop-color="#FF6B6B" stop-opacity=".30"/><stop offset="1" stop-color="#FF6B6B" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="90%" cy="90%" r="60%"><stop offset="0" stop-color="#F2B54B" stop-opacity=".14"/><stop offset="1" stop-color="#F2B54B" stop-opacity="0"/></radialGradient>
    <linearGradient id="sh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF8A8A"/><stop offset="1" stop-color="#C23B3B"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="#0C0F14"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>
  <rect x="100" y="100" width="112" height="112" rx="32" fill="url(#sh)"/>
  <path d="M156 128 l34 13 v26 c0 22 -15 38 -34 45 c-19 -7 -34 -23 -34 -45 v-26 z" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>
  <text x="240" y="150" font-family="Onest" font-weight="600" font-size="30" fill="#FF9A9A" letter-spacing="5">ОБЩАЯ БАЗА P2PRO</text>
  <text x="240" y="192" font-family="Onest" font-size="28" fill="#8691A2">проверенные мошенники P2P</text>
  <text x="96" y="600" font-family="Unbounded" font-weight="800" font-size="${n >= 1000 ? 260 : 330}" fill="#FF6B6B" letter-spacing="-12">${n.toLocaleString('ru-RU')}</text>
  <text x="100" y="700" font-family="Unbounded" font-weight="800" font-size="62" fill="#E8ECF2">${plural(n, 'мошенник', 'мошенника', 'мошенников')} в базе</text>
  ${week ? `<rect x="100" y="760" width="${250 + String(week).length * 20}" height="72" rx="36" fill="#3CD38A" fill-opacity=".14"/><text x="132" y="808" font-family="Onest" font-weight="600" font-size="32" fill="#3CD38A">+${week} за неделю</text>` : ''}
  <text x="100" y="960" font-family="Onest" font-size="30" fill="#8691A2">Каждая жалоба проверена по скрину · раздел «Контрагенты»</text>
  <text x="${W - 100}" y="1010" text-anchor="end" font-family="Onest" font-weight="600" font-size="30" fill="#F2B54B">@P2ProAppBot</text></svg>`;
}
async function blPost(chat: number | string, preview = false) {
  const sum = blSummary(await blApproved()), n = sum.size;
  const week = [...sum.values()].filter((s) => Date.now() - Date.parse(s.added) < 7 * DAY).length;
  const caption = `🛡 <b>В общей базе P2Pro уже ${n} ${plural(n, 'мошенник', 'мошенника', 'мошенников')}</b>\n` +
    (week ? `За неделю добавили ${week}. ` : '') + `Проверяйте контрагентов перед сделкой — раздел «Контрагенты» в @P2ProAppBot.`;
  const markup = preview ? kb([[{ text: `📤 Отправить в ${CHANNEL}`, callback_data: 'bl:pg' }]]) : kb([[{ text: '🚀 Открыть P2Pro', url: BOT_LINK }]]);
  try {
    const r = await renderer();
    const png = new r.Resvg(blCardSvg(n, week), { font: { fontBuffers: r.fonts, defaultFontFamily: 'Onest', loadSystemFonts: false }, fitTo: { mode: 'width', value: 1080 } }).render().asPng();
    const fd = new FormData();
    fd.append('chat_id', String(chat)); fd.append('caption', caption); fd.append('parse_mode', 'HTML'); fd.append('reply_markup', JSON.stringify(markup));
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'P2Pro-base.png');
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd }).then((x) => x.json()).catch(() => null);
    if (res?.ok) return true;
    console.error('bl post', res);
  } catch (e) { console.error('bl card', e); }
  const t = await tg('sendMessage', { chat_id: chat, text: caption, parse_mode: 'HTML', reply_markup: markup });
  return !!t?.ok;
}
// Меню в боте владельца
async function blMenu() {
  const c = await blCounts();
  return { text: `<b>🛡 Общий чёрный список</b>\n\nВ базе: <b>${c.base}</b> ${plural(c.base, 'ник', 'ника', 'ников')}\nЖдут проверки: <b>${c.pending}</b>\nОдобрено: ${c.approved} · отклонено: ${c.rejected}\n\n` +
    `Новые жалобы приходят сюда сами. Поиск, ручное добавление и снятие из базы — в веб-админке, вкладка «База».`,
    markup: kb([[{ text: '📣 Пост-счётчик в канал', callback_data: 'bl:pp' }], [{ text: '🖥 Открыть в админке', url: `${APP}admin#bl` }], [{ text: '‹ Меню', callback_data: 'm' }]]) };
}
// Кнопки под жалобой в боте владельца
async function blCallback(chatId: number, msgId: number | null, act: string, idRaw: string, extra: string): Promise<string> {
  const id = Number(idRaw);
  const clear = () => msgId ? tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }) : null;
  const say = (text: string, markup?: unknown) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) });
  if (act === 'm') { const v = await blMenu(); await show(chatId, msgId, v.text, v.markup); return ''; }
  if (act === 'pp') { await blPost(chatId, true); return 'Превью ниже'; }
  if (act === 'pg') { const ok = await blPost(CHANNEL); await clear(); await say(ok ? `✅ Пост-счётчик опубликован в ${CHANNEL}.` : '⚠️ Не получилось опубликовать: проверьте права бота в канале.'); return ''; }
  if (!(id > 0)) return 'Жалоба не найдена';
  if (act === 'a') {
    const d = await blDecide(id, 'approve'); await clear();
    await say(`✅ <b>Жалоба №${id} одобрена</b>\n${esc(blAt(d.r.shown))} теперь в общей базе (${d.n} ${plural(d.n, 'жалоба', 'жалобы', 'жалоб')}).` +
      (d.warned ? `\nПредупредили ${d.warned} ${plural(d.warned, 'пользователя', 'пользователей', 'пользователей')} PRO, у кого он в контрагентах.` : '') +
      (d.r.reporter ? `\n\n🎁 <b>Наградить автора ${await blWho(d.r.reporter)}?</b>` : ''),
      d.r.reporter ? kb([[{ text: '+3 дня PRO', callback_data: `bl:r:${id}:d3` }, { text: '+7 дней', callback_data: `bl:r:${id}:d7` }, { text: '+30 дней', callback_data: `bl:r:${id}:d30` }],
        [{ text: 'Скидка 20%', callback_data: `bl:r:${id}:p20` }, { text: 'Скидка 50%', callback_data: `bl:r:${id}:p50` }], [{ text: 'Без награды', callback_data: `bl:r:${id}:no` }]]) : undefined);
    return 'Одобрено';
  }
  if (act === 'x') {
    await say(`❌ <b>Отклонить жалобу №${id}?</b>\nВыберите причину — её увидит автор:`, kb([...BL_REASONS.map((t, i) => [{ text: t, callback_data: `bl:j:${id}:${i}` }]),
      [{ text: '✏️ Написать свою', callback_data: `bl:jc:${id}` }]]));
    return '';
  }
  if (act === 'j') { await blDecide(id, 'reject', { reason: BL_REASONS[Number(extra)] }); await clear(); await say(`❌ Жалоба №${id} отклонена: ${esc(BL_REASONS[Number(extra)] ?? '')}. Автор получил уведомление.`); return 'Отклонено'; }
  if (act === 'jc') { await stSet('await', { kind: 'blr', id, at: Date.now() }); await say(`✏️ Пришлите причину отказа по жалобе №${id} одним сообщением — её увидит автор.`); return ''; }
  if (act === 't') {
    await say(`✏️ <b>Тип нарушения для жалобы №${id}</b>`, kb([...Object.entries(BL_KINDS).filter(([k]) => k !== 'other').map(([k, t]) => [{ text: t, callback_data: `bl:k:${id}:${k}` }]),
      [{ text: '✏️ Свой вариант', callback_data: `bl:kc:${id}` }]]));
    return '';
  }
  if (act === 'k') { await blSetKind(id, extra); await clear(); await say(`✏️ Жалоба №${id}: тип — «${esc(BL_KINDS[extra] ?? '')}». Теперь одобрите или отклоните её:`, blKb(id)); return 'Тип изменён'; }
  if (act === 'kc') { await stSet('await', { kind: 'blk', id, at: Date.now() }); await say(`✏️ Пришлите свой тип нарушения для жалобы №${id} (коротко, до 60 знаков).`); return ''; }
  if (act === 'r') {
    const d = await blReward(id, extra); await clear();
    await say(extra === 'no' ? `Жалоба №${id}: без награды.` : `🎁 Автору жалобы №${id} — ${BL_REWARDS[extra]}.${d.sent ? ' Уведомление отправлено.' : ' ⚠️ Уведомление не дошло.'}`);
    return 'Готово';
  }
  return '';
}

// Запросы приложения (только PRO): проверка ников, подробности, свои жалобы, новая жалоба
async function blApi(body: Record<string, unknown>) {
  if (!SERVICE || !TOKEN) return aj({ error: 'server' }, 500);
  const { data: ud, error: ue } = await admin.auth.getUser(typeof body.access_token === 'string' ? body.access_token : '');
  if (ue || !ud?.user) return aj({ error: 'auth' }, 401);
  const u = ud.user as AUser;
  if (isBanned(u)) return aj({ error: 'blocked' }, 403);
  if (!isPro(await subOf(u.id))) return aj({ error: 'pro' }, 403);
  const act = String(body.bl_api);
  try {
    if (act === 'lookup') {
      const nicks = [...new Set((Array.isArray(body.nicks) ? body.nicks : []).slice(0, 500).map(blNick).filter(blOkNick))];
      const [sum, all] = await Promise.all([blApproved(nicks).then(blSummary), blApproved().then((r) => blSummary(r).size)]);
      return aj({ total: all, base: Object.fromEntries([...sum.values()].map((s) => [s.nick, { n: s.n, last: s.last, kinds: s.kinds }])) });
    }
    if (act === 'detail') {
      const nick = blNick(body.nick); if (!blOkNick(nick)) throw new Error('Впишите ник');
      const rows = (await blApproved([nick])).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const s = blSummary(rows).get(nick);
      return aj({ nick, found: !!s, n: s?.n ?? 0, first: s?.first ?? null, last: s?.last ?? null, kinds: s?.kinds ?? {},
        items: rows.slice(0, 30).map((r) => ({ at: r.created_at, kind: blKind(r), note: r.note })) });
    }
    if (act === 'mine') {
      const { data, error } = await admin.from('bl_reports').select(BL_COLS).eq('reporter', u.id).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return aj({ list: (data as BlRow[]).map((r) => ({ id: r.id, nick: r.shown || r.nick, kind: blKind(r), status: r.status === 'removed' ? 'approved' : r.status,
        reason: r.reason, reward: r.reward && r.reward !== 'no' ? BL_REWARDS[r.reward] : '', at: r.created_at })) });
    }
    if (act === 'report') {
      const shown = String(body.nick ?? '').trim().replace(/^@+/, '').replace(/\s+/g, ' ').slice(0, 40), nick = blNick(shown);
      if (!blOkNick(nick)) throw new Error('Впишите ник мошенника');
      const kind = String(body.kind ?? ''); if (!(kind in BL_KINDS)) throw new Error('Выберите, что случилось');
      const kindText = kind === 'other' ? String(body.kind_text ?? '').trim().slice(0, 60) : '';
      if (kind === 'other' && !kindText) throw new Error('Напишите, что случилось');
      const note = String(body.note ?? '').trim().slice(0, 1000);
      const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 3).map(blImage);
      if (!imgs.length) throw new Error('Приложите хотя бы один скрин');
      if (imgs.some((x) => !x)) throw new Error('Скрин должен быть картинкой JPG или PNG до 2 МБ');
      // Без спама: не больше 10 жалоб за сутки и одна жалоба на проверке на один ник
      const { count } = await admin.from('bl_reports').select('id', { count: 'exact', head: true }).eq('reporter', u.id).gte('created_at', new Date(Date.now() - DAY).toISOString());
      if ((count ?? 0) >= 10) throw new Error('Не больше 10 жалоб в сутки — попробуйте завтра');
      const { data: dup } = await admin.from('bl_reports').select('id').eq('reporter', u.id).eq('nick', nick).eq('status', 'pending').limit(1);
      if (dup?.length) throw new Error('Ваша жалоба на этот ник уже на проверке');
      const { data: ins, error } = await admin.from('bl_reports').insert({ nick, shown, kind, kind_text: kindText, note, reporter: u.id }).select(BL_COLS).single();
      if (error) throw error;
      const r = ins as BlRow, ok = imgs as { bytes: Uint8Array; type: string; ext: string }[];
      try { r.proofs = await blUpload(u.id, r.id, ok); }
      catch (e) { await admin.from('bl_reports').delete().eq('id', r.id); throw e; }
      await blNotifyOwner(r, ok).catch((e) => console.error('bl notify', e));
      return aj({ ok: true, id: r.id });
    }
    return aj({ error: 'Неизвестное действие' }, 400);
  } catch (e) { return aj({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 400); }
}

// Админка: очередь, карточка жалобы со скринами, решение, поиск, ручное добавление, снятие, пост
async function blAdmin(act: string, body: Record<string, unknown>) {
  const withNicks = async (rows: BlRow[]) => {
    const nicks = await nicksMap(), counts = blSummary(await blApproved([...new Set(rows.map((r) => r.nick))]));
    const thumbs = await blSigned(rows.map((r) => r.proofs[0]).filter(Boolean));
    let ti = 0;
    return rows.map((r) => ({ ...r, kindLabel: blKind(r), from: r.reporter ? (nicks.get(r.reporter)?.username ?? null) : null, manual: !r.reporter,
      inBase: counts.get(r.nick)?.n ?? 0, thumb: r.proofs[0] ? thumbs[ti++] ?? null : null }));
  };
  if (act === 'bl_counts') return blCounts();
  if (act === 'bl_list') {
    const st = String(body.status ?? 'pending');
    let q = admin.from('bl_reports').select(BL_COLS).order('created_at', { ascending: false }).limit(300);
    if (['pending', 'approved', 'rejected', 'removed'].includes(st)) q = q.eq('status', st);
    if (typeof body.nick === 'string' && body.nick) q = q.eq('nick', blNick(body.nick));
    const { data, error } = await q; if (error) throw error;
    return { list: await withNicks(data as BlRow[]) };
  }
  if (act === 'bl_get') {
    const r = await blGet(Number(body.id)); if (!r) throw new Error('Жалоба не найдена');
    const [x] = await withNicks([r]);
    return { report: { ...x, images: (await blSigned(r.proofs)).filter(Boolean), who: await blWho(r.reporter) }, kinds: BL_KINDS, reasons: BL_REASONS, rewards: BL_REWARDS };
  }
  if (act === 'bl_decide') {
    const id = Number(body.id), a = body.act === 'reject' ? 'reject' : 'approve';
    const d = await blDecide(id, a, { reason: String(body.reason ?? ''), kind: body.kind ? String(body.kind) : undefined, kindText: String(body.kind_text ?? '') });
    let rewarded = false;
    if (a === 'approve' && d.r.reporter && typeof body.reward === 'string' && body.reward in BL_REWARDS) rewarded = !!(await blReward(id, body.reward)).sent;
    return { ok: true, sent: d.sent, warned: d.warned, n: d.n, rewarded };
  }
  if (act === 'bl_kind') { await blSetKind(Number(body.id), String(body.kind ?? ''), String(body.kind_text ?? '')); return { ok: true }; }
  if (act === 'bl_search') {
    const q = blNick(body.q);
    const sum = blSummary(await blApproved());
    const list = [...sum.values()].filter((s) => !q || s.nick.includes(q)).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 100);
    const { data: rep } = list.length ? await admin.from('bl_reports').select('nick, reporter').eq('status', 'approved').in('nick', list.map((s) => s.nick)) : { data: [] };
    const nicks = await nicksMap();
    return { list: list.map((s) => ({ ...s, from: [...new Set(((rep ?? []) as { nick: string; reporter: string | null }[]).filter((x) => x.nick === s.nick)
      .map((x) => x.reporter ? (nicks.get(x.reporter)?.username ? '@' + nicks.get(x.reporter)!.username : 'без ника') : 'вручную'))] })) };
  }
  if (act === 'bl_add') {
    const shown = String(body.nick ?? '').trim().replace(/^@+/, '').replace(/\s+/g, ' ').slice(0, 40), nick = blNick(shown);
    if (!blOkNick(nick)) throw new Error('Впишите ник');
    const kind = String(body.kind ?? 'other'); if (!(kind in BL_KINDS)) throw new Error('Выберите тип нарушения');
    const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 3).map(blImage);
    if (imgs.some((x) => !x)) throw new Error('Скрин должен быть картинкой JPG или PNG до 2 МБ');
    const { data: ins, error } = await admin.from('bl_reports').insert({ nick, shown, kind, kind_text: kind === 'other' ? String(body.kind_text ?? '').trim().slice(0, 60) : '',
      note: String(body.note ?? '').trim().slice(0, 1000), status: 'approved', decided_at: new Date().toISOString(), reward: 'no' }).select(BL_COLS).single();
    if (error) throw error;
    const r = ins as BlRow;
    if (imgs.length) await blUpload('admin', r.id, imgs as { bytes: Uint8Array; type: string; ext: string }[]);
    const sum = blSummary(await blApproved([nick])).get(nick)!;
    const warned = sum.n === 1 ? await blWarnContacts(nick, sum, null) : 0;
    return { ok: true, n: sum.n, warned };
  }
  if (act === 'bl_remove') return { ok: true, n: await blRemove(String(body.nick ?? '')) };
  if (act === 'bl_post') return { ok: await blPost(body.mode === 'channel' ? CHANNEL : ADMIN_ID, body.mode !== 'channel') };
  return null;
}

/* ---------- Курс в любом чате: @P2ProAppBot (инлайн-режим включается в @BotFather → /setinline) ---------- */
// Пусто или «курс» — карточка курса USDT. «50000 92.1 93.4» — быстрый расчёт сделки: сумма, курс покупки, курс продажи
const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const money2 = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function inlineAnswer(q: { id: string; query?: string }) {
  const results: unknown[] = [], open = kb([[{ text: '🚀 Открыть P2Pro', url: 'https://t.me/P2ProAppBot?start=inline' }]]);
  const m = (q.query ?? '').trim().replace(/(\d),(\d)/g, '$1.$2').match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
  if (m) {
    const sum = +m[1], buy = +m[2], sell = +m[3];
    if (sum > 0 && buy > 0 && sell > 0 && sum < 1e10) {
      const usdt = sum / buy, out = usdt * sell, profit = out - sum, pct = profit / sum * 100, sg = profit >= 0 ? '+' : '−';
      results.push({ type: 'article', id: 'deal', title: `Прибыль ${sg}${money2(Math.abs(profit))} ₽ (${sg}${money2(Math.abs(pct))}%)`,
        description: `${money2(sum)} ₽ · купил по ${money2(buy)} · продал по ${money2(sell)}`, thumbnail_url: `${APP}icons/icon-192.png`,
        input_message_content: { parse_mode: 'HTML', message_text: `🧮 <b>Расчёт сделки</b>\n\nСумма: <b>${money2(sum)} ₽</b>\nКупил по ${money2(buy)} ₽ → <b>${money2(usdt)} USDT</b>\n` +
          `Продал по ${money2(sell)} ₽ → <b>${money2(out)} ₽</b>\n\nПрибыль: <b>${sg}${money2(Math.abs(profit))} ₽</b> (${sg}${money2(Math.abs(pct))}%)\n<i>Без комиссий бирж — точный расчёт в @P2ProAppBot</i>` },
        reply_markup: open });
    }
  }
  const main = await usdtRate();
  if (main) {
    const vals = await Promise.all(RP_FIATS.map(([c]) => fiatRate(c)));
    const now = new Date(), when = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) + ', ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const ch = `${main.ch >= 0 ? '+' : '−'}${rub2(Math.abs(main.ch))}%`;
    const fiats = RP_FIATS.map(([, name, sym], i) => vals[i] ? `${name}: ${vals[i] >= 1000 ? Math.round(vals[i]).toLocaleString('ru-RU') : rub2(vals[i])} ${sym}` : '').filter(Boolean).join(' · ');
    results.push({ type: 'article', id: 'rate', title: `Курс USDT: ${rub2(main.rate)} ₽`, description: `${ch} за сутки · биржа xRocket`, thumbnail_url: `${APP}icons/icon-192.png`,
      input_message_content: { parse_mode: 'HTML', message_text: `💱 <b>Курс USDT · ${esc(when)}</b>\n\n🇷🇺 <b>${rub2(main.rate)} ₽</b> (${ch} за сутки)\n${fiats}\n\nБиржа xRocket · курс через @P2ProAppBot` },
      reply_markup: open });
  }
  await tg('answerInlineQuery', { inline_query_id: q.id, results, cache_time: 60, is_personal: false, button: { text: '🚀 Открыть P2Pro', start_parameter: 'inline' } });
}

/* ---------- Возврат ушедших ---------- */
// Кто 10–45 дней не записывал сделки — одно сообщение с курсом и его лучшим месяцем. Один раз за перерыв.
// Кто выключил итоги дня кнопкой в боте, тому не пишем
async function winback() {
  const [tgs, users, trades] = await Promise.all([rowsAll<{ user_id: string; tg_id: number; daily_off: boolean | null }>('tg_users', 'user_id, tg_id, daily_off', 'tg_id'),
    allUsers(), allTrades('user_id, ts')]);
  const banned = new Set(users.filter(isBanned).map((u) => u.id)), last = new Map<string, number>(), now = Date.now();
  for (const t of trades) last.set(t.user_id, Math.max(last.get(t.user_id) ?? 0, Date.parse(t.ts)));
  const cand = tgs.filter((t) => { const l = last.get(t.user_id); return !!l && !t.daily_off && !banned.has(t.user_id) && Number(t.tg_id) !== ADMIN_ID && now - l >= 10 * DAY && now - l < 45 * DAY; });
  if (!cand.length) return;
  const done = new Map((await rowsAll<{ key: string; value: { last: number } }>('bot_state', 'key, value', 'key', (q) => q.like('key', 'wb:%'))).map((x) => [x.key, x.value?.last]));
  const rate = await usdtRate();
  let n = 0;
  for (const t of cand.slice(0, 300)) {
    const l = last.get(t.user_id)!;
    if (done.get('wb:' + t.user_id) === l) continue;
    const { data } = await admin.from('trades').select('ts, data').eq('user_id', t.user_id).eq('deleted', false).limit(5000);
    const by: Record<string, number> = {};
    for (const x of (data ?? []) as { ts: string; data: ATrade['data'] }[]) { if ((x.data?.cur ?? 'RUB') !== 'RUB') continue; const k = mskDay(Date.parse(x.ts)).slice(0, 7); by[k] = (by[k] ?? 0) + (+(x.data?.profit ?? 0) || 0); }
    const best = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    const text = `👋 <b>Давно не виделись!</b>\n` + (rate ? `Курс USDT сейчас: <b>${rub2(rate.rate)} ₽</b> (xRocket).\n` : '') +
      (best && best[1] > 0 ? `Ваш лучший месяц — ${MONTHS_RU[+best[0].slice(5) - 1]}: <b>+${Math.round(best[1]).toLocaleString('ru-RU')} ₽</b>. ` : '') +
      `Записывайте сделки, чтобы статистика оставалась полной.`;
    let r = await tg('sendMessage', { chat_id: t.tg_id, text, parse_mode: 'HTML', reply_markup: openBtn() });
    if (r?.error_code === 429) { await sleep((r.parameters?.retry_after ?? 3) * 1000); r = await tg('sendMessage', { chat_id: t.tg_id, text, parse_mode: 'HTML', reply_markup: openBtn() }); }
    await stSet('wb:' + t.user_id, { last: l, at: now });
    if (r?.ok) n++;
    await sleep(50);
  }
  if (n) await tg('sendMessage', { chat_id: ADMIN_ID, text: `👋 Возврат ушедших: напомнили о P2Pro ${n} ${plural(n, 'человеку', 'людям', 'людям')}, кто 10+ дней не записывал сделки.` });
}

// Вход по одноразовой ссылке из бота: код забираем одним запросом (второй раз не сработает) и выдаём сессию аккаунта владельца
// Код из 12 знаков без похожих (0/O, 1/I): ~60 бит — за 5 минут его не подобрать
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const adminCode = () => [...crypto.getRandomValues(new Uint8Array(12))].map((x) => CODE_ABC[x % 32]).join('');
async function adminRedeem(raw: string) {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z2-9]{12}$/.test(code)) return aj({ error: 'bad' }, 400);
  const v = await stTake<{ exp: number }>('wa:' + code);
  if (!v || Date.now() > v.exp) return aj({ error: 'expired' }, 403);
  const { data: t } = await admin.from('tg_users').select('user_id').eq('tg_id', ADMIN_ID).maybeSingle();
  const u = t ? await userById(t.user_id) : null;
  if (!u?.email) return aj({ error: 'no owner' }, 500);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.email });
  if (le) throw le;
  const pub = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY') || SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (error || !data.session) throw error ?? new Error('no session');
  await tg('sendMessage', { chat_id: ADMIN_ID, text: '🖥 Выполнен вход в веб-админку.' });
  return aj({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
}

async function adminApi(body: Record<string, unknown>) {
  if (!SERVICE || !TOKEN) return aj({ error: 'server' }, 500);
  if (body.admin_api === 'redeem') return adminRedeem(String(body.code ?? ''));
  const { data: ud, error: ue } = await admin.auth.getUser(typeof body.access_token === 'string' ? body.access_token : '');
  if (ue || !ud?.user) return aj({ error: 'auth' }, 401);
  if (await tgIdOf(ud.user.id) !== ADMIN_ID) return aj({ error: 'forbidden' }, 403);
  const act = String(body.admin_api), id = typeof body.id === 'string' ? body.id : '';
  const needUser = async () => { const u = id ? await userById(id) : null; if (!u) throw new Error('Пользователь не найден'); return u; };
  try {
    if (act === 'me') return aj({ ok: true, name: nameOfU(ud.user as AUser) });
    if (act === 'dash') return aj(await adminDash());
    if (act === 'users') return aj({ users: await adminUsers() });
    if (act === 'payments') {
      const [users, subs, nicks] = await Promise.all([allUsers(), allSubs(), nicksMap()]), byUser = new Map(users.map((u) => [u.id, u])), out = [];
      for (const s of subs) for (const p of (s.payments ?? []) as (Pay & { refund?: boolean; code?: string; paid?: string })[]) {
        const u = byUser.get(s.user_id);
        out.push({ ts: p.ts, amount: +p.amount || 0, method: p.method ?? null, kind: payKind(p), period: p.period ?? null, days: p.days ?? null, refund: !!p.refund, code: p.code ?? null, paid: p.paid ?? null,
          user: s.user_id, name: u ? nameOfU(u) : '—', nick: nicks.get(s.user_id)?.username ?? null });
      }
      out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      return aj({ payments: out.slice(0, 3000) });
    }
    if (act === 'user') { const r = await adminUser(id); return r ? aj(r) : aj({ error: 'Пользователь не найден' }, 404); }
    if (act === 'give') { const d = Number(body.days); if (!Number.isInteger(d) || d < 1 || d > 3650) throw new Error('Дни — от 1 до 3650'); const r = await giveDays(await needUser(), d); return aj({ ok: true, ...r, user: await adminUser(id) }); }
    if (act === 'revoke') { const r = await revokePro(await needUser()); return aj({ ok: true, ...r, user: await adminUser(id) }); }
    if (act === 'ban') { const notified = await setBan(await needUser(), !!body.on); return aj({ ok: true, notified, user: await adminUser(id) }); }
    if (act === 'price') { const cur = body.cur === 'rub' ? 'rub' : 'stars'; const r = await setPrice(await needUser(), Number(body.m), body.y ? Number(body.y) : undefined, cur); return aj({ ok: true, ...r, user: await adminUser(id) }); }
    if (act === 'discount') { const d = Number(body.pct); if (!Number.isInteger(d) || d < 1 || d > 90) throw new Error('Скидка — от 1 до 90%'); const r = await setDiscount(await needUser(), d); return aj({ ok: true, ...r, user: await adminUser(id) }); }
    if (act === 'price_reset') { await needUser(); const { error } = await admin.from('custom_prices').delete().eq('user_id', id); if (error) throw error; return aj({ ok: true, user: await adminUser(id) }); }
    if (act === 'msg') { const t = String(body.text ?? '').trim(); if (!t) throw new Error('Пустое сообщение'); const u = await needUser(); return aj({ ok: true, notified: await notify(u.id, fmtText(t), kb([[{ text: '💬 Поддержка', url: SUPPORT }]])) }); }
    if (act === 'promos') {
      const { data: list } = await admin.from('promo_codes').select('*').order('created_at', { ascending: false });
      const { data: uses } = await admin.from('promo_uses').select('code, user_id, used_at').order('used_at', { ascending: false }).limit(500);
      const nicks = await nicksMap();
      return aj({ promos: list ?? [], uses: (uses ?? []).map((x: { code: string; user_id: string; used_at: string }) => ({ ...x, nick: nicks.get(x.user_id)?.username ?? null })) });
    }
    if (act === 'promo_create') {
      const args = [String(body.code ?? ''), String(body.days ?? ''), body.max ? String(body.max) : '', body.ttl ? String(body.ttl) : ''];
      const r = await promoCreate(args); if (!r.startsWith('✅')) throw new Error(r.replace(/<[^>]+>/g, ''));
      return aj({ ok: true });
    }
    if (act === 'promo_toggle') { const { data: p } = await admin.from('promo_codes').select('active').eq('code', String(body.code)).maybeSingle(); if (!p) throw new Error('Нет такого кода'); await admin.from('promo_codes').update({ active: !p.active }).eq('code', String(body.code)); return aj({ ok: true }); }
    if (act === 'promo_delete') { await admin.from('promo_codes').delete().eq('code', String(body.code)); return aj({ ok: true }); }
    if (act === 'users_export') return aj(await usersExport());
    if (act === 'partners') { const d = await partnerData(); return aj({ partners: d.list }); }
    if (act === 'partner') {
      const code = String(body.code ?? ''), d = await partnerData(), p = d.list.find((x) => x.code === code);
      if (!p) throw new Error('Партнёр не найден');
      const users = new Map((await allUsers()).map((u) => [u.id, u]));
      const people = d.people.filter((x) => x.code === code).map((x) => { const u = x.user ? users.get(x.user) : undefined; return { ...x, name: u ? nameOfU(u) : '' }; })
        .sort((a, b) => b.rub - a.rub || Date.parse(b.at) - Date.parse(a.at));
      return aj({ partner: p, people, payouts: d.pays.filter((x) => x.code === code).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) });
    }
    if (act === 'partner_save') { await partnerSave(body); return aj({ ok: true }); }
    if (act === 'partner_delete') { const { error } = await admin.from('partners').delete().eq('code', String(body.code ?? '')); if (error) throw error; return aj({ ok: true }); }
    if (act === 'partner_payout') {
      const amount = r2(Number(body.amount)), cur = body.cur === 'stars' ? 'stars' : 'rub';
      if (!(amount > 0) || amount > 1e7) throw new Error('Сумма должна быть больше нуля');
      const { error } = await admin.from('partner_payouts').insert({ code: String(body.code ?? ''), amount, cur, note: String(body.note ?? '').trim().slice(0, 200) });
      if (error) throw new Error(error.code === '23503' ? 'Партнёр не найден' : error.message);
      return aj({ ok: true });
    }
    if (act === 'partner_payout_del') { const { error } = await admin.from('partner_payouts').delete().eq('id', Number(body.id)); if (error) throw error; return aj({ ok: true }); }
    if (act === 'bc_counts') { const n = await Promise.all((['all', 'pro', 'exp', 'free'] as Aud[]).map((a) => recipients(a).then((r) => r.length))); return aj({ all: n[0], pro: n[1], exp: n[2], free: n[3] }); }
    if (act === 'bc_test' || act === 'bc_send') {
      const t = String(body.text ?? '').trim(); if (!t) throw new Error('Пустой текст');
      if (act === 'bc_test') { const r = await tg('sendMessage', { chat_id: ADMIN_ID, text: fmtText(t), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: openBtn() }); if (!r?.ok) throw new Error('Telegram не принял текст: ' + (r?.description ?? '')); return aj({ ok: true }); }
      const aud = (['all', 'pro', 'exp', 'free'] as Aud[]).includes(body.aud as Aud) ? body.aud as Aud : 'all';
      const n = (await recipients(aud)).length; background(broadcastText(fmtText(t), aud)); return aj({ ok: true, n });
    }
    if (act.startsWith('bl_')) { const r = await blAdmin(act, body); if (r) return aj(r); }
    return aj({ error: 'Неизвестное действие' }, 400);
  } catch (e) { return aj({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 400); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ACORS });
  const raw = await req.text().catch(() => '');
  // deno-lint-ignore no-explicit-any
  let update: any = null;
  try { update = JSON.parse(raw); } catch (_) { /* не JSON */ }
  // Веб-админка: своя проверка (сессия владельца), секрет Telegram ей не нужен
  if (raw.length > 9e6) return aj({ error: 'Слишком большой запрос' }, 413);
  // Приложение: общий чёрный список (только PRO, проверка по сессии пользователя)
  if (typeof update?.bl_api === 'string') return blApi(update).catch((e) => { console.error('bl api', e); return aj({ error: 'server' }, 500); });
  if (typeof update?.admin_api === 'string') return adminApi(update).catch((e) => { console.error('admin api', e); return aj({ error: 'server' }, 500); });
  // Принимаем запросы только от Telegram и от расписания Supabase: оба присылают секрет, который мы задали
  if (!SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('forbidden', { status: 403 });
  if (update?.cron === 'daily') { if (TOKEN && SERVICE) background(dailyFanout()); return new Response('ok'); }
  if (update?.cron) { if (TOKEN && SERVICE) await tick().catch((e) => console.error('tick', e)); return new Response('ok'); }
  if (update?.rate_post === 'channel' || update?.rate_post === 'admin') {
    if (TOKEN && SERVICE) { const ok = await ratePost(update.rate_post === 'channel' ? CHANNEL : ADMIN_ID).catch((e) => { console.error('rate post', e); return false; });
      if (!ok && update.rate_post === 'channel') await tg('sendMessage', { chat_id: ADMIN_ID, text: '⚠️ Карточка курса не опубликована: проверьте, что у бота есть право «Публикация сообщений» в канале.' }); }
    return new Response('ok');
  }
  if (typeof update?.daily_user === 'string') { if (TOKEN && SERVICE) await dailySend(update.daily_user, String(update.day ?? mskDay(Date.now()))).catch((e) => console.error('daily', e)); return new Response('ok'); }
  const isAdmin = (id?: number) => id === ADMIN_ID && !!SERVICE && !!TOKEN;
  // Курс в любом чате (инлайн-режим)
  if (update?.inline_query) { if (TOKEN) await inlineAnswer(update.inline_query).catch((e) => console.error('inline', e)); return new Response('ok'); }
  // Оплата звёздами: проверка перед списанием и успешный платёж
  if (update?.pre_checkout_query) { await preCheckout(update.pre_checkout_query).catch((e) => console.error('precheckout', e)); return new Response('ok'); }
  if (update?.message?.successful_payment) { await paid(update.message).catch((e) => console.error('paid', e)); return new Response('ok'); }
  // Нажатие кнопки в админ-панели
  const cq = update?.callback_query;
  const who = cq?.from?.id ?? update?.message?.from?.id;
  if (who && !isAdmin(who) && flood(who)) { if (cq) await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Слишком часто — подождите немного' }); return new Response('ok'); }
  if (cq && /^l[gn]:/.test(cq.data ?? '') && SERVICE) { await loginAnswer(cq).catch((e) => console.error('login', e)); return new Response('ok'); }
  if (cq && /^my:/.test(cq.data ?? '') && SERVICE) { await myCallback(cq).catch((e) => console.error('my', e)); return new Response('ok'); }
  if (cq && (cq.data === 'doff' || cq.data === 'don') && SERVICE) { await dailyToggle(cq).catch((e) => console.error('daily toggle', e)); return new Response('ok'); }
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
      // Вернулись со страницы оплаты СБП: показываем, включился ли PRO
      if (text.trim() === '/start paid' && SERVICE) { await paidBack(msg.chat.id, msg.from?.id ?? 0); return new Response('ok'); }
      // Итоги дня прямо сейчас — для любого, кто входил в P2Pro через Telegram
      if (/^\/itogi(@\w+)?$/i.test(text.trim()) && SERVICE) {
        const { data: t } = await admin.from('tg_users').select('user_id').eq('tg_id', msg.from?.id ?? 0).maybeSingle();
        if (t && !dayBusy(msg.from?.id ?? 0)) await dailySend(t.user_id, mskDay(Date.now()), true);
        else await send(msg.chat.id, 'Сначала войдите в P2Pro через Telegram — кнопка «Открыть P2Pro» ниже.');
        return new Response('ok');
      }
      if (isAdmin(msg.from?.id) && await adminMessage(msg)) return new Response('ok');
      // Пришёл по ссылке партнёра — запоминаем, затем обычное приветствие
      const pm = text.trim().match(/^\/start p_([A-Za-z0-9_]{2,24})$/);
      if (pm && msg.from && SERVICE) await partnerJoin(msg.from, pm[1]).catch((e) => console.error('partner', e));
      if (text.startsWith('/start')) await tg('sendMessage', { chat_id: msg.chat.id, text: WELCOME(esc((msg.from?.first_name ?? '').slice(0, 40))), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: await startKb(msg.from?.id ?? 0) });
      else await send(msg.chat.id, HELP);
    } catch (_) { /* сеть Telegram недоступна — пропускаем */ }
  }
  return new Response('ok');
});
