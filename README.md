# 🎮 Marbles Race — Cloud (Kick інтеграція)

Хмарний віджет marbles race з реєстрацією через Kick чат.
Працює дистанційно — будь-який стрімер відкриває URL зі своїм ніком.

## 📁 Структура
```
marbles-cloud/
├── server.js          # Node.js сервер (Kick → WebSocket relay)
├── package.json
├── railway.json
└── public/
    ├── widget.html    # 3D гра для OBS
    └── control.html   # панель керування
```

## 🚀 Деплой на Railway (5 хвилин, безкоштовно)

1. Зайди на **railway.app** → залогінься через GitHub
2. **New Project** → **Deploy from GitHub repo**
   (або **Empty Project** → Deploy і завантаж файли)
3. Railway автоматично:
   - знайде `package.json`
   - встановить залежності
   - запустить `node server.js`
4. **Settings → Networking → Generate Domain**
   Отримаєш URL типу: `marbles-production.up.railway.app`

## ✅ Як використовувати

Стрімер відкриває:
```
https://ТВІЙ-ДОМЕН.up.railway.app/control.html
```
Вводить свій Kick нік → отримує посилання для OBS:
```
https://ТВІЙ-ДОМЕН.up.railway.app/widget.html?channel=НІК
```

### Потік:
1. Стрімер відкриває **control.html**, вводить свій канал
2. Додає **widget.html?channel=НІК** в OBS Browser Source
3. Натискає **"Відкрити реєстрацію"**
4. Глядачі пишуть **!play** в Kick чат → з'являються в грі
5. **"Старт гонки"** → 3D гонка на стрімі!

## 🔧 Локальний тест
```bash
cd marbles-cloud
npm install
node server.js
# відкрий http://localhost:3000/control.html
```

## 💡 Як працює
- Сервер тримає "кімнати" — одна на кожен Kick канал
- Читає Kick чат через Pusher WebSocket (публічний, без авторизації)
- Передає гравців віджету та панелі через власний WebSocket
- При `!play` під час відкритої реєстрації — додає гравця
