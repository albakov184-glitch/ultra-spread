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
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const DAY = 864e5;
const date = (v: string | number | null | undefined) => v ? new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(' г.', '') : '—';
const isTg = (email?: string) => /@telegram\.invalid$/i.test(email ?? '');
type AUser = { id: string; email?: string; created_at: string; last_sign_in_at?: string; user_metadata?: Record<string, unknown> };

const ADMIN_HELP =
  `<b>Админ-панель P2Pro</b>\n\n` +
  `/stats — пользователи и подписки\n` +
  `/user @ник — карточка пользователя (можно почту или Telegram id)\n` +
  `/give @ник 30 — выдать PRO на 30 дней (дни добавляются к текущему сроку)\n` +
  `/revoke @ник — забрать PRO`;

// Все аккаунты (Supabase отдаёт страницами по 1000)
async function allUsers(): Promise<AUser[]> {
  const out: AUser[] = [];
  for (let page = 1; page < 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    out.push(...(data.users as AUser[]));
    if (data.users.length < 1000) break;
  }
  return out;
}

// Ищем по @нику Telegram, Telegram id или почте
async function findUser(q: string): Promise<AUser | null> {
  q = q.trim().replace(/^https?:\/\/t\.me\//i, '');
  if (/^\d{4,15}$/.test(q)) {
    const { data } = await admin.from('tg_users').select('user_id').eq('tg_id', Number(q)).maybeSingle();
    if (!data) return null;
    const { data: u } = await admin.auth.admin.getUserById(data.user_id);
    return (u?.user as AUser) ?? null;
  }
  const users = await allUsers();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) return users.find((u) => u.email?.toLowerCase() === q.toLowerCase()) ?? null;
  const nick = q.replace(/^@/, '').toLowerCase();
  return users.find((u) => String(u.user_metadata?.tg_username ?? '').toLowerCase() === nick) ?? null;
}

const who = (u: AUser) => {
  const name = esc(String(u.user_metadata?.name ?? '').slice(0, 40)) || 'без имени';
  const nick = String(u.user_metadata?.tg_username ?? '');
  return `<b>${name}</b> · ` + (isTg(u.email) ? (nick ? '@' + esc(nick) : 'Telegram без ника') : esc(u.email ?? ''));
};

async function tgIdOf(userId: string): Promise<number | null> {
  const { data } = await admin.from('tg_users').select('tg_id').eq('user_id', userId).maybeSingle();
  return data?.tg_id ?? null;
}

async function cmdStats() {
  const users = await allUsers(), now = Date.now();
  const tgN = users.filter((u) => isTg(u.email)).length;
  const since = (d: number) => users.filter((u) => now - Date.parse(u.created_at) < d * DAY).length;
  const active = users.filter((u) => u.last_sign_in_at && now - Date.parse(u.last_sign_in_at) < 7 * DAY).length;
  const { count: pro } = await admin.from('subscriptions').select('user_id', { count: 'exact', head: true }).gt('pro_until', new Date().toISOString());
  const { count: gifts } = await admin.from('subscriptions').select('user_id', { count: 'exact', head: true }).gt('pro_until', new Date().toISOString()).eq('pay_method', 'gift');
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('deleted', false);
  return `<b>📊 Статистика P2Pro</b>\n\n` +
    `👥 Пользователей: <b>${users.length}</b>\n` +
    `   через Telegram: ${tgN} · по почте: ${users.length - tgN}\n` +
    `🆕 Новых за сутки: ${since(1)} · за неделю: ${since(7)} · за месяц: ${since(30)}\n` +
    `🔑 Входили за неделю: ${active}\n\n` +
    `⭐ PRO сейчас: <b>${pro ?? 0}</b> (из них подарено: ${gifts ?? 0})\n` +
    `📒 Сделок в базе: ${trades ?? 0}`;
}

async function cmdUser(q: string) {
  if (!q) return 'Напишите так: <code>/user @ник</code>, <code>/user почта</code> или <code>/user Telegram-id</code>';
  const u = await findUser(q);
  if (!u) return 'Не нашёл пользователя. Проверьте ник — человек должен хоть раз войти в P2Pro через Telegram.';
  const { data: s } = await admin.from('subscriptions').select('*').eq('user_id', u.id).maybeSingle();
  const { count: trades } = await admin.from('trades').select('id', { count: 'exact', head: true }).eq('user_id', u.id).eq('deleted', false);
  const tgId = await tgIdOf(u.id);
  const pro = s?.pro_until && Date.parse(s.pro_until) > Date.now();
  return `<b>👤 Пользователь</b>\n\n${who(u)}\n` +
    (tgId ? `Telegram id: <code>${tgId}</code>\n` : '') +
    `Регистрация: ${date(u.created_at)}\nПоследний вход: ${date(u.last_sign_in_at)}\n` +
    `Сделок: ${trades ?? 0}\n\n` +
    (pro ? `⭐ PRO до <b>${date(s.pro_until)}</b>${s.pay_method === 'gift' ? ' (подарок)' : s.auto_renew ? ' · автопродление' : ''}` : 'Тариф: Free');
}

