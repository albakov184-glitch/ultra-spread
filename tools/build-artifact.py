#!/usr/bin/env python3
"""Собирает из index.html автономную версию P2Pro для артефакта Claude.

Без входа, без сервера и Telegram: сделки хранятся только в этом браузере, все функции PRO открыты.
Запуск: python3 tools/build-artifact.py <папка-вывода>
В папке появятся p2pro.html и картинки, которые он использует.
"""
import re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifact-build')
out.mkdir(parents=True, exist_ok=True)
s = (ROOT / 'index.html').read_text(encoding='utf-8')

def cut(pattern, repl='', count=1, flags=0):
    global s
    s, n = re.subn(pattern, repl, s, count=count, flags=flags)
    assert n, f'не найдено: {pattern}'

# Обёртку <html>/<head>/<body> добавляет сам артефакт
cut(r'<!doctype html>\s*', flags=re.I)
cut(r'<html[^>]*>\s*')
cut(r'<head>\s*')
cut(r'</head>\s*<body>\s*')
cut(r'</body>\s*</html>\s*$')
# Внешние сервисы: вход (Supabase), Telegram, манифест сайта — в артефакте не нужны и не грузятся
cut(r'<script src="https://cdn\.jsdelivr\.net/npm/@supabase[^>]*></script>\s*')
cut(r'<script async src="https://telegram\.org/[^>]*></script>\s*')
cut(r'<link rel="manifest"[^>]*>\s*')
cut(r'<title>[^<]*</title>', '<title>P2Pro</title>')
# Метка «автономная версия» — до основного скрипта
cut(r'(<script>\n)', r'''<script>window.P2_LOCAL = true;
// В артефакте обычное скачивание запрещено: файл (Excel, карточка) отдаём через разрешённое сохранение Claude
(function () {
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!(this.download && /^blob:/.test(this.href))) return orig.call(this);
    const name = this.download, href = this.href;
    (async () => {
      try {
        const dl = await window.claude?.use?.('downloads');
        if (!dl) throw { code: 'unavailable' };
        await dl.save({ filename: name, data: await fetch(href).then(r => r.blob()) });
      } catch (e) {
        if (e?.code !== 'declined' && typeof toast === 'function') toast('Сохранить файл здесь не получилось — откройте p2pro.app');
      }
    })();
  };
})();
</script>
\1''')
# Запуск без входа: PRO открыт навсегда, данные — только на этом устройстве
cut(r'function bootAccount\(\) \{\n', '''function bootAccount() {
  if (window.P2_LOCAL) {
    const st = S.settings; st.pro = true; st.proUntil = 4102444800000; st.autoRenew = false; st.payMethod = 'gift';
    renderAcc();
    return runSplash(() => { booted = true; persist(false); render(); afterAuth(); });
  }
''')

cut(r"\$\('planPill'\)\.textContent = pro \? `PRO · [^`]*` : 'Free';", "$('planPill').textContent = pro ? 'PRO' : 'Free';")

# Без аккаунта не нужны: подписка и оплата, удаление аккаунта, установка на экран (это делает сайт)
cut(r'(</style>)', r'''.card:has(> #subBox), #delAccBtn, #installBtn { display: none !important; }
\1''')
# Документы и тарифы — с сайта p2pro.app (в артефакте рядом этих страниц нет)
s = re.sub(r'href="(legal\.html[^"]*|tariffs\.html)"', r'href="https://p2pro.app/\1"', s)

(out / 'p2pro.html').write_text(s, encoding='utf-8')
files = sorted(set(re.findall(r'["\'((](icons/[\w.-]+|img/[\w.-]+|guide/[\w.-]+)', s)))
for f in files:
    src = ROOT / f
    if src.exists():
        (out / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out / f)
print('\n'.join(['p2pro.html'] + [f for f in files if (ROOT / f).exists()]))
