/**
 * Backend for Xside AI Profile Mini App
 * GET /api/credits, POST /api/invoice-link, GET /api/packs, POST /webhook/telegram
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const DB_URL = process.env.DATABASE_URL || process.env.database_url;
const pool = new Pool({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, '..');
app.use(express.static(publicDir));

app.get('/debug/env', (_req, res) => {
  res.json({
    BASE_URL: process.env.BASE_URL || null,
    APP_IMAGE_URL: process.env.APP_IMAGE_URL || null,
    APP_VIDEO_URL: process.env.APP_VIDEO_URL || null,
    APP_PROFILE_URL: process.env.APP_PROFILE_URL || null,
    REGISTER_WEBHOOK: process.env.REGISTER_WEBHOOK || null,
    HAS_TOKEN: !!(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN),
  });
});

// Ручная регистрация webhook
app.get('/setup-webhook', async (_req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.telegram_bot_token || process.env.BOT_TOKEN;
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (!token) return res.status(503).json({ error: 'No TELEGRAM_BOT_TOKEN' });
  if (!baseUrl.startsWith('https://')) return res.status(400).json({ error: 'BASE_URL must start with https://', BASE_URL: baseUrl });
  try {
    const webhookUrl = baseUrl + '/webhook/telegram';
    const r1 = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`).then(r => r.json());
    const r2 = await setBotCommands(token);
    const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then(r => r.json());
    res.json({ setWebhook: r1, setBotCommands: r2, webhookInfo: info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const initUserCreditsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_credits (
        user_id TEXT PRIMARY KEY,
        credits BIGINT NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS star_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        telegram_payment_charge_id TEXT NOT NULL,
        credits_added BIGINT NOT NULL,
        payload TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.error('Failed to init tables:', e.message);
  }
};

const INITIAL_CREDITS = 100;

const ensureUserCredits = async (userId) => {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO user_credits (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
      [String(userId), INITIAL_CREDITS]
    );
  } catch (e) {
    console.error('Failed to ensure user credits:', e.message);
  }
};

// ——— GET /api/credits ———
app.get('/api/credits', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ credits: 0 });
  try {
    await ensureUserCredits(userId);
    const result = await pool.query(`SELECT credits FROM user_credits WHERE user_id = $1`, [String(userId)]);
    res.json({ credits: result.rows.length ? Number(result.rows[0].credits) : INITIAL_CREDITS });
  } catch (e) {
    console.error('Failed to load credits:', e.message);
    res.status(500).json({ error: 'Failed to load credits' });
  }
});

// ——— Star packs ———
const STAR_PACKS = [
  { id: '25',  stars: 25,  credits: 50,  title: '50 монет',            description: '25 Stars — 50 монет',            priceRub: 49  },
  { id: '50',  stars: 50,  credits: 100, title: '100 монет',           description: '50 Stars — 100 монет',           priceRub: 95  },
  { id: '100', stars: 100, credits: 210, title: '200 монет +10 бонус', description: '100 Stars — 200 монет +10 бонус', priceRub: 179 },
  { id: '250', stars: 250, credits: 530, title: '500 монет +30 бонус', description: '250 Stars — 500 монет +30 бонус', priceRub: 429 },
];
const DEFAULT_PACK = STAR_PACKS[0];

app.get('/api/packs', (_req, res) => res.json(STAR_PACKS));

// ——— POST /api/invoice-link ———
app.post('/api/invoice-link', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.telegram_bot_token || process.env.BOT_TOKEN;
  if (!token) return res.status(503).json({ error: 'Payments not configured: TELEGRAM_BOT_TOKEN' });
  const userId = req.body?.userId != null ? String(req.body.userId) : '';
  const packId = req.body?.pack != null ? String(req.body.pack) : DEFAULT_PACK.id;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const pack = STAR_PACKS.find((p) => p.id === packId) || DEFAULT_PACK;
  const payload = JSON.stringify({ userId, pack: pack.id });
  if (Buffer.byteLength(payload, 'utf8') > 128) return res.status(400).json({ error: 'Payload too long' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: pack.title,
        description: pack.description,
        payload,
        currency: 'XTR',
        prices: [{ label: pack.description, amount: pack.stars }],
      }),
    });
    const data = await r.json();
    if (!data.ok || !data.result) return res.status(502).json({ error: 'Failed to create invoice', description: data.description });
    res.json({ invoiceUrl: data.result });
  } catch (e) {
    res.status(502).json({ error: 'Failed to create invoice', message: e.message });
  }
});

// ——— Helpers ———
const tgPost = (token, method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const setBotCommands = async (token) => {
  await tgPost(token, 'setMyCommands', {
    commands: [
      { command: 'start', description: '🚀 Главное меню — все приложения' },
    ],
  });
};

const sendStartMenu = async (token, chatId, firstName) => {
  const IMAGE_URL  = process.env.APP_IMAGE_URL  || '';
  const VIDEO_URL  = process.env.APP_VIDEO_URL  || '';
  const PROFILE_URL = process.env.APP_PROFILE_URL || process.env.BASE_URL || '';

  const buttons = [];
  if (IMAGE_URL)   buttons.push([{ text: '🖼 AI Фото',   web_app: { url: IMAGE_URL   } }]);
  if (VIDEO_URL)   buttons.push([{ text: '🎬 AI Видео',  web_app: { url: VIDEO_URL   } }]);
  if (PROFILE_URL) buttons.push([{ text: '👤 Профиль',   web_app: { url: PROFILE_URL } }]);

  const name = firstName ? `, ${firstName}` : '';
  await tgPost(token, 'sendMessage', {
    chat_id: chatId,
    text: `👋 Привет${name}!\n\nВыбери приложение:`,
    reply_markup: { inline_keyboard: buttons },
  });
};

// Тест: вручную отправить /start меню по chatId
app.get('/test-start/:chatId', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.telegram_bot_token || process.env.BOT_TOKEN;
  if (!token) return res.status(503).json({ error: 'No token' });
  try {
    await sendStartMenu(token, req.params.chatId, 'Test');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ——— POST /webhook/telegram ———
app.post('/webhook/telegram', (req, res) => {
  const update = req.body;
  console.log('[webhook] received update:', JSON.stringify(update)?.slice(0, 300));
  if (!update || typeof update !== 'object') return res.status(200).send();
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.telegram_bot_token || process.env.BOT_TOKEN;
  if (!token) { console.warn('[webhook] no token'); return res.status(200).send(); }
  const baseUrl = 'https://api.telegram.org/bot' + token;

  (async () => {
    const msg = update.message;
    if (msg?.text) {
      const cmd = msg.text.split('@')[0];
      if (cmd === '/start') {
        await sendStartMenu(token, msg.chat.id, msg.from?.first_name);
        return;
      }
    }

    if (update.pre_checkout_query) {
      await fetch(baseUrl + '/answerPreCheckoutQuery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
      });
    }
    if (update.message?.successful_payment) {
      const sp = update.message.successful_payment;
      let userId, packId;
      try { const p = JSON.parse(sp.invoice_payload || '{}'); userId = p.userId; packId = p.pack; } catch { return; }
      if (!userId) return;
      const pack = STAR_PACKS.find((p) => p.id === packId) || DEFAULT_PACK;
      await initUserCreditsTable();
      await pool.query(
        `INSERT INTO user_credits (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = user_credits.credits + $2`,
        [String(userId), pack.credits]
      );
      await pool.query(
        `INSERT INTO star_payments (user_id, telegram_payment_charge_id, credits_added, payload) VALUES ($1, $2, $3, $4)`,
        [String(userId), sp.telegram_payment_charge_id || '', pack.credits, sp.invoice_payload || '']
      );
    }
  })().then(() => res.status(200).send(), () => res.status(200).send());
});

(async () => {
  await initUserCreditsTable();
  app.listen(PORT, () => {
    console.log(`Profile Server running at ${BASE_URL}`);
    const token = process.env.TELEGRAM_BOT_TOKEN || process.env.telegram_bot_token || process.env.BOT_TOKEN;
    const baseUrl = process.env.BASE_URL;
    if (process.env.REGISTER_WEBHOOK === 'true' && token && baseUrl?.startsWith('https://')) {
      fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(baseUrl.replace(/\/$/, '') + '/webhook/telegram')}`)
        .then((r) => r.json())
        .then((d) => d.ok ? console.log('Telegram webhook set') : console.warn('setWebhook:', d.description))
        .catch((e) => console.warn('setWebhook failed:', e.message));
      setBotCommands(token)
        .then(() => console.log('Bot commands registered'))
        .catch((e) => console.warn('setBotCommands failed:', e.message));
    }
  });
})();
