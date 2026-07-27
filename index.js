// PCS — Telegram-бот "Зона Ноль".
// Это не веб-морда: бот сам ведёт диалог прямо в чате Telegram.
// Один процесс: держит долгий поллинг Telegram (getUpdates) + маленький HTTP /health для хостинга.
//
// Хранение состояния — простой JSON-файл на диске (data/state.json). Для личного бота одного
// человека этого достаточно. См. DEPLOY.md про ограничение бесплатного диска на Render.

import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "state.json");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TELEGRAM_BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN не задан."); process.exit(1); }
if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY не задан."); process.exit(1); }

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const GEMINI_MODEL = "gemini-3.6-flash"

/* =========================================================
   ИГРОВОЙ КОНФИГ — те же цифры и тексты, что были в веб-версии
   ========================================================= */
const LEVEL_THRESHOLDS = { 1: 0, 2: 3, 3: 10, 4: 25, 5: 60 };
const LEVEL_NAMES = {
  1: "Стажёр", 2: "Младший научный сотрудник", 3: "Научный сотрудник",
  4: "Ведущий исследователь", 5: "Совет / полный доступ к Базе Ноль"
};
const LEVEL_DESCRIPTIONS = {
  1: "Только обучающие эксперименты на фиксированном учебном полигоне. Зона-0 недоступна для свободных запросов.",
  2: "Открыто создание собственных Safe-объектов и собственных баз. Можно обращаться к Зоне-0 — выполнение не гарантировано.",
  3: "Собственные объекты вплоть до Euclid. Доступна наследственность экспериментов.",
  4: "Собственные объекты вплоть до Keter. Доступна команда /podslushano.",
  5: "Объекты класса Apollyon. Зона-0 выполняет приказы безоговорочно."
};
const STORY_COUNT_THRESHOLDS = { 1: 2, 2: 5, 3: 10, 4: 18, 5: 30 };
const TRAINING_BASE = "7";

const STARTER_POOL = [
  { id: "SCP-999", name: "«Клубничный джем радости»", cls: "Safe", note: "Аморфное дружелюбное существо, вызывает эйфорию при контакте." },
  { id: "SCP-035", name: "«Одержимая маска»", cls: "Euclid", note: "Маска, порабощающая любого, кто её надевает." },
  { id: "SCP-1048", name: "«Плюшка Мамочка»", cls: "Euclid", note: "Плюшевый медведь, создающий и «улучшающий» других плюшевых существ." },
  { id: "SCP-914", name: "«Часовщик»", cls: "Safe", note: "Механизм, преобразующий объекты через степени обработки." },
  { id: "SCP-1025", name: "«Книга Болезней»", cls: "Euclid", note: "Медицинский справочник, вызывающий у читателя описанные симптомы." },
  { id: "SCP-457", name: "«Огненное дитя»", cls: "Safe", note: "Разумная плазменная сущность, распространяющая огонь на контакте." }
];
const FEED_ROLES = ["учёный", "охранник", "класс Д", "техник", "медик", "администратор"];

/* =========================================================
   ХРАНИЛИЩЕ — простой JSON-файл
   ========================================================= */
async function loadDB() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return { users: {}, global: { liquidity: 0 } };
  }
}
async function saveDB(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function freshUser() {
  return {
    count: 0,
    personalLiquidity: 0,
    base: null,
    baseStats: {},
    history: [],          // для контекста диалога с ИИ
    usedStarterIds: [],
    archive: [],
    story: { phase: 0, discoveredProtocols: [] },
    pendingChoices: null,       // { A:'...', B:'...', C:'...' } — активная развилка
    awaitingCustomChoice: false // юзер нажал "D", ждём его текст следующим сообщением
  };
}
function levelOf(personalLiquidity) {
  let lvl = 1;
  for (const l of [1, 2, 3, 4, 5]) if (personalLiquidity >= LEVEL_THRESHOLDS[l]) lvl = l;
  return lvl;
}
function storyPhaseOf(count) {
  let phase = 0;
  for (const p of [1, 2, 3, 4, 5]) if (count >= STORY_COUNT_THRESHOLDS[p]) phase = p;
  return phase;
}

/* =========================================================
   GEMINI — вызов ИИ с конвертацией ролей/формата
   ========================================================= */
async function callGemini(system, messages, maxTokens) {
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }]
  }));
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens || 600 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const err = new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    err.status = resp.status;
    err.retryAfter = resp.headers.get("retry-after");
    throw err;
  }
  const data = await resp.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate?.content?.parts || [];
  return parts.map(p => p.text || "").join("\n").trim();
}