async function cmdGive(q: string, daysStr: string) {
  const days = Number(daysStr);
  if (!q || !Number.isInteger(days) || days < 1 || days > 3650) return 'Напишите так: <code>/give @ник 30</code> — число дней от 1 до 3650';
  const u = await findUser(q);
  if (!u) return 'Не нашёл пользователя. Проверьте ник — человек должен хоть раз войти в P2Pro через Telegram.';
  await admin.from('subscriptions').upsert({ user_id: u.id }, { onConflict: 'user_id', ignoreDuplicates: true });
  const { data: s, error } = await admin.from('subscriptions').select('*').eq('user_id', u.id).single();
  if (error) throw error;
  const now = Date.now(), cur = s.pro_until ? Date.parse(s.pro_until) : 0, active = cur > now;
  const until = new Date(Math.max(cur, now) + days * DAY).toISOString();
  const pay = { ts: new Date().toISOString(), amount: 0, period: 'm', method: 'gift', days };
  // Подарок не продлевается сам: автопродление выключаем
  const { error: ue } = await admin.from('subscriptions').update({
    pro_until: until, pro_since: active ? s.pro_since : new Date().toISOString(), auto_renew: false, pay_method: 'gift', period: 'm',
    payments: [pay, ...(Array.isArray(s.payments) ? s.payments : [])],
  }).eq('user_id', u.id);
  if (ue) throw ue;
  const tgId = await tgIdOf(u.id);
  let note = '';
  if (tgId) {
    const r = await tg('sendMessage', { chat_id: tgId, parse_mode: 'HTML', reply_markup: keyboard,
      text: `🎁 Вам выдан <b>P2Pro PRO</b> на ${days} дн. — до ${date(until)}.\n\nОткройте приложение, чтобы начать пользоваться.` });
    note = r?.ok ? '\nПользователю отправлено сообщение.' : '\nСообщение пользователю не дошло (он не запускал бота) — PRO всё равно выдан.';
  }
  return `✅ ${who(u)}\nPRO на ${days} дн. — до <b>${date(until)}</b>.${note}`;
}

async function cmdRevoke(q: string) {
  if (!q) return 'Напишите так: <code>/revoke @ник</code>';
  const u = await findUser(q);
  if (!u) return 'Не нашёл пользователя.';
  const { error } = await admin.from('subscriptions').update({ pro_until: new Date().toISOString(), auto_renew: false }).eq('user_id', u.id);
  if (error) throw error;
  return `⛔ ${who(u)}\nPRO отключён, тариф Free.`;
}

async function adminCommand(chatId: number, text: string): Promise<boolean> {
  const [cmd, a = '', b = ''] = text.trim().split(/\s+/);
  const c = cmd.toLowerCase().replace(/@\w+$/, '');
  let reply: string;
  try {
    if (c === '/admin') {
      await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: [
        { command: 'stats', description: 'Статистика' }, { command: 'user', description: 'Карточка: /user @ник' },
        { command: 'give', description: 'Выдать PRO: /give @ник 30' }, { command: 'revoke', description: 'Забрать PRO: /revoke @ник' },
        { command: 'admin', description: 'Помощь по админке' }, { command: 'start', description: 'Открыть P2Pro' } ] });
      reply = ADMIN_HELP;
    } else if (c === '/stats') reply = await cmdStats();
    else if (c === '/user') reply = await cmdUser(a);
    else if (c === '/give') reply = await cmdGive(a, b);
    else if (c === '/revoke') reply = await cmdRevoke(a);
    else return false;
  } catch (e) {
    console.error('admin', e);
    reply = 'Ошибка сервера: ' + esc(String((e as Error)?.message ?? e)).slice(0, 200);
  }
  await send(chatId, reply, false);
  return true;
}

Deno.serve(async (req) => {
  // Принимаем запросы только от Telegram: он присылает секрет, который мы задали при подключении webhook
  if (!SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  // Отвечаем только в личных чатах; на ошибки Telegram всё равно получает «ok», иначе будет слать повторно
  if (msg?.chat?.type === 'private' && TOKEN) {
    const text: string = msg.text ?? '';
    try {
      if (msg.from?.id === ADMIN_ID && SERVICE && text.startsWith('/') && await adminCommand(msg.chat.id, text)) return new Response('ok');
      if (text.startsWith('/start')) await send(msg.chat.id, WELCOME(esc((msg.from?.first_name ?? '').slice(0, 40))));
      else await send(msg.chat.id, HELP);
    } catch (_) { /* сеть Telegram недоступна — пропускаем */ }
  }
  return new Response('ok');
});
