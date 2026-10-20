# P2Pro для iPhone

Нативная оболочка (Capacitor 6) вокруг сайта P2Pro: приложение открывает
https://albakov184-glitch.github.io/ultra-spread/, поэтому обновления сайта сразу видны и в приложении.

Сборка — GitHub Actions (`.github/workflows/ios.yml`, на Mac GitHub). Результат — неподписанный `P2Pro.ipa`
в релизе `ios-latest`. Перед установкой его подписывают на телефоне (ESign, Scarlet, Feather) или через
SideStore / AltStore / Sideloadly своим Apple ID.

- `capacitor.config.json` — имя, bundle id, адрес сайта
- `icon-1024.png` — иконка, `splash-2732.png` — заставка при запуске
- `www/` — запасная страница на случай, если нет интернета
