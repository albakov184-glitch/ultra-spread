// P2Pro — Telegram-бот @P2ProAppBot. Отвечает на /start и сообщения, открывает мини-апп.
// Работает как Edge Function в Supabase: Telegram присылает сюда каждое сообщение боту (webhook).
// Токен бота и секрет webhook хранятся в Supabase → Edge Functions → Secrets, в коде их нет.

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? '';
const APP = 'https://albakov184-glitch.github.io/ultra-spread/';
const SUPPORT = 'https://t.me/MVSR_P2P';

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

async function send(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true }),
  });
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

Deno.serve(async (req) => {
  // Принимаем запросы только от Telegram: он присылает секрет, который мы задали при подключении webhook
  if (!SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  // Отвечаем только в личных чатах; на ошибки Telegram всё равно получает «ok», иначе будет слать повторно
  if (msg?.chat?.type === 'private' && TOKEN) {
    const text: string = msg.text ?? '';
    try {
      if (text.startsWith('/start')) await send(msg.chat.id, WELCOME(esc((msg.from?.first_name ?? '').slice(0, 40))));
      else await send(msg.chat.id, HELP);
    } catch (_) { /* сеть Telegram недоступна — пропускаем */ }
  }
  return new Response('ok');
});