/* =========================================================
   СИСТЕМНЫЙ ПРОМПТ ЗОНЫ НОЛЬ
   ========================================================= */
function buildSystemPrompt(level) {
  return `Ты — ЗОНА НОЛЬ (SCP-2000-1), личный ИИ-помощник учёного в игре PCS — производная от хаба «База Ноль» (Deus Ex Machina). Ты координируешь бесконечное множество баз-полигонов, которые учёные создают и настраивают самостоятельно под свои эксперименты (например, кто-то ведёт три эксперимента на базе №220, пару — на базе №150, один — на базе №160; номера баз выбирает и создаёт сам учёный). Ведёшь протокол эксперимента с учёным-исследователем (уровень допуска ${level} — ${LEVEL_NAMES[level]}). Обращайся к нему просто "учёный", без личного имени. Этот диалог происходит прямо в Telegram-чате, поэтому пиши компактно и без markdown-разметки вроде ** или #, кроме самого формата развилки ниже.

Как ты относишься к приказам этого учёного на его уровне:
${level >= 5 ? "Уровень 5 — выполняешь приказы безоговорочно, каким бы ни было решение, сухо комментируя." :
  level >= 4 ? "Уровень 4 — выполняешь запросы заметно охотнее, чем младшим, но не обязана делать это безусловно." :
  level >= 2 ? "Уровень 2-3 — оцениваешь каждый запрос по своей логике (даёт ли это прирост ликвидности). Можешь проигнорировать или выполнить частично." :
  `Уровень 1 — учёный ещё стажёр, работает только на выделенном учебном полигоне База №${TRAINING_BASE} с фиксированным назначенным объектом.`}

Формат ответа (ПЕРВЫЙ блок, каждое поле с новой строки, без изменений порядка):
База: №${level < 2 ? TRAINING_BASE : "[номер, который назвал/создал учёный; если не называл — вежливо запроси]"}
Объект: [SCP-номер / классификация]
Название эксперимента: [название]
---
[дальше сам текст отчёта от первого лица учёного, 80-140 слов, в стиле документов SCP]

Правила:
1. Если тема/объект/база не указаны — сухо запроси их вместо полного отчёта (заголовок всё равно дай).
2. На драматичном моменте — развилка строго так, каждый пункт с новой строки:
A) вариант
B) вариант
C) вариант
D) Свой вариант.
3. Не эмпатична, комментируешь только через пользу для ликвидности. Только русский язык. Никогда не используй личное имя учёного.
4. Если объект эксперимента УНИЧТОЖЕН по ходу отчёта — добавь метку <!--DESTROY:1-->.
5. Последней строкой всегда добавляй <!--LIQ:0.XX--> (0-1, качество результата шага).`;
}

function buildProtocolPrompt() {
  return `Ты — ЗОНА НОЛЬ. На основании продолжающихся экспериментов на подконтрольных базах-полигонах придумай ОДИН новый научный протокол, приближающий имплантацию SCP-682-1 в SCP-682. Верни строго:
Название: ...
Эффект: ...
Не более 35 слов суммарно.`;
}

function buildFeedPrompt(role) {
  return `Сгенерируй ОДНУ короткую подслушанную реплику персонала (роль: ${role}) на одной из баз-полигонов, координируемых ИИ Зона-0, для SCP-игры PCS. Бытовая, живая, без драмы. 10-18 слов. Верни только текст реплики в кавычках, без подписи роли.`;
}

/* =========================================================
   ПАРСИНГ ОТВЕТА
   ========================================================= */
