// P2Pro — Telegram-бот @P2ProAppBot. Отвечает на /start и сообщения, открывает мини-апп.
// Работает как Edge Function в Supabase: Telegram присылает сюда каждое сообщение боту (webhook).
// Токен бота и секрет webhook хранятся в Supabase → Edge Functions → Secrets, в коде их нет.
// Для владельца (ADMIN_ID) бот — ещё и админ-панель: /stats, /user, /give, /revoke. Остальным эти команды не отвечают.

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
// Кнопки: /admin → меню → список пользователей (по 10 на странице) → карточка → выдать/забрать PRO.
// Текстовые команды /stats, /user, /give, /revoke тоже работают. Обычный текст от владельца — поиск пользователя
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const DAY = 864e5, PAGE = 10;
const date = (v: string | number | null | undefined) => v ? new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(' г.', '') : '—';
const isTg = (email?: string) => /@telegram\.invalid$/i.test(email ?? '');
type AUser = { id: string; email?: string; created_at: string; last_sign_in_at?: string; user_metadata?: Record<string, unknown> };
type Sub = { user_id: string; pro_since: string | null; pro_until: string | null; auto_renew: boolean; pay_method: string | null; period: string; payments: unknown[] } | null;
type Btn = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
const kb = (rows: Btn[][]) => ({ inline_keyboard: rows });
const isPro = (s: Sub) => !!s?.pro_until && Date.parse(s.pro_until) > Date.now();

const MENU = () => kb([[{ text: '📊 Статистика', callback_data: 'st' }, { text: '👥 Пользователи', callback_data: 'l:0' }], [{ text: '🔍 Поиск', callback_data: 'fs' }]]);
const ADMIN_HELP = `<b>🛠 Админ-панель P2Pro</b>\n\nВыберите раздел. Чтобы найти пользователя, просто пришлите мне @ник, почту или Telegram id.\n\n` +
  `Команды тоже работают: /stats, /user @ник, /give @ник 30, /revoke @ник`;

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

async function statsText() {
  const users = await allUsers(), now = Date.now(), iso = new Date().toISOString();
  const tgN = users.filter((u) => isTg(u.email)).length;
  const since = (d: number) => users.filter((u) => now - Date.parse(u.created_at) < d * DAY).length;
  const active = users.filter((u) => u.last_sign_in_at && now - Date.parse(u.last_sign_in_at) < 7 * DAY).length;
  const { count: pro } = await admin.from('subscriptions').select('user_id', { count: 'exact', head: true }).gt('pro_until', iso);
  const { count: gifts } = await admin.from('subscriptions').select('user_id', { count: 'exact', head: true }).gt('pro_until', iso).eq('pay_method', 'gift');
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('deleted', false);
  return `<b>📊 Статистика P2Pro</b>\n\n` +
    `👥 Пользователей: <b>${users.length}</b>\n   через Telegram: ${tgN} · по почте: ${users.length - tgN}\n` +
    `🆕 Новых за сутки: ${since(1)} · за неделю: ${since(7)} · за месяц: ${since(30)}\n` +
    `🔑 Входили за неделю: ${active}\n\n` +
    `⭐ PRO сейчас: <b>${pro ?? 0}</b> (из них подарено: ${gifts ?? 0})\n📒 Сделок в базе: ${trades ?? 0}`;
}

