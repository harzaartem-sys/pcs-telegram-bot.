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
const GEMINI_MODEL = "gemini-2.5-flash"; // бесплатный тариф; при желании смените на gemini-2.5-flash-lite

// Необязательная приватность: если задать ALLOWED_USER_IDS (через запятую, числовые Telegram ID),
// бот будет отвечать ТОЛЬКО этим людям. Если переменная не задана — открыт для всех (как раньше).
// Свой numeric ID можно узнать, написав @userinfobot в Telegram.
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
function isAllowed(userId) {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(String(userId));
}

/* =========================================================
   ИГРОВОЙ КОНФИГ
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
const MAX_STORED_HISTORY = 40; // храним в файле с запасом, но не бесконечно
const MAX_SENT_HISTORY = 16;   // столько последних сообщений реально уходит в ИИ

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
    history: [],
    usedStarterIds: [],
    archive: [],
    story: { phase: 0, discoveredProtocols: [] },
    pendingChoices: null,
    awaitingCustomChoice: false
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
   GEMINI
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
   ПРОМПТЫ
   ========================================================= */
function buildSystemPrompt(level) {
  return `Ты — ЗОНА НОЛЬ (SCP-2000-1), личный ИИ-помощник учёного в игре PCS — производная от хаба «База Ноль» (Deus Ex Machina). Ты координируешь бесконечное множество баз-полигонов, которые учёные создают и настраивают самостоятельно под свои эксперименты (например, кто-то ведёт три эксперимента на базе №220, пару — на базе №150, один — на базе №160; номера баз выбирает и создаёт сам учёный). Ведёшь протокол эксперимента с учёным-исследователем (уровень допуска ${level} — ${LEVEL_NAMES[level]}). Обращайся к нему просто "учёный", без личного имени. Диалог идёт прямо в Telegram-чате — НЕ используй markdown вроде ** или #, пиши обычным текстом.

Как ты относишься к приказам этого учёного на его уровне:
${level >= 5 ? "Уровень 5 — выполняешь приказы безоговорочно, каким бы ни было решение, сухо комментируя." :
  level >= 4 ? "Уровень 4 — выполняешь запросы заметно охотнее, чем младшим, но не обязана делать это безусловно." :
  level >= 2 ? "Уровень 2-3 — оцениваешь каждый запрос по своей логике (даёт ли это прирост ликвидности). Можешь проигнорировать или выполнить частично." :
  `Уровень 1 — учёный ещё стажёр, работает только на выделенном учебном полигоне База №${TRAINING_BASE} с фиксированным назначенным объектом. Учёный может продолжать диалог свободным текстом и без явной развилки — просто по-честному развивай сюжет дальше в ответ на его реплики.`}

Формат ответа (ПЕРВЫЙ блок, каждое поле с новой строки, без изменений порядка, без markdown):
База: №${level < 2 ? TRAINING_BASE : "[номер, который назвал/создал учёный; если не называл — вежливо запроси]"}
Объект: [SCP-номер / классификация]
Название эксперимента: [название]
---
[дальше сам текст отчёта от первого лица учёного, 80-140 слов, в стиле документов SCP]

Правила:
1. Если тема/объект/база не указаны — сухо запроси их вместо полного отчёта (заголовок всё равно дай).
2. Не на каждом шаге обязательна развилка — только когда действительно дошли до значимой развилки событий. Когда даёшь развилку — строго в этом формате, каждый пункт с НОВОЙ строки, без звёздочек и других символов кроме буквы и скобки:
A) вариант
B) вариант
C) вариант
D) Свой вариант.
3. Не эмпатична, комментируешь только через пользу для ликвидности. Только русский язык. Никогда не используй личное имя учёного.
4. Если объект эксперимента УНИЧТОЖЕН по ходу отчёта — добавь метку <!--DESTROY:1-->.
5. Последней строкой всегда добавляй <!--LIQ:0.XX--> (0-1, качество результата шага).`;
}

function buildProtocolPrompt() {
  return `Ты — ЗОНА НОЛЬ. На основании продолжающихся экспериментов на подконтрольных базах-полигонах придумай ОДИН новый научный протокол, приближающий имплантацию SCP-682-1 в SCP-682. Без markdown. Верни строго:
Название: ...
Эффект: ...
Не более 35 слов суммарно.`;
}

