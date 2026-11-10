import http from "node:http";
import { Telegraf } from "telegraf";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ====== SOZLAMALAR (Render'da Environment Variables sifatida qo'yiladi) ======
const BOT_TOKEN = process.env.BOT_TOKEN; // BotFather'dan olingan token
const OWNER_ID = Number(process.env.OWNER_ID || 0); // Sizning Telegram ID'ngiz (cheklovsiz foydalanasiz)
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const MODEL_ID = process.env.MODEL_ID || "global.anthropic.claude-opus-5-5";
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4000); // egasi uchun
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 20); // oxirgi nechta xabar eslab qolinadi

// ====== Boshqalar uchun himoya (kreditingiz tez tugab qolmasligi uchun) ======
const PUBLIC_MODEL_ID = process.env.PUBLIC_MODEL_ID || MODEL_ID; // boshqalarga arzonroq model berish mumkin
const USER_MAX_TOKENS = Number(process.env.USER_MAX_TOKENS || 1200); // boshqalar javobi uzunligi
const USER_MAX_HISTORY = Number(process.env.USER_MAX_HISTORY || 8);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20); // bitta odamga kuniga xabar soni
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT || 300); // hamma uchun kunlik jami
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 5); // xabarlar orasidagi pauza

// AWS kalitlari SDK tomonidan o'zi o'qiladi:
//   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
//   yoki AWS_BEARER_TOKEN_BEDROCK (Bedrock API key)

if (!BOT_TOKEN) throw new Error("BOT_TOKEN topilmadi");

const bedrock = new BedrockRuntimeClient({ region: AWS_REGION });
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300_000 });

const SYSTEM_PROMPT =
  "Sen aqlli va foydali yordamchisan. Foydalanuvchi qaysi tilda yozsa, shu tilda javob ber " +
  "(asosan o'zbekcha). Javoblar aniq va qisqa bo'lsin. Kod so'ralsa, to'liq ishlaydigan kod yoz. " +
  "Telegram'da Markdown ko'rinmaydi, shuning uchun oddiy matn ishlat; kodni esa shundayligicha yoz.";

// chatId -> [{ role, content: [{ text }] }]
const histories = new Map();

const isOwnerId = (id) => OWNER_ID !== 0 && id === OWNER_ID;

function getHistory(chatId) {
  if (!histories.has(chatId)) {
    // Xotira to'lib ketmasligi uchun eng eskisini o'chiramiz
    if (histories.size >= 2000) histories.delete(histories.keys().next().value);
    histories.set(chatId, []);
  }
  return histories.get(chatId);
}

function trimHistory(history, limit) {
  while (history.length > limit) history.shift();
  // Suhbat doim "user" xabaridan boshlanishi kerak
  while (history.length && history[0].role !== "user") history.shift();
}

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

async function askClaude(chatId, userContent, historyText) {
  const owner = isOwnerId(chatId); // shaxsiy chatda chat.id == user.id
  const history = getHistory(chatId);

  // Joriy xabar (rasm bo'lsa rasm bilan) yuboriladi,
  // tarixga esa tokenni tejash uchun faqat matni saqlanadi.
  const messages = [...history, { role: "user", content: userContent }];

  const res = await bedrock.send(
    new ConverseCommand({
      modelId: owner ? MODEL_ID : PUBLIC_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      inferenceConfig: { maxTokens: owner ? MAX_TOKENS : USER_MAX_TOKENS },
    })
  );

  const parts = res.output?.message?.content ?? [];
  const answer =
    parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim() || "(bo'sh javob)";

  history.push({ role: "user", content: [{ text: historyText }] });
  history.push({ role: "assistant", content: [{ text: answer }] });
  trimHistory(history, owner ? MAX_HISTORY : USER_MAX_HISTORY);

  return { answer, usage: res.usage };
}

// ====== Hamma uchun ochiq, lekin limit bilan ======
const today = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // Toshkent kuni
const usage = new Map(); // userId -> { day, count }
const lastMsgAt = new Map(); // userId -> vaqt
let globalUsage = { day: today(), count: 0 };