async function listView(page: number) {
  const users = await allUsers(), pages = Math.max(1, Math.ceil(users.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const { data: subs } = await admin.from('subscriptions').select('user_id').gt('pro_until', new Date().toISOString());
  const pro = new Set((subs ?? []).map((x: { user_id: string }) => x.user_id));
  const { data: tgs } = await admin.from('tg_users').select('user_id, username');
  const nicks = new Map((tgs ?? []).filter((x: { username?: string }) => x.username).map((x: { user_id: string; username: string }) => [x.user_id, x.username]));
  const view = (u: AUser) => nicks.has(u.id) ? { ...u, user_metadata: { ...u.user_metadata, tg_username: nicks.get(u.id) } } : u;
  const rows: Btn[][] = users.slice(page * PAGE, page * PAGE + PAGE)
    .map(view).map((u) => [{ text: `${pro.has(u.id) ? '⭐ ' : ''}${nameOf(u)} | ${contactOf(u)}`.slice(0, 60), callback_data: `u:${u.id}:${page}` }]);
  rows.push([{ text: '‹‹', callback_data: `l:${page - 1}` }, { text: `${page + 1}/${pages}`, callback_data: 'nop' }, { text: '››', callback_data: `l:${page + 1}` }]);
  rows.push([{ text: '🔍 Поиск', callback_data: 'fs' }, { text: '‹ Меню', callback_data: 'm' }]);
  return { text: `<b>👥 Пользователи</b> · всего ${users.length}\n\nНажмите на пользователя, чтобы открыть карточку. ⭐ — есть PRO.`, markup: kb(rows) };
}

async function cardView(u: AUser, back = 0) {   // back — страница списка, куда вернуться
  const s = await subOf(u.id), tgId = await tgIdOf(u.id), nick = await tgNick(u.id);
  if (nick) u = { ...u, user_metadata: { ...u.user_metadata, tg_username: nick } };   // проверенный ник вместо того, что в профиле
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('user_id', u.id).eq('deleted', false);
  const text = `<b>👤 Пользователь</b>\n\n${who(u)}\n` + (tgId ? `Telegram id: <code>${tgId}</code>\n` : '') +
    `Регистрация: ${date(u.created_at)}\nПоследний вход: ${date(u.last_sign_in_at)}\nСделок: ${trades ?? 0}\n\n` +
    (isPro(s) ? `⭐ PRO до <b>${date(s!.pro_until)}</b>${s!.pay_method === 'gift' ? ' (подарок)' : s!.auto_renew ? ' · автопродление' : ''}` : 'Тариф: Free');
  const id = u.id;
  const rows: Btn[][] = [
    [{ text: '🎁 +7 дн', callback_data: `g:${id}:7:${back}` }, { text: '🎁 +30 дн', callback_data: `g:${id}:30:${back}` }],
    [{ text: '🎁 +90 дн', callback_data: `g:${id}:90:${back}` }, { text: '🎁 +365 дн', callback_data: `g:${id}:365:${back}` }],
  ];
  if (isPro(s)) rows.push([{ text: '⛔ Забрать PRO', callback_data: `r:${id}:${back}` }]);
  rows.push([{ text: '‹ К списку', callback_data: `l:${back}` }, { text: '‹ Меню', callback_data: 'm' }]);
  return { text, markup: kb(rows) };
}

// Выдать PRO: дни прибавляются к текущему сроку. Подарок не продлевается сам
async function giveDays(u: AUser, days: number) {
  // Одним действием на сервере (07-gift.sql): двойное нажатие не потеряет дни, платная подписка останется платной
  const { data, error } = await admin.rpc('admin_gift_pro', { p_user: u.id, p_days: days });
  if (error) throw error;
  const until = (data as { pro_until: string }).pro_until;
  const notified = await notify(u.id, `🎁 <b>Вам подарен P2Pro PRO</b> на ${days} дн.\n\nPRO действует до <b>${date(until)}</b>: история без ограничений, контрагенты, Excel и карточки без водяного знака.`,
    kb([[{ text: '🚀 Открыть P2Pro', web_app: { url: APP } }]]));
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

// Сообщение пользователю. Дойдёт, только если он хоть раз запускал бота
async function notify(userId: string, text: string, markup: unknown) {
  const tgId = await tgIdOf(userId);
  if (!tgId) return false;
  const r = await tg('sendMessage', { chat_id: tgId, text, parse_mode: 'HTML', reply_markup: markup });
  return !!r?.ok;
}
const noteOf = (u: AUser, ok: boolean) => ok ? '\n📨 Пользователю отправлено уведомление.' : isTg(u.email) ? '\n⚠️ Уведомление не дошло: пользователь не запускал бота.' : '\n⚠️ Уведомление не отправлено: аккаунт по почте, без Telegram.';

const NOT_FOUND = 'Не нашёл пользователя. Ник ищется у тех, кто входил в P2Pro через Telegram; остальных ищите по почте.';

// Ответ: новое сообщение или замена текущего (когда нажали кнопку)
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
  try {
    if (k === 'm') await show(chatId, msgId, ADMIN_HELP, MENU());
    else if (k === 'st') await show(chatId, msgId, await statsText(), kb([[{ text: '🔄 Обновить', callback_data: 'st' }, { text: '‹ Меню', callback_data: 'm' }]]));
    else if (k === 'l') { const v = await listView(Number(a) || 0); await show(chatId, msgId, v.text, v.markup); }
    else if (k === 'fs') await show(chatId, msgId, '🔍 Пришлите @ник, почту или Telegram id пользователя.', kb([[{ text: '‹ Меню', callback_data: 'm' }]]));
    else if (k === 'u' || k === 'g' || k === 'r' || k === 'rr') {
      const u = await userById(a);
      if (!u) toastText = 'Пользователь не найден';
      else if (k === 'u') { const v = await cardView(u, Number(b) || 0); await show(chatId, msgId, v.text, v.markup); }
      else if (k === 'r') await show(chatId, msgId, `Забрать PRO у ${who(u)}?\nПользователю придёт сообщение с кнопкой поддержки.`,
        kb([[{ text: '⛔ Да, забрать', callback_data: `rr:${u.id}:${b}` }, { text: 'Отмена', callback_data: `u:${u.id}:${b}` }]]));
      else if (k === 'rr') { const r = await revokePro(u); toastText = r.was ? 'PRO отключён' : 'PRO уже не было'; const v = await cardView(u, Number(b) || 0); await show(chatId, msgId, v.text + (r.was ? '\n' + noteOf(u, r.notified) : ''), v.markup); }
      else {
        const days = Number(b);
        if (!Number.isInteger(days) || days < 1 || days > 3650) toastText = 'Неверное число дней';
        else { const r = await giveDays(u, days); toastText = `Выдано +${days} дн.`; const v = await cardView(u, Number(c) || 0); await show(chatId, msgId, v.text + '\n' + noteOf(u, r.notified), v.markup); }
      }
    }
  } catch (e) {
    console.error('admin', e);
    toastText = 'Ошибка сервера';
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: toastText || undefined });
}

async function adminText(chatId: number, text: string): Promise<boolean> {
  const [cmd, a = '', b = ''] = text.trim().split(/\s+/);
  const c = cmd.toLowerCase().replace(/@\w+$/, '');
  try {
    if (c === '/admin') {
      await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: [
        { command: 'admin', description: 'Админ-панель' }, { command: 'stats', description: 'Статистика' },
        { command: 'user', description: 'Карточка: /user @ник' }, { command: 'give', description: 'Выдать PRO: /give @ник 30' },
        { command: 'revoke', description: 'Забрать PRO: /revoke @ник' }, { command: 'start', description: 'Открыть P2Pro' } ] });
      await show(chatId, null, ADMIN_HELP, MENU());
    } else if (c === '/stats') await show(chatId, null, await statsText(), kb([[{ text: '🔄 Обновить', callback_data: 'st' }, { text: '‹ Меню', callback_data: 'm' }]]));
    else if (c === '/user' || !c.startsWith('/')) {
      const q = c === '/user' ? a : text.trim();
      const u = q ? await findUser(q) : null;
      if (u) { const v = await cardView(u); await show(chatId, null, v.text, v.markup); }
      else await show(chatId, null, q ? NOT_FOUND : 'Напишите так: <code>/user @ник</code>', kb([[{ text: '‹ Меню', callback_data: 'm' }]]));
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

Deno.serve(async (req) => {
  // Принимаем запросы только от Telegram: он присылает секрет, который мы задали при подключении webhook
  if (!SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  const isAdmin = (id?: number) => id === ADMIN_ID && !!SERVICE && !!TOKEN;
  // Нажатие кнопки в админ-панели
  const cq = update?.callback_query;
  if (cq) {
    if (isAdmin(cq.from?.id)) await adminCallback(cq).catch(() => {});
    else await tg('answerCallbackQuery', { callback_query_id: cq.id });
    return new Response('ok');
  }
  const msg = update?.message;
  // Отвечаем только в личных чатах; на ошибки Telegram всё равно получает «ok», иначе будет слать повторно
  if (msg?.chat?.type === 'private' && TOKEN) {
    const text: string = msg.text ?? '';
    try {
      if (isAdmin(msg.from?.id) && text && !text.startsWith('/start') && await adminText(msg.chat.id, text)) return new Response('ok');
      if (text.startsWith('/start')) await send(msg.chat.id, WELCOME(esc((msg.from?.first_name ?? '').slice(0, 40))));
      else await send(msg.chat.id, HELP);
    } catch (_) { /* сеть Telegram недоступна — пропускаем */ }
  }
  return new Response('ok');
});