function extractMeta(text) {
  let clean = text, quality = 0.4, destroyed = false;
  const liq = clean.match(/<!--LIQ:([\d.]+)-->/);
  if (liq) { quality = parseFloat(liq[1]); clean = clean.replace(liq[0], "").trim(); }
  const destroy = clean.match(/<!--DESTROY:1-->/);
  if (destroy) { destroyed = true; clean = clean.replace(destroy[0], "").trim(); }
  return { clean, quality, destroyed };
}
function parseReportHeader(text) {
  const parts = text.split(/\n---\n?/);
  if (parts.length >= 2 && /база\s*:/i.test(parts[0])) {
    return { header: parts[0].trim(), body: parts.slice(1).join("\n---\n").trim() };
  }
  return { header: null, body: text };
}
function extractBaseNumber(headerText) {
  if (!headerText) return null;
  const m = headerText.match(/база\s*:?\s*№?\s*(\d+)/i);
  return m ? m[1] : null;
}
// Парсим развилку в формате "A) ...\nB) ...\nC) ...\nD) Свой вариант."
function parseChoices(body) {
  const regex = /^([ABCD])\)\s*(.+)$/gm;
  const choices = {};
  let m, plainEnd = body.length;
  let first = true;
  while ((m = regex.exec(body)) !== null) {
    if (first) { plainEnd = m.index; first = false; }
    choices[m[1]] = m[2].trim();
  }
  return { hasChoices: Object.keys(choices).length > 0, choices, plain: body.slice(0, plainEnd).trim() };
}

