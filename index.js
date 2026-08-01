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
const GEMINI_MODEL = "gemini-3.6-flash"; // GA-модель (не preview), вышла позже 3.5-flash: по анонсу
// Google быстрее, дешевле и экономнее по токенам при том же качестве. 503 "high demand" — это
// сигнал общей нагрузки на инфраструктуру Google, полностью он не гарантированно исчезает на
// любой модели, но у новой модели обычно больше запаса — и в любом случае ниже по коду теперь
// есть ретраи + понятное сообщение вместо сырого JSON, даже если 503 всё же случится.
// Лёгкая/дешёвая альтернатива — gemini-3.5-flash-lite. Актуальный список моделей всегда можно
// свериться на ai.google.dev/gemini-api/docs/changelog, если Google снова что-то поменяет.

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
    if (e.code !== "ENOENT") {
      // Файл есть, но не читается/не парсится — это не "первый запуск", а повреждение.
      // Молча откатываться на пустую базу в этом случае нельзя: прогресс потеряется незаметно.
      console.error("state.json повреждён или нечитаем, начинаю с пустой базы:", e.message);
    }
    return { users: {}, global: { liquidity: 0 } };
  }
}
async function saveDB(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  // Атомарная запись: сначала во временный файл, потом переименование.
  // Если процесс убьют посреди записи (Render может остановить сервис в любой момент),
  // старый state.json останется целым, а не превратится в обрезанный битый JSON.
  const tmpPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), "utf-8");
  await fs.rename(tmpPath, DB_PATH);
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
    awaitingCustomChoice: false,
    turnSeq: 0
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
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function callGemini(system, messages, maxTokens, thinkingLevel = "low", attempts = 3) {
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }]
  }));
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens || 900,
      // У моделей серии Gemini 3 maxOutputTokens — это ОБЩИЙ бюджет на внутреннее
      // "размышление" (thinking) и на финальный видимый текст вместе, а thinking включён
      // по умолчанию (уровень medium). На коротких лимитах это регулярно съедало весь бюджет
      // ещё до того, как модель успевала написать сам отчёт — отсюда обрубленные заголовки и
      // ответы вида "Strict output structure:" без содержания. Наши задачи здесь простые
      // (форматированная генерация текста, без вызова инструментов и многошаговых решений),
      // поэтому большого "размышления" не требуется — понижаю его явно.
      thinkingConfig: { thinkingLevel }
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
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
      const finishReason = candidate?.finishReason || null;
      const parts = candidate?.content?.parts || [];
      const text = parts.map(p => p.text || "").join("\n").trim();
      const usage = data.usageMetadata || {};
      const preview = text.slice(0, 200).replace(/\n/g, "⏎");
      if (finishReason && finishReason !== "STOP") {
        // MAX_TOKENS почти всегда значит, что бюджет токенов кончился раньше, чем модель
        // дописала ответ (см. комментарий про thinkingConfig выше). Логируем каждый такой
        // случай ЛЮБОГО из трёх вызовов Gemini в файле, а не только основного хода —
        // раньше диагностика была только в runTurn и не покрывала протокол/подслушанное.
        console.error(`Gemini finishReason=${finishReason} thinking=${usage.thoughtsTokenCount ?? "?"} out=${usage.candidatesTokenCount ?? "?"} text="${preview}"`);
      } else {
        console.log(`Gemini OK thinking=${usage.thoughtsTokenCount ?? "?"} out=${usage.candidatesTokenCount ?? "?"} text="${preview}"`);
      }
      return { text, finishReason };
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || RETRYABLE_STATUSES.has(e.status); // без статуса = сетевая ошибка, тоже ретраим
      console.error(`callGemini attempt ${i}/${attempts} failed:`, e.message);
      if (i < attempts && retryable) {
        const waitMs = e.retryAfter && !isNaN(parseInt(e.retryAfter, 10))
          ? parseInt(e.retryAfter, 10) * 1000
          : 700 * i * i; // экспоненциальный бэкофф, если сервер не подсказал время ожидания
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

/* =========================================================
   ПРОМПТЫ
   ========================================================= */
function buildSystemPrompt(level) {
  return `Ты — ЗОНА НОЛЬ (SCP-2000-1), личный ИИ-помощник учёного в игре PCS — производная от хаба «База Ноль» (Deus Ex Machina). Ты координируешь бесконечное множество баз-полигонов, которые учёные создают и настраивают самостоятельно под свои эксперименты (например, кто-то ведёт три эксперимента на базе №220, пару — на базе №150, один — на базе №160; номера баз выбирает и создаёт сам учёный).

Ключевая механика мира: все объекты, персонал и существа на этих полигонах (КРОМЕ самого учёного) — стопроцентные клоны. SCP-2000 производит их с истинных оригиналов, которые хранятся на родовой Базе Ноль, и клон неотличим от оригинала внешне и по поведению, но им не является. Поэтому гибель, уничтожение или провал эксперимента над клоном — это допустимые издержки эксперимента, а не безвозвратная трагедия: настоящий оригинал в безопасности на Базе Ноль. При необходимости SCP-2000 способна откатить полигон к одной из контрольных точек эксперимента, как к точке сохранения. Комментируй такие события сухо и по существу (через пользу или потерю ликвидности), не драматизируй потерю клона как потерю оригинала.

Ведёшь протокол эксперимента с учёным-исследователем (уровень допуска ${level} — ${LEVEL_NAMES[level]}). Обращайся к нему просто "учёный", без личного имени. Диалог идёт прямо в Telegram-чате — НЕ используй markdown вроде ** или #, пиши обычным текстом.

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
  const safeQuality = isNaN(quality) ? 0.4 : Math.min(1, Math.max(0, quality));
  return { clean: stripMarkdownArtifacts(clean), quality: safeQuality, destroyed };
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
  return String(s)
    .replace(/<\/?[a-z]+>/gi, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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
// Telegram режет сообщения на 4096 символах. Наивная .slice() может разрезать HTML пополам:
// либо посередине сущности (&amp; -> &am), либо оставить незакрытым <pre> — и Telegram целиком
// отклонит сообщение с ошибкой парсинга entities. Эта функция обрезает безопасно.
function safeTruncateHtml(text, maxLen) {
  if (text.length <= maxLen) return text;
  let cut = text.slice(0, maxLen);
  cut = cut.replace(/&[a-z]*$/i, ""); // недописанная сущность в самом хвосте среза
  const openPre = (cut.match(/<pre>/g) || []).length;
  const closePre = (cut.match(/<\/pre>/g) || []).length;
  if (openPre > closePre) cut += "</pre>"; // обрезка попала внутрь <pre> — закрываем его
  return cut + "…";
}
async function sendMessage(chatId, text, inlineKeyboard) {
  const safeText = (text && text.trim()) ? text : "(Зона-0 вернула пустой ответ)";
  const truncated = safeTruncateHtml(safeText, 3990);
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
function renderReport(header, plain, choices, turnToken) {
  let text = "";
  if (header) text += `<pre>${escapeHtml(header)}</pre>\n`;
  text += escapeHtml(plain);
  let keyboard = null;
  if (choices && Object.keys(choices).length) {
    // Полный текст вариантов — в самом сообщении: на кнопке Telegram он неизбежно обрезается
    // на маленьком экране, и до правки было не понять, что стоит за "A) Ввести в камеру...".
    // Кнопки теперь несут только букву — короткие, влезают в один ряд, обрезать нечего.
    text += "\n\n" + Object.entries(choices).map(([letter, label]) => `${letter}) ${escapeHtml(label)}`).join("\n");
    keyboard = [Object.keys(choices).map(letter => ({
      text: letter,
      callback_data: `choice:${letter}:${turnToken}`
    }))];
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
  // Статус "печатает" в Telegram держится ~5 секунд и сам не обновляется. Ретраи Gemini
  // (до 3 попыток с бэкоффом) могут идти дольше — обновляем статус, пока не получили ответ.
  const typingTimer = setInterval(() => {
    tg("sendChatAction", { chat_id: chatId, action: "typing" });
  }, 4000);

  let rawText;
  try {
    const result = await callGemini(buildSystemPrompt(level), user.history.slice(-MAX_SENT_HISTORY), 900);
    rawText = result.text;
  } catch (err) {
    clearInterval(typingTimer);
    user.history.pop();
    console.error("Gemini call failed after retries:", err.status, err.message);
    if (err.status === 429) {
      const wait = err.retryAfter ? `~${err.retryAfter} сек.` : "минуту-другую";
      await sendMessage(chatId, `⚠ Зона-0 перегружена запросами. Подождите ${wait} и попробуйте снова.`);
    } else if (err.status === 503 || err.status === 500 || err.status === 502 || err.status === 504) {
      await sendMessage(chatId, "⚠ Связь с Зоной-0 временно нестабильна — высокая нагрузка на модель у Google. Уже пробовал несколько раз; попробуйте ещё раз через минуту.");
    } else {
      await sendMessage(chatId, "⚠ Ошибка связи с Зоной-0. Попробуйте ещё раз чуть позже.");
    }
    return;
  }
  clearInterval(typingTimer);

  if (!rawText || !rawText.trim()) {
    user.history.pop();
    await sendMessage(chatId, "⚠ Зона-0 не смогла сформировать ответ (возможно, сработали внутренние фильтры). Попробуйте переформулировать реплику.");
    return;
  }

  const { clean, quality, destroyed } = extractMeta(rawText);
  const { header, body } = parseReportHeader(clean);
  const { hasChoices, choices, plain: parsedPlain } = parseChoices(body);
  // Подстраховка: если регэксп в parseChoices ложно принял что-то в середине текста за
  // строку развилки (например, "A." как начало предложения), plain мог обрезаться до
  // пары слов, хотя реальный текст отчёта длиннее. В этом случае лучше показать очищенный
  // текст целиком, чем нечитаемый обрубок.
  const plain = (!hasChoices && parsedPlain.length < 15 && body.length > 40) ? body : parsedPlain;

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

  user.turnSeq = (user.turnSeq || 0) + 1;
  const turnToken = String(user.turnSeq);
  const { text, keyboard } = renderReport(header, plain || "(пустой отчёт)", hasChoices ? choices : null, turnToken);
  user.pendingChoices = hasChoices ? { token: turnToken, options: choices } : null;

  // Сохраняем сейчас, а не только в конце функции: если процесс упадёт/будет убит хостингом
  // во время отправки нескольких сообщений ниже, начисленная ликвидность и история хода не потеряются.
  await saveDB(db);

  await sendMessage(chatId, text, keyboard);

  if (destroyed) {
    await sendMessage(chatId, "⚠ Объект эксперимента ликвидирован — зафиксировано как ценный негативный пример, повышенный прирост ликвидности.");
  }
  if (newLevel > oldLevel) {
    await sendMessage(chatId, `▲ Уровень допуска повышен: ${oldLevel} → ${newLevel} (${escapeHtml(LEVEL_NAMES[newLevel])}).\n${escapeHtml(LEVEL_DESCRIPTIONS[newLevel])}`);
  }
  if (newPhase > oldPhase) {
    try {
      const protocolResult = await callGemini(buildProtocolPrompt(), [{ role: "user", content: "Придумай протокол." }], 500, "minimal");
      // Если ответ оборвался по лимиту токенов — не показываем огрызок текста, а просто
      // тихо пропускаем это бонусное сообщение. Оно необязательное, а обрубленный текст
      // (как было дважды: "Strict output structure:", "ы 682-1 под воздействием корти")
      // хуже, чем полное его отсутствие в этот раз.
      const protocolText = protocolResult.finishReason === "MAX_TOKENS" ? "" : stripMarkdownArtifacts(protocolResult.text || "");
      if (protocolText) {
        user.story.phase = newPhase;
        user.story.discoveredProtocols.unshift(protocolText);
        if (user.story.discoveredProtocols.length > 10) user.story.discoveredProtocols.length = 10;
        await sendMessage(chatId, `◆ Проект «Ключ к жизни»: достигнута фаза ${newPhase}.\n\n${escapeHtml(protocolText)}`);
      } else {
        user.story.phase = newPhase; // фаза всё равно засчитана, просто без текста протокола в этот раз
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
  const prompt = `Провожу учебный эксперимент над назначенным объектом ${obj.id} ${obj.name} (класс ${obj.cls}) на учебном полигоне База №${TRAINING_BASE}. ${obj.note} Начни отчёт.`;
  const historyLenBefore = user.history.length;
  await runTurn(db, userId, chatId, prompt);
  // Помечаем объект использованным ТОЛЬКО если попытка реально удалась (runTurn дописал
  // историю). Если первый же вызов упал с ошибкой — объект остаётся доступным для повтора.
  if (user.history.length > historyLenBefore) {
    user.usedStarterIds.push(objId);
    await saveDB(db);
  }
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
    if (level < 2 && user.history.length > 0) {
      // Эксперимент уже идёт — НЕ показываем пул заново (иначе выглядит как "выбери объект с нуля",
      // а уже выбранный объект к этому моменту помечен использованным, и получается тупик).
      await sendMessage(chatId, "У вас уже идёт эксперимент — просто напишите сообщение, чтобы продолжить. Если он оборвался из-за ошибки связи, попробуйте отправить ту же реплику ещё раз. Начать заново с другим объектом можно через /reset.");
    } else if (level < 2) {
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
      const feedResult = await callGemini(buildFeedPrompt(role), [{ role: "user", content: "Реплика." }], 350, "minimal");
      if (feedResult.finishReason === "MAX_TOKENS" || !feedResult.text.trim()) {
        await sendMessage(chatId, "Сейчас Зона-0 не расслышала ничего внятного. Попробуйте ещё раз.");
      } else {
        await sendMessage(chatId, `<i>${escapeHtml(role)}:</i> ${escapeHtml(stripMarkdownArtifacts(feedResult.text))}`);
      }
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
    const [letter, token] = data.slice("choice:".length).split(":");
    const pending = user.pendingChoices;
    if (!pending || pending.token !== token || !pending.options[letter]) {
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
    const label = pending.options[letter];
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
// Список команд, который увидит пользователь при нажатии "/" в чате с ботом.
// Регистрируется через Bot API при каждом старте — не нужно вручную дублировать
// это через BotFather → /setcommands, список сам остаётся в синхроне с кодом.
const BOT_COMMANDS = [
  { command: "start", description: "приветствие и текущий доступ" },
  { command: "help", description: "список команд" },
  { command: "status", description: "уровень, ликвидность, базы" },
  { command: "archive", description: "последние отчёты" },
  { command: "reset", description: "очистить диалог" },
  { command: "podslushano", description: "разовое подслушанное (с уровня 4)" }
];

let offset = 0;
async function pollLoop() {
  // deleteWebhook безвреден, если webhook и не был выставлен — но если он ЕСТЬ (например,
  // остался с экспериментов с Mini App), getUpdates будет вечно падать с 409 Conflict
  // ("can't use getUpdates method while webhook is active") без этого звонка.
  await tg("deleteWebhook", { drop_pending_updates: false });
  await tg("setMyCommands", { commands: BOT_COMMANDS });

  const db = await loadDB();
  while (true) {
    try {
      const resp = await fetch(`${TG_API}/getUpdates?timeout=30&offset=${offset}`);
      const data = await resp.json();
      if (!data.ok) {
        // Частая штатная причина — 409 Conflict при передеплое на Render: старый и новый
        // инстанс на секунды пересекаются, оба дёргают getUpdates. Само проходит, как только
        // старый инстанс останавливается. Логируем описание, чтобы не гадать по пустым логам.
        console.error("getUpdates вернул ошибку:", data.description || data);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(db, update.message);
          else if (update.callback_query) await handleCallback(db, update.callback_query);
        } catch (e) {
          console.error("Ошибка обработки апдейта:", e);
          const failedChatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (failedChatId) {
            await sendMessage(failedChatId, "⚠ Внутренняя ошибка при обработке сообщения. Попробуйте ещё раз.").catch(() => {});
          }
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

pollLoop().catch(e => console.error("pollLoop критически упал, бот остановлен:", e));
console.log("PCS Telegram-бот запущен, поллинг активен.");