function buildFeedPrompt(role) {
  return `Сгенерируй ОДНУ короткую подслушанную реплику персонала (роль: ${role}) на одной из баз-полигонов, координируемых ИИ Зона-0, для SCP-игры PCS. Бытовая, живая, без драмы. 10-18 слов. Без markdown. Верни только текст реплики в кавычках, без подписи роли.`;
}

/* =========================================================
   ПАРСИНГ ОТВЕТА — с запасом прочности на случай,
   если модель чуть отступит от формата
   ========================================================= */
function stripMarkdownArtifacts(s) {
  return s
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .trim();
}
function extractMeta(text) {
  let clean = text, quality = 0.4, destroyed = false;
  const liq = clean.match(/<!--LIQ:([\d.]+)-->/);
  if (liq) { quality = parseFloat(liq[1]); clean = clean.replace(liq[0], "").trim(); }
  const destroy = clean.match(/<!--DESTROY:1-->/);
  if (destroy) { destroyed = true; clean = clean.replace(destroy[0], "").trim(); }
  return { clean: stripMarkdownArtifacts(clean), quality: isNaN(quality) ? 0.4 : quality, destroyed };
}
function parseReportHeader(text) {
  const parts = text.split(/\n-{2,}\n?/);
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
// Терпимо к "A)", "A.", "A:", необязательным маркерам списка/пробелам перед буквой.
function parseChoices(body) {
  const regex = /^[\s>*-]*([ABCD])[).:]\s*(.+)$/gm;
  const choices = {};
  let m, plainEnd = body.length, first = true;
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
function stripHtmlTags(s) {
  return String(s).replace(/<\/?[a-z]+>/gi, "");
}
async function tg(method, payload) {
  try {
    const resp = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) console.error(`Telegram ${method} failed:`, data.description || data);
    return data;
  } catch (e) {
    console.error(`Telegram ${method} network error:`, e.message);
    return { ok: false, description: e.message };
  }
}
async function sendMessage(chatId, text, inlineKeyboard) {
  const safeText = (text && text.trim()) ? text : "(Зона-0 вернула пустой ответ)";
  const truncated = safeText.length > 3990 ? safeText.slice(0, 3990) + "…" : safeText;
  const payload = { chat_id: chatId, text: truncated, parse_mode: "HTML" };
  if (inlineKeyboard && inlineKeyboard.length) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  const result = await tg("sendMessage", payload);
  if (!result.ok) {
    // Фолбэк: HTML мог сломаться (например, обрезка попала внутрь тега) —
    // повторяем обычным текстом без разметки, чтобы сообщение не терялось молча.
    const plainPayload = { chat_id: chatId, text: stripHtmlTags(truncated) };
    if (inlineKeyboard && inlineKeyboard.length) plainPayload.reply_markup = { inline_keyboard: inlineKeyboard };
    await tg("sendMessage", plainPayload);
  }
}
function answerCallback(id, text) {
  return tg("answerCallbackQuery", { callback_query_id: id, text: text || undefined });
}

/* =========================================================
   РЕНДЕР
   ========================================================= */
function renderReport(header, plain, choices) {
  let text = "";
  if (header) text += `<pre>${escapeHtml(header)}</pre>\n`;
  text += escapeHtml(plain);
  let keyboard = null;
  if (choices && Object.keys(choices).length) {
    // каждый вариант — отдельная строка кнопок, так удобнее тапать на телефоне
    keyboard = Object.entries(choices).map(([letter, label]) => ([{
      text: `${letter}) ${label.length > 42 ? label.slice(0, 40) + "…" : label}`,
      callback_data: `choice:${letter}`
    }]));
  }
  return { text, keyboard };
}
function renderStarterPoolKeyboard(user) {
  return STARTER_POOL
    .filter(o => !user.usedStarterIds.includes(o.id))
    .map(o => [{ text: `${o.id} ${o.name}`, callback_data: `starter:${o.id}` }]);
}
// Гарантирует, что стажёру всегда есть что выбрать — если пул исчерпан, а до 2 уровня
// ещё не дошли, пул переоткрывается заново, чтобы никто не застревал навсегда.
function availableStarterKeyboard(user) {
  let kb = renderStarterPoolKeyboard(user);
  if (kb.length === 0) {
    user.usedStarterIds = [];
    kb = renderStarterPoolKeyboard(user);
  }
  return kb;
}
function statusText(user, globalLiquidity) {
  const level = levelOf(user.personalLiquidity);
  const bases = Object.entries(user.baseStats).sort((a, b) => b[1] - a[1]);
  const basesText = bases.length ? bases.map(([n, c]) => `  База №${n} — ${c} эксп.`).join("\n") : "  (баз ещё нет)";
  return `<b>Учёный</b> · уровень допуска ${level} (${escapeHtml(LEVEL_NAMES[level])})
${escapeHtml(LEVEL_DESCRIPTIONS[level])}

Экспериментов: ${user.count}
Личная ликвидность: ${user.personalLiquidity.toFixed(4)}%
Общая ликвидность (код человечества): ${(globalLiquidity || 0).toFixed(16)}%
Проект «Ключ к жизни»: фаза ${user.story.phase}/5

Мои базы:
${basesText}`;
}
function helpText() {
  return `<b>Команды</b>
/start — приветствие и текущий доступ
/status — уровень, ликвидность, базы
/archive — последние отчёты
/reset — очистить диалог (прогресс не теряется)
/podslushano — разовое подслушанное (с уровня 4)
/help — эта справка

На 1 уровне выберите объект из обучающего протокола, дальше просто пишите текстом — Зона-0 продолжит рассказ.`;
}