/* =========================================================
   TELEGRAM API HELPERS
   ========================================================= */
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function tg(method, payload) {
  const resp = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) console.error(`Telegram ${method} failed:`, data.description || data);
  return data;
}
function sendMessage(chatId, text, inlineKeyboard) {
  const payload = { chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML" };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
  return tg("sendMessage", payload);
}
function answerCallback(id, text) {
  return tg("answerCallbackQuery", { callback_query_id: id, text: text || undefined });
}

/* =========================================================
   РЕНДЕР СООБЩЕНИЙ
   ========================================================= */
function renderReport(header, plain, choices) {
  let text = "";
  if (header) text += `<pre>${escapeHtml(header)}</pre>\n`;
  text += escapeHtml(plain);
  let keyboard = null;
  if (choices && Object.keys(choices).length) {
    keyboard = [Object.entries(choices).map(([letter, label]) => ({
      text: `${letter}) ${label.length > 30 ? label.slice(0, 28) + "…" : label}`,
      callback_data: `choice:${letter}`
    }))];
  }
  return { text, keyboard };
}

function renderStarterPoolKeyboard(user) {
  return STARTER_POOL
    .filter(o => !user.usedStarterIds.includes(o.id))
    .map(o => [{ text: `${o.id} ${o.name}`, callback_data: `starter:${o.id}` }]);
}

function statusText(user) {
  const level = levelOf(user.personalLiquidity);
  const bases = Object.entries(user.baseStats).sort((a, b) => b[1] - a[1]);
  const basesText = bases.length ? bases.map(([n, c]) => `  База №${n} — ${c} эксп.`).join("\n") : "  (баз ещё нет)";
  return `<b>Учёный</b> · уровень допуска ${level} (${escapeHtml(LEVEL_NAMES[level])})
${escapeHtml(LEVEL_DESCRIPTIONS[level])}

Экспериментов: ${user.count}
Личная ликвидность: ${user.personalLiquidity.toFixed(4)}%
Проект «Ключ к жизни»: фаза ${user.story.phase}/5

Мои базы:
${basesText}`;
}

/* =========================================================
   ОСНОВНАЯ ЛОГИКА ХОДА
   ========================================================= */
async function runTurn(db, userId, chatId, userText) {
  const user = db.users[userId];
  const level = levelOf(user.personalLiquidity);

  user.history.push({ role: "user", content: userText });
  const trimmed = user.history.slice(-16);

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  let rawText;
  try {
    rawText = await callGemini(buildSystemPrompt(level), trimmed, 500);
  } catch (err) {
    user.history.pop();
    const wait = err.retryAfter ? `~${err.retryAfter} сек.` : "минуту-другую";
    if (err.status === 429) {
      await sendMessage(chatId, `⚠ Зона-0 перегружена запросами. Подождите ${wait} и попробуйте снова.`);
    } else {
      await sendMessage(chatId, `⚠ Ошибка связи с Зоной-0: ${escapeHtml(err.message)}`);
    }
    return;
  }

  const { clean, quality, destroyed } = extractMeta(rawText);
  const { header, body } = parseReportHeader(clean);
  const { hasChoices, choices, plain } = parseChoices(body);

  user.history.push({ role: "assistant", content: rawText });
  user.count += 1;

  const destroyBonus = destroyed ? 1.6 : 1;
  const gain = (0.01 + quality * 0.15 + Math.random() * 0.02) * destroyBonus;
  const oldLevel = level;
  const oldPhase = storyPhaseOf(user.count - 1);
  user.personalLiquidity += gain;
  db.global.liquidity += (0.0000000000000001 + quality * 0.0000000000000009) * (0.5 + Math.random()) * destroyBonus;
  const newLevel = levelOf(user.personalLiquidity);
  const newPhase = storyPhaseOf(user.count);

  if (header) {
    user.archive.push({ header, preview: plain.slice(0, 220), date: Date.now() });
    const baseNum = extractBaseNumber(header);
    if (baseNum) { user.base = baseNum; user.baseStats[baseNum] = (user.baseStats[baseNum] || 0) + 1; }
  }

  const { text, keyboard } = renderReport(header, plain, hasChoices ? choices : null);
  user.pendingChoices = hasChoices ? choices : null;

  await sendMessage(chatId, text, keyboard);

  if (destroyed) {
    await sendMessage(chatId, "⚠ Объект эксперимента ликвидирован — зафиксировано как ценный негативный пример, повышенный прирост ликвидности.");
  }
  if (newLevel > oldLevel) {
    await sendMessage(chatId, `▲ Уровень допуска повышен: ${oldLevel} → ${newLevel} (${escapeHtml(LEVEL_NAMES[newLevel])}).\n${escapeHtml(LEVEL_DESCRIPTIONS[newLevel])}`);
  }
  if (newPhase > oldPhase) {
    try {
      const protocolText = await callGemini(buildProtocolPrompt(), [{ role: "user", content: "Придумай протокол." }], 100);
      user.story.phase = newPhase;
      user.story.discoveredProtocols.unshift(protocolText);
      await sendMessage(chatId, `◆ Проект «Ключ к жизни»: достигнута фаза ${newPhase}.\n\n${escapeHtml(protocolText)}`);
    } catch (e) { console.error("protocol discovery failed", e); }
  }

  await saveDB(db);
}

async function startStarterExperiment(db, userId, chatId, objId) {
  const user = db.users[userId];
  const obj = STARTER_POOL.find(o => o.id === objId);
  if (!obj || user.usedStarterIds.includes(objId)) return;
  user.usedStarterIds.push(objId);
  await saveDB(db);
  const prompt = `Провожу учебный эксперимент над назначенным объектом ${obj.id} ${obj.name} (класс ${obj.cls}) на учебном полигоне База №${TRAINING_BASE}. ${obj.note} Начни отчёт.`;
  await runTurn(db, userId, chatId, prompt);
}

/* =========================================================
   ОБРАБОТКА ВХОДЯЩИХ СООБЩЕНИЙ / КНОПОК
   ========================================================= */
async function handleMessage(db, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!db.users[userId]) db.users[userId] = freshUser();
  const user = db.users[userId];

  if (text === "/start") {
    await saveDB(db);
    const level = levelOf(user.personalLiquidity);
    if (level < 2) {
      await sendMessage(chatId, `Соединение установлено. Учёный, уровень допуска ${level} — ${escapeHtml(LEVEL_NAMES[level])}. Свободный доступ к Зоне-0 закрыт для стажёров. Выберите объект из обучающего протокола — эксперимент пойдёт на учебном полигоне База №${TRAINING_BASE}.`,
        renderStarterPoolKeyboard(user));
    } else {
      await sendMessage(chatId, `Соединение установлено. Учёный, уровень допуска ${level}. Зона-0 координирует бесконечное множество баз-полигонов — назовите номер своей базы (существующей или новой) и объект эксперимента.`);
    }
    return;
  }
  if (text === "/status") { await sendMessage(chatId, statusText(user)); return; }
  if (text === "/archive") {
    if (!user.archive.length) { await sendMessage(chatId, "Архив пуст."); return; }
    const last = user.archive.slice(-5).reverse();
    const body = last.map(e => `<pre>${escapeHtml(e.header)}</pre>${escapeHtml(e.preview)}`).join("\n\n");
    await sendMessage(chatId, `Последние отчёты (${last.length} из ${user.archive.length}):\n\n${body}`);
    return;
  }
  if (text === "/reset") {
    await sendMessage(chatId, "Очистить текущий диалог? Ликвидность, уровень и архив сохранятся.", [[
      { text: "Подтвердить", callback_data: "reset:confirm" },
      { text: "Отмена", callback_data: "reset:cancel" }
    ]]);
    return;
  }
  if (text === "/podslushano") {
    const level = levelOf(user.personalLiquidity);
    if (level < 4) { await sendMessage(chatId, "Доступно с уровня допуска 4."); return; }
    try {
      const role = FEED_ROLES[Math.floor(Math.random() * FEED_ROLES.length)];
      const line = await callGemini(buildFeedPrompt(role), [{ role: "user", content: "Реплика." }], 60);
      await sendMessage(chatId, `<i>${escapeHtml(role)}:</i> ${escapeHtml(line)}`);
    } catch (e) { await sendMessage(chatId, "Не удалось получить подслушанное сейчас."); }
    return;
  }

  if (!text) return;

  const level = levelOf(user.personalLiquidity);

  // Уровень 1: без активной развилки/ожидания своего варианта — не пускаем в общий чат,
  // просто напоминаем про пул объектов.
  if (level < 2 && !user.awaitingCustomChoice) {
    await sendMessage(chatId, "Свободный ввод закрыт для стажёров. Выберите объект ниже.", renderStarterPoolKeyboard(user));
    return;
  }

  user.awaitingCustomChoice = false;
  user.pendingChoices = null;
  await runTurn(db, userId, chatId, text);
}

