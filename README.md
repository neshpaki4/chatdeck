# ChatDeck

Мульти-сервисный Twitch оверлей для OBS — чат, донаты, редимы и события в одном окне.

![ChatDeck Screenshot](https://github.com/neshpaki4/chatdeck/raw/main/screenshots/preview.png)

## Что это?

**ChatDeck** — это десктопное приложение для стримеров, которое показывает чат Twitch, донаты с DonationAlerts и события (подписки, битсы, гифты) прямо в OBS через Browser Source. Всё работает локально, без облака и подписок.

Одна ссылка в OBS — и на экране стрима появляются:
- 💬 Сообщения чата с эмодзи (7TV + Twitch native)
- 🎁 Редимы за баллы канала
- 💰 Донаты с суммой и сообщением
- 🎉 Подписки, гифты, битсы, watch streak

## Возможности

**Чат**
- Полная поддержка эмодзи: 7TV (глобал + канал), Twitch native
- Настраиваемый размер текста и эмодзи
- Бейджи (модератор, VIP, подписчик)
- Анимации появления и скрытия

**DonationAlerts**
- Живые донаты через WebSocket (Centrifugo)
- Сумма, валюта, сообщение, ник донатера
- Авто-реконнект при обрыве

**Ивенты Twitch (EventSub)**
- Новые подписки
- Продления подписок (с сообщением)
- Гифт-подписки
- Битсы (cheer)
- Watch Streak (через IRC sidecar)

**Стилизация**
- Кастомизация через панель настроек
- Шрифт, размер текста, размер эмодзи
- Включение/выключение фона
- Автоскрытие сообщений (настраиваемое время)
- Живой предпросмотр

**Технически**
- Electron + Express + WebSocket
- OAuth для Twitch и DonationAlerts
- Локальное хранение токенов (config.json в userData)
- Single-instance lock (нельзя запустить дважды)

## Установка

### Для пользователей

1. Скачай последнюю версию из [Releases](https://github.com/neshpaki4/chatdeck/releases)
2. Запусти установщик (`ChatDeck-Setup-X.X.X.exe`) или портативную версию (`ChatDeck-X.X.X-portable.exe`)
3. Запусти приложение
4. В настройках укажи:
   - **Канал Twitch** (твой ник без #)
   - **Client ID** и **Client Secret** (получить в [Twitch Developer Console](https://dev.twitch.tv/console/apps))
5. Нажми **"Подключить Twitch"** → разреши доступ (нужны права на чтение редимов, подписок и битсов)
6. Для DonationAlerts: укажи **DA Client ID** и **Secret** (получить в [DA API](https://www.donationalerts.com/dashboard/api)) → **"Подключить DA"**
7. Скопируй URL из панели и добавь его как **Browser Source** в OBS (рекомендуемые размеры: 400×600px)

### Для разработчиков

Клонируй репозиторий и собери локально:

```bash
# Клонируем
git clone https://github.com/neshpaki4/chatdeck.git
cd chatdeck

# Устанавливаем зависимости
npm install

# Запуск в dev-режиме (только сервер, без Electron)
npm run dev
# Откроется на http://localhost:6767

# Запуск Electron-приложения
npm start

# Сборка для Windows
npm run dist
# Результат в папке dist/
```

**Структура проекта:**
```
chatdeck/
├── main.js           # Electron main process
├── server.js         # Express + WebSocket сервер
├── public/           # Оверлей для OBS
│   ├── index.html
│   └── app.js
├── panel/            # Панель настроек
│   ├── panel.html
│   └── setup.html
├── preload.js        # Bridge между main и renderer
└── package.json
```

**Зависимости:**
- Node.js 18+
- npm
- Electron (dev)
- electron-builder (для сборки)

## Как это работает

```
┌─────────────┐
│   Twitch    │
│   Chat      │
└──────┬──────┘
       │ IRC (tmi.js)
       ▼
┌─────────────┐      WebSocket       ┌─────────────┐
│  server.js  │ ◄──────────────────► │  OBS        │
│  (Express)  │                      │  Browser    │
└──────┬──────┘                      │  Source     │
       │                             └─────────────┘
       │ EventSub
       ▼
┌─────────────┐
│   Twitch    │
│   API       │
└─────────────┘
```

1. **tmi.js** подключается к IRC Twitch и получает сообщения чата
2. **server.js** парсит сообщения, подтягивает эмодзи из 7TV API, бейджи из Helix
3. **WebSocket** стримит события всем подключённым клиентам (обычно один — OBS)
4. **Browser Source** в OBS рендерит `public/index.html` с живым чатом
5. **EventSub** получает ивенты (подписки, битсы) через WebSocket от Twitch
6. **DonationAlerts** подключается через Centrifugo WebSocket

## Конфигурация

Настройки хранятся в `config.json` в папке userData:

- **Windows:** `C:\Users\<имя>\AppData\Roaming\chatdeck-twitch-chat\config.json`
- **macOS:** `~/Library/Application Support/chatdeck-twitch-chat/config.json`
- **Linux:** `~/.config/chatdeck-twitch-chat/config.json`

В конфиге хранятся:
- Канал, Client ID/Secret (Twitch)
- DA Client ID/Secret (DonationAlerts)
- OAuth токены (не редактируй вручную)
- Порт сервера (по умолчанию 6767)

⚠️ **Никогда не коммить `config.json`** — там токены доступа. Он уже в `.gitignore`.

## Порты

- **6767** — основной сервер (чат + API)
- **6769** — OAuth callback (фиксирован, не меняется)

Убедись, что порты свободны перед запуском.

## Известные ограничения

- **Watch Streak** работает только когда Twitch отправляет системное сообщение в IRC (не все серии триггерят событие)
- **Resub без сообщения** не генерирует EventSub-событие (ограничение Twitch API)
- **Персональные паки зрителей** отключены — используется только пак канала + глобал + Twitch native
- **Только Windows** в текущей версии (electron-builder настроен на Windows)


## Лицензия

MIT — используй, модифицируй, распространяй свободно. См. [LICENSE](LICENSE).

## Связь

- GitHub Issues: [neshpaki4/chatdeck/issues](https://github.com/neshpaki4/chatdeck/issues)
- Twitch: [neshpaki4](https://twitch.tv/neshpaki4)

---

Сделано с ❤️ для русскоязычного стримерского комьюнити