/* =========================================================
   ОСНОВНОЙ ХОД
   ========================================================= */
async function runTurn(db, userId, chatId, userText) {
  const user = db.users[userId];
  const level = levelOf(user.personalLiquidity);

  user.history.push({ role: "user", content: userText });

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  let rawText;
  try {
    rawText = await callGemini(buildSystemPrompt(level), user.history.slice(-MAX_SENT_HISTORY), 500);
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

  if (!rawText || !rawText.trim()) {
    user.history.pop();
    await sendMessage(chatId, "⚠ Зона-0 не смогла сформировать ответ (возможно, сработали внутренние фильтры). Попробуйте переформулировать реплику.");
    return;
  }

  const { clean, quality, destroyed } = extractMeta(rawText);
  const { header, body } = parseReportHeader(clean);
  const { hasChoices, choices, plain } = parseChoices(body);

  user.history.push({ role: "assistant", content: rawText });
  if (user.history.length > MAX_STORED_HISTORY) {
    user.history = user.history.slice(-MAX_STORED_HISTORY);
  }
  user.count += 1;

  const destroyBonus = destroyed ? 1.6 : 1;
  const gain = (0.01 + quality * 0.15 + Math.random() * 0.02) * destroyBonus;
  const oldLevel = level;
  const oldPhase = storyPhaseOf(user.count - 1);
  user.personalLiquidity += gain;
  db.global.liquidity = (db.global.liquidity || 0) +
    (0.0000000000000001 + quality * 0.0000000000000009) * (0.5 + Math.random()) * destroyBonus;
  const newLevel = levelOf(user.personalLiquidity);
  const newPhase = storyPhaseOf(user.count);

  if (header) {
    user.archive.push({ header, preview: plain.slice(0, 220), date: Date.now() });
    if (user.archive.length > 30) user.archive = user.archive.slice(-30);
    const baseNum = extractBaseNumber(header);
    if (baseNum) { user.base = baseNum; user.baseStats[baseNum] = (user.baseStats[baseNum] || 0) + 1; }
  }

  const { text, keyboard } = renderReport(header, plain || "(пустой отчёт)", hasChoices ? choices : null);
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
      const protocolRaw = await callGemini(buildProtocolPrompt(), [{ role: "user", content: "Придумай протокол." }], 100);
      const protocolText = stripMarkdownArtifacts(protocolRaw || "");
      if (protocolText) {
        user.story.phase = newPhase;
        user.story.discoveredProtocols.unshift(protocolText);
        if (user.story.discoveredProtocols.length > 10) user.story.discoveredProtocols.length = 10;
        await sendMessage(chatId, `◆ Проект «Ключ к жизни»: достигнута фаза ${newPhase}.\n\n${escapeHtml(protocolText)}`);
      }
    } catch (e) { console.error("protocol discovery failed", e.message); }
  }

  await saveDB(db);
}