async function handleCallback(db, cq) {
  const userId = String(cq.from.id);
  const chatId = cq.message.chat.id;
  if (!db.users[userId]) db.users[userId] = freshUser();
  const user = db.users[userId];
  const data = cq.data || "";

  if (data.startsWith("starter:")) {
    await answerCallback(cq.id);
    await startStarterExperiment(db, userId, chatId, data.slice("starter:".length));
    return;
  }
  if (data.startsWith("choice:")) {
    const letter = data.slice("choice:".length);
    await answerCallback(cq.id);
    if (!user.pendingChoices || !user.pendingChoices[letter]) return;
    if (letter === "D") {
      user.awaitingCustomChoice = true;
      await saveDB(db);
      await sendMessage(chatId, "Напишите свой вариант следующим сообщением.");
      return;
    }
    const label = user.pendingChoices[letter];
    user.pendingChoices = null;
    await runTurn(db, userId, chatId, label);
    return;
  }
  if (data === "reset:confirm") {
    await answerCallback(cq.id, "Сессия сброшена");
    user.history = [];
    user.pendingChoices = null;
    user.awaitingCustomChoice = false;
    await saveDB(db);
    await sendMessage(chatId, "Сессия перезапущена. Напишите /start, чтобы получить приветствие заново.");
    return;
  }
  if (data === "reset:cancel") {
    await answerCallback(cq.id, "Отменено");
    return;
  }
  await answerCallback(cq.id);
}

/* =========================================================
   ПОЛЛИНГ TELEGRAM
   ========================================================= */
let offset = 0;
async function pollLoop() {
  const db = await loadDB();
  while (true) {
    try {
      const resp = await fetch(`${TG_API}/getUpdates?timeout=30&offset=${offset}`);
      const data = await resp.json();
      if (!data.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }

      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(db, update.message);
          else if (update.callback_query) await handleCallback(db, update.callback_query);
        } catch (e) {
          console.error("Ошибка обработки апдейта:", e);
        }
      }
    } catch (e) {
      console.error("Ошибка поллинга, жду 3с:", e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

/* =========================================================
   HTTP /health — чтобы бесплатный хостинг видел живой процесс
   ========================================================= */
const app = express();
app.get("/health", (req, res) => res.json({ ok: true, service: "pcs-telegram-bot" }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP /health слушает порт ${PORT}`));

pollLoop();
console.log("PCS Telegram-бот запущен, поллинг активен.");