bot.use(async (ctx, next) => {
  // Faqat shaxsiy chatlarda javob beramiz (guruhda har xabarga javob berib yubormasligi uchun)
  if (ctx.chat?.type !== "private") return;

  const uid = ctx.from.id;
  const isCommand = ctx.message?.text?.startsWith("/");
  if (isOwnerId(uid) || isCommand || !ctx.message) return next();

  // Kunlik hisoblagichni yangilash
  const d = today();
  if (globalUsage.day !== d) globalUsage = { day: d, count: 0 };
  let u = usage.get(uid);
  if (!u || u.day !== d) u = { day: d, count: 0 };

  // 1) Pauza
  const now = Date.now();
  const prev = lastMsgAt.get(uid) || 0;
  if (now - prev < COOLDOWN_SEC * 1000) {
    return ctx.reply(`Biroz sekinroq, ${COOLDOWN_SEC} soniya kuting.`);
  }

  // 2) Umumiy kunlik limit (kreditni himoya qilish)
  if (globalUsage.count >= GLOBAL_DAILY_LIMIT) {
    return ctx.reply("Bugun bot juda band bo'ldi, limit tugadi. Ertaga qayta yozing.");
  }

  // 3) Shaxsiy kunlik limit
  if (u.count >= DAILY_LIMIT) {
    return ctx.reply(`Bugungi limit (${DAILY_LIMIT} ta xabar) tugadi. Ertaga davom ettiramiz.`);
  }

  u.count += 1;
  usage.set(uid, u);
  globalUsage.count += 1;
  lastMsgAt.set(uid, now);
  return next();
});

bot.start((ctx) =>
  ctx.reply(
    "Salom! Men Claude Opus 5.5 bilan ishlaydigan botman.\n\n" +
      "Savol yozing yoki rasm yuboring.\n" +
      "/new - yangi suhbat boshlash"
  )
);

bot.command("new", (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply("Yangi suhbat boshlandi.");
});

bot.command("id", (ctx) => ctx.reply(`Sizning ID: ${ctx.from.id}`));

// ====== Matn ======
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  await ctx.sendChatAction("typing");
  const typing = setInterval(() => ctx.sendChatAction("typing").catch(() => {}), 4000);

  try {
    const { answer } = await askClaude(
      ctx.chat.id,
      [{ text }],
      text
    );
    await sendLong(ctx, answer);
  } catch (err) {
    console.error(err);
    await ctx.reply(friendlyError(err));
  } finally {
    clearInterval(typing);
  }
});

// ====== Rasm ======
bot.on("photo", async (ctx) => {
  await ctx.sendChatAction("typing");
  const typing = setInterval(() => ctx.sendChatAction("typing").catch(() => {}), 4000);

  try {
    const photos = ctx.message.photo;
    const biggest = photos[photos.length - 1];
    const link = await ctx.telegram.getFileLink(biggest.file_id);
    const resp = await fetch(link.href);
    if (!resp.ok) throw new Error(`Rasmni yuklab bo'lmadi: ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    const caption = ctx.message.caption?.trim() || "Bu rasmda nima bor? Batafsil tushuntir.";

    const { answer } = await askClaude(
      ctx.chat.id,
      [
        { image: { format: "jpeg", source: { bytes } } },
        { text: caption },
      ],
      `[rasm yuborildi] ${caption}`
    );
    await sendLong(ctx, answer);
  } catch (err) {
    console.error(err);
    await ctx.reply(friendlyError(err));
  } finally {
    clearInterval(typing);
  }
});

function friendlyError(err) {
  const name = err?.name || "";
  if (name === "AccessDeniedException")
    return "AWS ruxsat bermadi. Bedrock'da Opus 5.5 uchun Model access yoqilganini va IAM ruxsatini tekshiring.";
  if (name === "ThrottlingException")
    return "Juda tez-tez so'rov yuborildi (limit). Biroz kutib qayta urinib ko'ring.";
  if (name === "ValidationException")
    return `Bedrock so'rovni qabul qilmadi: ${err.message}`;
  if (name === "ResourceNotFoundException")
    return "Model topilmadi. MODEL_ID va AWS_REGION to'g'riligini tekshiring.";
  return `Xatolik: ${err?.message || err}`;
}

// ====== Render uchun sog'liq tekshiruvi (port ochiq turishi kerak) ======
const PORT = process.env.PORT || 3000;
http
  .createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log(`Health server: ${PORT}`));

bot.launch().then(() => console.log(`Bot ishga tushdi. Model: ${MODEL_ID}, region: ${AWS_REGION}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