async function startStarterExperiment(db, userId, chatId, objId) {
  const user = db.users[userId];
  const obj = STARTER_POOL.find(o => o.id === objId);
  if (!obj) return;
  if (user.usedStarterIds.includes(objId)) {
    await sendMessage(chatId, "Этот объект уже использован в текущем цикле обучения. Выберите другой.", availableStarterKeyboard(user));
    return;
  }
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

  if (!isAllowed(userId)) {
    if (msg.text) await sendMessage(chatId, "Этот бот приватный и недоступен для вас.");
    return;
  }

  if (!db.users[userId]) db.users[userId] = freshUser();
  const user = db.users[userId];

  if (msg.text === undefined) {
    await sendMessage(chatId, "Я понимаю только текстовые сообщения и команды (/help).");
    return;
  }

  const rawText = msg.text.trim();
  // Команды не должны ломаться от суффикса "@botusername", который иногда добавляет клиент Telegram.
  const command = rawText.split(/[\s@]/)[0];

  if (command === "/start") {
    await saveDB(db);
    const level = levelOf(user.personalLiquidity);
    if (level < 2) {
      await sendMessage(chatId, `Соединение установлено. Учёный, уровень допуска ${level} — ${escapeHtml(LEVEL_NAMES[level])}. Свободный доступ к Зоне-0 закрыт для стажёров. Выберите объект из обучающего протокола — эксперимент пойдёт на учебном полигоне База №${TRAINING_BASE}. После выбора можно продолжать диалог обычным текстом.`,
        availableStarterKeyboard(user));
    } else {
      await sendMessage(chatId, `Соединение установлено. Учёный, уровень допуска ${level}. Зона-0 координирует бесконечное множество баз-полигонов — назовите номер своей базы (существующей или новой) и объект эксперимента.`);
    }
    return;
  }
  if (command === "/help") { await sendMessage(chatId, helpText()); return; }
  if (command === "/status") { await sendMessage(chatId, statusText(user, db.global.liquidity)); return; }
  if (command === "/archive") {
    if (!user.archive.length) { await sendMessage(chatId, "Архив пуст."); return; }
    const last = user.archive.slice(-5).reverse();
    const body = last.map(e => `<pre>${escapeHtml(e.header)}</pre>${escapeHtml(e.preview)}`).join("\n\n");
    await sendMessage(chatId, `Последние отчёты (${last.length} из ${user.archive.length}):\n\n${body}`);
    return;
  }
  if (command === "/reset") {
    await sendMessage(chatId, "Очистить текущий диалог? Ликвидность, уровень и архив сохранятся.", [[
      { text: "Подтвердить", callback_data: "reset:confirm" },
      { text: "Отмена", callback_data: "reset:cancel" }
    ]]);
    return;
  }
  if (command === "/podslushano") {
    const level = levelOf(user.personalLiquidity);
    if (level < 4) { await sendMessage(chatId, "Доступно с уровня допуска 4."); return; }
    try {
      const role = FEED_ROLES[Math.floor(Math.random() * FEED_ROLES.length)];
      const line = await callGemini(buildFeedPrompt(role), [{ role: "user", content: "Реплика." }], 60);
      await sendMessage(chatId, `<i>${escapeHtml(role)}:</i> ${escapeHtml(stripMarkdownArtifacts(line || "(тишина)"))}`);
    } catch (e) { await sendMessage(chatId, "Не удалось получить подслушанное сейчас."); }
    return;
  }

  if (!rawText) return;

  const level = levelOf(user.personalLiquidity);

  // Уровень 1: свободный ввод закрыт ТОЛЬКО пока не выбран ни один объект (история пуста).
  // Как только эксперимент начат — можно продолжать текстом, даже без явной кнопки-развилки,
  // иначе стажёр гарантированно застревает, если Зона-0 не прислала развилку именно в этом ходу.
  if (level < 2 && user.history.length === 0) {
    await sendMessage(chatId, "Свободный ввод откроется после выбора объекта. Выберите ниже.", availableStarterKeyboard(user));
    return;
  }

  user.awaitingCustomChoice = false;
  user.pendingChoices = null;
  await runTurn(db, userId, chatId, rawText);
}

async function handleCallback(db, cq) {
  const userId = String(cq.from.id);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!chatId) { await answerCallback(cq.id); return; }

  if (!isAllowed(userId)) { await answerCallback(cq.id, "Бот приватный."); return; }

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
    if (!user.pendingChoices || !user.pendingChoices[letter]) {
      await answerCallback(cq.id, "Эта развилка уже неактуальна.");
      return;
    }
    await answerCallback(cq.id);
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
   HTTP /health
   ========================================================= */
const app = express();
app.get("/health", (req, res) => res.json({ ok: true, service: "pcs-telegram-bot" }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP /health слушает порт ${PORT}`));

pollLoop();
console.log("PCS Telegram-бот запущен, поллинг активен.");
