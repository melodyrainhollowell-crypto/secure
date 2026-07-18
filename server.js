import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'node:crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as ed from '@noble/ed25519';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const SITE_NAME = process.env.SITE_NAME || 'EbookStore';
/** Telegram for post-payment redirect (checkout success on this host). Videos-site passes Supabase user via ?telegram_username= when possible. */
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME || '';
/** Default checkout for videos-site and bare /api/paypal-checkout links. */
const CHECKOUT_DEFAULT_METHOD = 'whop';
const PAYJSR_API_BASE = 'https://api.payjsr.com';
const PAYJSR_CHECKOUT_BASE = String(process.env.PAYJSR_CHECKOUT_BASE_URL || 'https://checkout.payjsr.com').replace(
  /\/+$/,
  ''
);
const PAYJSR_CHECKOUT_CURRENCY = 'ZAR';
const CHECKOUT_DISPLAY_CURRENCIES = [
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', decimals: 2 },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
  { code: 'GBP', name: 'British Pound', symbol: '£', decimals: 2 },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', decimals: 2 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2 },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', decimals: 2 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimals: 2 },
  { code: 'MXN', name: 'Mexican Peso', symbol: '$', decimals: 2 },
];

/** Shared light theme for all in-app checkout pages (matches videos/ebooks storefront). */
const CHECKOUT_UI_CSS = `
    :root {
      --bg: #ffffff;
      --bg-deep: #ffffff;
      --bg-mid: #ffffff;
      --paper: #ffffff;
      --paper-border: #e5e7eb;
      --surface: #f7f8fa;
      --primary: #0b6bcb;
      --primary-hover: #0958a8;
      --primary-deep: #0958a8;
      --accent: #0b6bcb;
      --text: #111827;
      --muted: #6b7280;
      --muted2: #6b7280;
      --border: #e5e7eb;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: light; }
    body {
      font-family: 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px 18px;
      background: var(--bg);
      color: var(--text);
      position: relative;
      overflow-x: hidden;
    }
    .ambient { display: none; }
    .wrap { width: 100%; max-width: 420px; position: relative; z-index: 1; }
    .card {
      border-radius: 12px;
      background: var(--paper);
      border: 1px solid var(--border);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06);
      overflow: hidden;
    }
    .card-accent { height: 3px; width: 100%; background: var(--primary); }
    .card-body { padding: 1.45rem 1.35rem 1.25rem; }
    .eyebrow {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--primary);
      margin-bottom: 0.3rem;
    }
    .brand {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
      margin-bottom: 0.65rem;
    }
    .badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.78rem;
      color: var(--muted);
      margin-bottom: 0.85rem;
    }
    .divider {
      height: 1px;
      background: var(--border);
      margin: 0.15rem 0 0.85rem;
    }
    .cancel-banner {
      font-size: 0.82rem;
      line-height: 1.45;
      color: #92400e;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 8px;
      padding: 0.65rem 0.75rem;
      margin-bottom: 0.85rem;
    }
    .label {
      font-size: 0.62rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.25rem;
    }
    .real, .product, .product-real {
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 0.55rem;
      line-height: 1.42;
      color: var(--text);
    }
    .privacy-callout {
      font-size: 0.72rem;
      line-height: 1.52;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.7rem 0.85rem;
      margin-bottom: 0.9rem;
    }
    .privacy-callout strong {
      display: block;
      font-size: 0.65rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text);
      margin-bottom: 0.35rem;
    }
    .privacy-p { margin: 0; }
    .paypal-label {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 0.88em;
      color: var(--primary);
      word-break: break-word;
    }
    .amount {
      font-size: 1.85rem;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 1rem;
      letter-spacing: -0.03em;
    }
    .amount .cur-symbol { font-size: 1.15rem; margin-right: 1px; }
    .amount .cur-code {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--muted);
      margin-left: 6px;
    }
    .field { margin-bottom: 0.75rem; }
    .field label {
      display: block;
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.35rem;
    }
    .field input {
      width: 100%;
      padding: 0.7rem 0.8rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font: inherit;
    }
    #card-element {
      padding: 0.75rem 0.8rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
    }
    #card-errors { font-size: 0.74rem; color: #dc2626; min-height: 1.1rem; margin-top: 0.45rem; }
    .btn {
      display: block;
      width: 100%;
      text-align: center;
      font-weight: 700;
      padding: 0.85rem 1rem;
      border-radius: 8px;
      margin-top: 0;
      background: var(--primary);
      color: #fff;
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.92rem;
      text-decoration: none;
      box-shadow: none;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .pp-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 0.95rem 1.05rem;
    }
    .pp-label {
      font-size: 0.76rem;
      font-weight: 600;
      color: var(--muted);
      text-align: center;
      margin-bottom: 0.6rem;
    }
    #paypal-button-container { min-height: 48px; }
    #loading { text-align: center; font-size: 0.78rem; color: var(--muted); margin-top: 0.7rem; }
    .fine {
      font-size: 0.72rem;
      color: var(--muted);
      text-align: center;
      margin-top: 0.7rem;
      line-height: 1.48;
    }
    .back {
      display: block;
      text-align: center;
      margin-top: 0.55rem;
      font-size: 0.72rem;
      color: var(--muted);
    }
    .fx-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.85rem 0.9rem;
      margin-bottom: 0.95rem;
    }
    .fx-panel .amount { margin-bottom: 0.55rem; }
    .fx-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.45rem;
    }
    .fx-row select {
      flex: 1;
      padding: 0.55rem 0.65rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font: inherit;
      font-size: 0.85rem;
    }
    .fx-equiv {
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text);
      margin-top: 0.5rem;
    }
    .fx-note {
      font-size: 0.7rem;
      line-height: 1.45;
      color: var(--muted);
      margin-top: 0.55rem;
    }
`;

app.use(express.json());

function isCheckoutQuery(q) {
  if (q.status === 'success' || q.status === 'cancel') return false;
  return Boolean(
    q.payment_canceled === 'true' ||
    q.method === 'paypal' ||
    q.method === 'paddle' ||
    q.method === 'payjsr' ||
    q.method === 'whop' ||
    q.method === 'stripe' ||
    q.method === 'zuckpay' ||
    (q.video_id && (q.product_name || q.display_title))
  );
}

const getEbooksReturnUrl = (origin, status, productName, amount, extra = {}) => {
  const params = new URLSearchParams();
  params.set('status', status);
  if (productName) params.set('product_name', String(productName));
  if (extra.display_title) params.set('display_title', String(extra.display_title));
  if (amount !== undefined && amount !== null && amount !== '') params.set('amount', String(amount));
  if (extra.video_id) params.set('video_id', String(extra.video_id));
  if (extra.telegram_username) params.set('telegram_username', String(extra.telegram_username));
  return `${origin}/?${params.toString()}`;
};

/** Normalizes query after redirects; rebuilds success_url when "?" broke parsing. */
function resolveCheckoutParams(req) {
  const origin = `${req.protocol}://${req.get('host')}`;
  const q = req.query;
  let amount = q.amount != null && q.amount !== '' ? String(q.amount) : '';
  let success_url = q.success_url ? String(q.success_url).trim() : '';
  const extra = {
    video_id: q.video_id ? String(q.video_id) : '',
    telegram_username: q.telegram_username ? String(q.telegram_username) : '',
    display_title: q.display_title ? String(q.display_title) : '',
  };
  const productLabel = q.product_name ? String(q.product_name) : 'Digital purchase';

  if (q.status === 'success' && (!success_url || !success_url.includes('status='))) {
    const base =
      success_url && /^https?:\/\//i.test(success_url) ? success_url.replace(/\/+$/, '') : origin;
    success_url = getEbooksReturnUrl(base, 'success', productLabel, amount || q.amount, {
      ...extra,
      display_title: extra.display_title || (q.display_title ? String(q.display_title) : ''),
    });
  }

  if (!success_url && amount) {
    success_url = getEbooksReturnUrl(origin, 'success', productLabel, amount, {
      ...extra,
      display_title: extra.display_title || (q.display_title ? String(q.display_title) : ''),
    });
  }

  return {
    amount,
    success_url,
    currency: q.currency ? String(q.currency) : 'USD',
    product_name: q.product_name,
    display_title: q.display_title,
    method: q.method ? String(q.method) : CHECKOUT_DEFAULT_METHOD,
    video_id: extra.video_id,
    payment_canceled: String(q.payment_canceled || '').toLowerCase() === 'true',
  };
}

// Landing page (dinâmica com SITE_NAME)
app.get('/', (req, res) => {
  if (isCheckoutQuery(req.query)) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(302, `/api/paypal-checkout${qs}`);
  }
  try {
    const html = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const rendered = html
      .replace(/\{\{SITE_NAME\}\}/g, SITE_NAME)
      .replace(/\{\{TELEGRAM_USERNAME\}\}/g, TELEGRAM_USERNAME);
    res.type('html').send(rendered);
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

/** Public origin for legal pages (Railway/Render sit behind a reverse proxy). */
function publicOrigin(req) {
  const host = req.get('host') || '';
  let proto = req.get('x-forwarded-proto');
  if (proto) proto = String(proto).split(',')[0].trim();
  else proto = req.protocol;
  if (proto !== 'http' && proto !== 'https') proto = 'https';
  return `${proto}://${host}`;
}

function sendLegalHtml(req, res, filename) {
  try {
    const origin = publicOrigin(req);
    const html = readFileSync(path.join(__dirname, 'public', filename), 'utf8');
    res.type('html').send(html.replaceAll('{{PUBLIC_ORIGIN}}', origin));
  } catch (err) {
    console.error('Legal page:', filename, err);
    res.status(404).send('Not found');
  }
}

for (const name of ['terms-of-service.html', 'privacy-policy.html', 'refund-policy.html']) {
  app.get(`/${name}`, (req, res) => sendLegalHtml(req, res, name));
}

// Arquivos estáticos (CSS, imagens, etc.)
app.use(express.static(path.join(__dirname, 'public')));

const escapeForJs = (s) =>
  String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\r/g, '')
    .replace(/\n/g, '');

const escapeHtml = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Only allow same-origin redirects (videos-site passes absolute success/cancel URLs). */
function sameOriginUrl(candidate, allowedOrigin) {
  const raw = String(candidate || '').trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return '';
  try {
    const u = new URL(raw);
    const a = new URL(allowedOrigin);
    if (u.origin !== a.origin) return '';
    return u.toString();
  } catch {
    return '';
  }
}

function getPaddleApiBase() {
  const key = process.env.PADDLE_API_KEY || '';
  if (/^pdl_sdbx_/i.test(key) || String(process.env.PADDLE_ENV || '').toLowerCase() === 'sandbox') {
    return 'https://sandbox-api.paddle.com';
  }
  return 'https://api.paddle.com';
}

function paddleJsEnvironment() {
  const key = process.env.PADDLE_API_KEY || '';
  if (/^pdl_sdbx_/i.test(key) || String(process.env.PADDLE_ENV || '').toLowerCase() === 'sandbox') return 'sandbox';
  return 'production';
}

function getPayJSRCredentials() {
  return {
    secretKey: String(process.env.PAYJSR_SECRET_KEY || '').trim(),
    publicKey: String(process.env.PAYJSR_PUBLIC_KEY || '').trim(),
    merchantUserId: String(
      process.env.PAYJSR_MERCHANT_USER_ID ||
        process.env.PAYJSR_BUSINESS_ID ||
        process.env.PAYJSR_USER_ID ||
        ''
    ).trim(),
  };
}

function payjsrSecretPayload(secretKey) {
  return Buffer.from(String(secretKey || '').replace(/^sk_(test|live)_/, ''), 'base64url');
}

async function payjsrAuthHeaders(method, path, rawBody = '') {
  const { secretKey, publicKey } = getPayJSRCredentials();
  if (!secretKey || !publicKey) {
    throw new Error('PayJSR keys are not configured');
  }
  const ts = new Date().toISOString();
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const msg = `${method.toUpperCase()}\n${path}\n${bodyHash}\n${ts}`;
  const sig = Buffer.from(
    await ed.signAsync(new TextEncoder().encode(msg), payjsrSecretPayload(secretKey))
  ).toString('base64url');
  return {
    'X-PayJSR-Key': publicKey,
    'X-PayJSR-Timestamp': ts,
    'X-PayJSR-Signature': sig,
    'Content-Type': 'application/json',
  };
}

async function payjsrLegacyAuthHeaders() {
  const { secretKey } = getPayJSRCredentials();
  if (!secretKey) throw new Error('PayJSR secret key is not configured');
  return {
    'x-api-key': secretKey,
    'Content-Type': 'application/json',
  };
}

async function payjsrApiRequest(method, path, body, auth = 'signed') {
  const rawBody = body == null ? '' : JSON.stringify(body);
  const headers =
    auth === 'legacy' ? await payjsrLegacyAuthHeaders() : await payjsrAuthHeaders(method, path, rawBody);
  const res = await fetch(`${PAYJSR_API_BASE}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : rawBody || undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { data, httpStatus: res.status, auth };
}

async function payjsrGetLiveMode() {
  // Public /v1/live_mode returns account:null and is not account-scoped.
  // Prefer signed auth so the result reflects this merchant's LIVE toggle.
  for (const auth of ['signed', 'legacy']) {
    try {
      const { data } = await payjsrApiRequest('GET', '/v1/live_mode', null, auth);
      if (data && typeof data.livemode === 'boolean' && data.account != null) {
        return data.livemode === true;
      }
      if (data && typeof data.livemode === 'boolean' && auth === 'signed') {
        return data.livemode === true;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function payjsrCheckoutLinkReachable(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'text/html' },
    });
    if (res.status === 404) return false;
    const text = await res.text().catch(() => '');
    if (/payment link not found|page not found|invalid, expired, or deactivated/i.test(text)) return false;
    return res.status < 500;
  } catch {
    return null;
  }
}

function absolutePayJSRCheckoutUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${PAYJSR_CHECKOUT_BASE}${raw}`;
  return '';
}

function payjsrCandidateCheckoutUrls(session) {
  const sessionId = payjsrSessionIdFromValue(
    session?.session_id || session?.link_id || session?.id || session?.checkout_url || ''
  );
  const urls = [];
  const push = (u) => {
    const v = absolutePayJSRCheckoutUrl(u) || (String(u || '').trim().match(/^https?:\/\//i) ? String(u).trim() : '');
    if (!v) return;
    if (!urls.includes(v)) urls.push(v);
  };

  // Prefer the exact path returned by PayJSR Core API (often relative: /checkout/core/<id>).
  push(session?.checkout_url);
  push(session?.payment_url);
  push(session?.url);
  if (sessionId) {
    push(`/checkout/core/${sessionId}`);
    push(`/${sessionId}`);
    push(`/pay/${sessionId}`);
  }
  return urls;
}

function normalizeCurrencyCode(raw, fallback = 'USD') {
  const code = String(raw || fallback).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : fallback;
}

function minorToMajor(amountMinor, decimals = 2) {
  const n = Number(amountMinor);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** decimals;
}

function majorToMinor(amountMajor, decimals = 2) {
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** decimals);
}

function manualFxRate(fromCurrency, toCurrency) {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const direct = process.env[`PAYJSR_FX_RATE_${from}_${to}`];
  if (direct && Number.isFinite(Number(direct))) return Number(direct);
  const inverse = process.env[`PAYJSR_FX_RATE_${to}_${from}`];
  if (inverse && Number.isFinite(Number(inverse)) && Number(inverse) !== 0) {
    return 1 / Number(inverse);
  }
  return null;
}

async function publicFxQuote(fromCurrency, toCurrency, amountMinor, toDecimals = 2) {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const amount = Math.max(1, Math.round(Number(amountMinor) || 0));
  if (from === to) {
    return { amountMinor: amount, rate: 1, decimals: toDecimals, source: 'identity' };
  }

  const manualRate = manualFxRate(from, to);
  if (manualRate != null) {
    const major = minorToMajor(amount, 2);
    return {
      amountMinor: majorToMinor(major * manualRate, toDecimals),
      rate: manualRate,
      decimals: toDecimals,
      source: 'env',
    };
  }

  const amountMajor = minorToMajor(amount, 2);
  const providers = [
    async () => {
      const url = `https://api.frankfurter.app/latest?amount=${amountMajor}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const data = await res.json().catch(() => ({}));
      const convertedMajor = data?.rates?.[to];
      if (convertedMajor == null || !Number.isFinite(Number(convertedMajor))) return null;
      return {
        amountMinor: majorToMinor(Number(convertedMajor), toDecimals),
        rate: Number(convertedMajor) / amountMajor,
        decimals: toDecimals,
        source: 'frankfurter',
      };
    },
    async () => {
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const data = await res.json().catch(() => ({}));
      const pairRate = data?.rates?.[to];
      if (pairRate == null || !Number.isFinite(Number(pairRate))) return null;
      return {
        amountMinor: majorToMinor(amountMajor * Number(pairRate), toDecimals),
        rate: Number(pairRate),
        decimals: toDecimals,
        source: 'open.er-api',
      };
    },
  ];

  for (const provider of providers) {
    try {
      const quote = await provider();
      if (quote) return quote;
    } catch (err) {
      console.warn('Public FX provider failed:', err?.message || err);
    }
  }

  throw new Error('FX quote unavailable');
}

async function payjsrFxQuote(fromCurrency, toCurrency, amountMinor, toDecimals = 2) {
  return publicFxQuote(fromCurrency, toCurrency, amountMinor, toDecimals);
}

let fxQuoteCache = new Map();
async function cachedFxQuote(fromCurrency, toCurrency, amountMinor, toDecimals = 2) {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const amount = Math.max(1, Math.round(Number(amountMinor) || 0));
  const key = `${from}:${to}:${amount}`;
  const hit = fxQuoteCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.quote;
  const quote = await payjsrFxQuote(from, to, amount, toDecimals);
  fxQuoteCache.set(key, { at: Date.now(), quote });
  return quote;
}

function getPayJSRPaymentLinks() {
  const raw = String(process.env.PAYJSR_PAYMENT_LINKS || '').trim();
  if (!raw) return [];

  // JSON array: [{"amount_zar":500,"url":"https://..."},{"amount_usd":15,"url":"https://..."}]
  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw);
      return (Array.isArray(list) ? list : [])
        .map((item) => ({
          amountZar: item.amount_zar != null ? Number(item.amount_zar) : null,
          amountUsd: item.amount_usd != null ? Number(item.amount_usd) : null,
          url: String(item.url || '').trim(),
          name: String(item.name || '').trim(),
        }))
        .filter((item) => item.url && /^https?:\/\//i.test(item.url));
    } catch (err) {
      console.warn('PAYJSR_PAYMENT_LINKS JSON invalid:', err?.message || err);
      return [];
    }
  }

  // Simple lines / semicolon list:
  //   500|https://checkout.payjsr.com/uuid
  //   15usd|https://checkout.payjsr.com/uuid
  //   zar:245.74|https://...
  return raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.includes('|') ? '|' : ',';
      const [pricePart, ...urlParts] = line.split(sep);
      const url = urlParts.join(sep).trim();
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const token = String(pricePart || '').trim().toLowerCase();
      let amountZar = null;
      let amountUsd = null;
      if (/^usd:/.test(token) || /usd$/.test(token)) {
        amountUsd = Number(token.replace(/^usd:/, '').replace(/usd$/, ''));
      } else if (/^zar:/.test(token) || /zar$/.test(token)) {
        amountZar = Number(token.replace(/^zar:/, '').replace(/zar$/, ''));
      } else {
        amountZar = Number(token);
      }
      return {
        amountZar: Number.isFinite(amountZar) ? amountZar : null,
        amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
        url,
        name: '',
      };
    })
    .filter(Boolean);
}

function findMatchingPayJSRLink({ listAmountMajor, listCurrency, zarAmountMajor, tolerance = 0.12 }) {
  const links = getPayJSRPaymentLinks();
  if (!links.length) return null;

  const listCur = normalizeCurrencyCode(listCurrency, 'USD');
  const listAmt = Number(listAmountMajor);
  const zarAmt = Number(zarAmountMajor);

  const scored = [];
  for (const link of links) {
    let score = Infinity;
    let matchType = '';

    if (link.amountUsd != null && listCur === 'USD' && Number.isFinite(listAmt)) {
      const diff = Math.abs(link.amountUsd - listAmt);
      if (diff < 0.005) {
        score = 0;
        matchType = 'exact_usd';
      } else if (listAmt > 0 && diff / listAmt <= tolerance) {
        score = diff / listAmt;
        matchType = 'approx_usd';
      }
    }

    if (link.amountZar != null && Number.isFinite(zarAmt)) {
      const diff = Math.abs(link.amountZar - zarAmt);
      if (diff < 0.05) {
        score = Math.min(score, 0);
        matchType = matchType || 'exact_zar';
      } else if (zarAmt > 0 && diff / zarAmt <= tolerance) {
        const s = diff / zarAmt;
        if (s < score) {
          score = s;
          matchType = 'approx_zar';
        }
      }
    }

    // Also allow matching USD list price against amount_zar when user only set ZAR on the link
    // and list currency is USD — skip; FX already produced zarAmt above.

    if (score < Infinity) {
      scored.push({ link, score, matchType });
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => a.score - b.score);
  return scored[0];
}

async function payjsrCreateCheckoutSession(amountMinorZar, options = {}) {
  const {
    productName = 'Digital Ebook',
    description = '',
    internalReference = '',
    successUrl = '',
    cancelUrl = '',
  } = options;
  const { merchantUserId, secretKey } = getPayJSRCredentials();
  if (!merchantUserId) {
    throw new Error('PayJSR merchant user id is not configured (PAYJSR_MERCHANT_USER_ID)');
  }

  const usingLiveKey = /^sk_live_/i.test(secretKey);
  const liveMode = await payjsrGetLiveMode();
  if (usingLiveKey && liveMode === false) {
    console.warn(
      'PayJSR GET /v1/live_mode returned false, but dashboard LIVE may still be on. Continuing.'
    );
  }

  const amountMinor = Math.max(1, Math.round(Number(amountMinorZar) || 0));
  const amountMajor = Number((amountMinor / 100).toFixed(2));
  const title = String(productName || 'Digital Ebook').trim().slice(0, 200);
  const desc = String(description || title).trim().slice(0, 500);
  const reference = String(internalReference || ('order-' + Date.now())).trim().slice(0, 100);
  const returnUrl = successUrl || cancelUrl || '';

  // Mirror Dashboard → Payment Links → Create Payment Link fields.
  const paymentLinkBodies = [
    {
      merchant_user_id: merchantUserId,
      name: title,
      payment_name: title,
      title,
      description: desc,
      amount: amountMajor,
      currency: PAYJSR_CHECKOUT_CURRENCY,
      billing_type: 'one_time',
      payment_methods: ['card'],
      payment_method: 'card',
      internal_reference: reference,
      return_url: returnUrl || undefined,
      success_url: successUrl || undefined,
    },
    {
      merchant_user_id: merchantUserId,
      name: title,
      description: desc,
      amount: amountMinor,
      currency: PAYJSR_CHECKOUT_CURRENCY,
      billing_type: 'one_time',
      payment_methods: ['card'],
      internal_reference: reference,
      return_url: returnUrl || undefined,
    },
  ];

  const coreSessionBodies = [
    {
      merchant_user_id: merchantUserId,
      amount: amountMinor,
      currency: PAYJSR_CHECKOUT_CURRENCY,
      ...(successUrl ? { success_url: successUrl } : {}),
      ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
    },
  ];

  const attempts = [
    { path: '/v1/payment_links', bodies: paymentLinkBodies },
    { path: '/v1/payment-links', bodies: paymentLinkBodies },
    { path: '/v1/links', bodies: paymentLinkBodies },
    { path: '/v1/checkout_links', bodies: paymentLinkBodies },
    { path: '/v1/checkout/sessions', bodies: coreSessionBodies },
    { path: '/v1/checkout_sessions', bodies: coreSessionBodies },
  ];

  const auths = ['signed', 'legacy'];
  let lastError = 'PayJSR payment link creation failed';
  let lastData = null;

  for (const attempt of attempts) {
    for (const body of attempt.bodies) {
      const cleanBody = Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined && v !== '')
      );
      for (const auth of auths) {
        const { data } = await payjsrApiRequest('POST', attempt.path, cleanBody, auth);
        lastData = data;
        const errLabel = [data?.step, data?.error].filter(Boolean).join(': ');
        if (!data?.ok) {
          if (errLabel && !/unknown endpoint/i.test(errLabel)) {
            console.warn('PayJSR ' + auth + ' ' + attempt.path + ' failed:', errLabel);
          }
          lastError = errLabel || lastError;
          continue;
        }

        const linkId =
          data.link_id ||
          data.payment_link_id ||
          data.session_id ||
          data.id ||
          '';
        let finalUrl = resolvePayJSRCheckoutUrl({
          ...data,
          session_id: linkId,
          checkout_url: data.checkout_url || data.url || data.payment_url || data.link,
        });

        // Dashboard payment links use https://checkout.payjsr.com/<uuid> (no /checkout/core).
        if (attempt.path.includes('payment') || attempt.path.includes('link')) {
          if (linkId) finalUrl = PAYJSR_CHECKOUT_BASE + '/' + linkId;
        }
        if (!finalUrl && linkId) {
          finalUrl = PAYJSR_CHECKOUT_BASE + '/' + linkId;
        }
        if (!finalUrl) {
          lastError = 'PayJSR ' + attempt.path + ' returned ok without URL';
          continue;
        }

        console.log('PayJSR payment link created:', {
          auth,
          path: attempt.path,
          body_amount: cleanBody.amount,
          link_id: linkId,
          checkout_url: finalUrl,
          api_checkout_url: data.checkout_url || data.url,
          livemode: data.livemode,
          account_livemode: liveMode,
          keys: Object.keys(data),
        });

        return {
          ...data,
          session_id: linkId,
          checkout_url: finalUrl,
          _endpoint: attempt.path,
        };
      }
    }
  }

  if (lastData) {
    console.warn('PayJSR last response:', lastData);
  }
  throw new Error(lastError);
}

function payjsrSessionIdFromValue(value) {
  const match = String(value || '').match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match ? match[1] : '';
}

function resolvePayJSRCheckoutUrl(session) {
  // API often returns a relative path like "/checkout/core/<session_id>" — use it as-is.
  const fromApi = absolutePayJSRCheckoutUrl(session?.checkout_url);
  if (fromApi) return fromApi;

  const direct = [session?.payment_url, session?.url, session?.link_url]
    .map((v) => absolutePayJSRCheckoutUrl(v))
    .find(Boolean);
  if (direct) return direct;

  const id = payjsrSessionIdFromValue(
    session?.link_id || session?.payment_link_id || session?.session_id || session?.id || ''
  );
  // Core API sessions use /checkout/core/<id> (docs). Dashboard payment links use /<id>.
  if (id) return `${PAYJSR_CHECKOUT_BASE}/checkout/core/${id}`;
  return '';
}

const applyCommonHeaders = (res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
};

/** PayPal onCancel always returns here — never the storefront origin. */
const buildCheckoutSelfCancelUrl = (req, resolved) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const params = new URLSearchParams();
  params.set('amount', resolved.amount);
  params.set('currency', resolved.currency || 'USD');
  params.set('success_url', resolved.success_url);
  if (resolved.product_name) params.set('product_name', String(resolved.product_name));
  if (resolved.display_title) params.set('display_title', String(resolved.display_title));
  params.set('method', resolved.method || CHECKOUT_DEFAULT_METHOD);
  if (resolved.video_id) params.set('video_id', resolved.video_id);
  params.set('payment_canceled', 'true');
  return `${origin}/api/paypal-checkout?${params.toString()}`;
};

function sendPaddleCheckoutPage(res, payload) {
  const {
    transactionId,
    clientToken,
    jsEnvironment,
    realTitle,
    maskedLabel,
    amountStr,
    currencyCode,
    successIntermediate,
    showPrivacyBlurb,
  } = payload;
  const htmlReal = escapeHtml(realTitle);
  const htmlMasked = escapeHtml(maskedLabel);
  const htmlAmount = escapeHtml(amountStr);
  const htmlCur = escapeHtml(currencyCode);
  const txnJson = JSON.stringify(transactionId);
  const tokenJson = JSON.stringify(clientToken);
  const successJson = JSON.stringify(successIntermediate);
  const envJson = JSON.stringify(jsEnvironment);
  applyCommonHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>${escapeHtml(`${SITE_NAME} · Continue`)}</title>
  <script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
  <style>${CHECKOUT_UI_CSS}</style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:var(--primary)">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
        </div>`
            : `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>A generic description is sent to the payment processor so your receipt and bank statement stay discreet.</span>
        </div>`
        }
        <p class="amount">$${htmlAmount} <small style="font-size:.76rem;color:var(--muted);font-weight:700">${htmlCur}</small></p>
        <button type="button" class="btn" id="btn-paddle">Pay and receive</button>
        <p class="fine">You will receive access automatically after payment.</p>
      </div>
    </article>
  </div>
  <script>
    (function () {
      var TXN = ${txnJson};
      var TOKEN = ${tokenJson};
      var SUCCESS_URL = ${successJson};
      var ENV = ${envJson};
      var initialized = false;
      function bootPaddle(cb) {
        if (typeof Paddle === 'undefined' || !Paddle.Initialize) {
          setTimeout(function () { bootPaddle(cb); }, 50);
          return;
        }
        if (!initialized) {
          try {
            if (ENV === 'sandbox') Paddle.Environment.set('sandbox');
            else Paddle.Environment.set('production');
          } catch (e) {}
          Paddle.Initialize({ token: TOKEN });
          initialized = true;
        }
        if (cb) cb();
      }
      function openCheckout() {
        try {
          Paddle.Checkout.open({
            transactionId: TXN,
            settings: {
              displayMode: 'overlay',
              theme: 'dark',
              successUrl: SUCCESS_URL
            }
          });
        } catch (e) {
          console.error(e);
          alert('Could not open checkout. Try again or use another browser.');
        }
      }
      document.getElementById('btn-paddle').addEventListener('click', function () {
        bootPaddle(openCheckout);
      });
    })();
  </script>
</body>
</html>`);
}

async function handlePaddleCheckout(req, res) {
  const { amount, currency = 'USD', product_name, display_title, success_url: qSuccess } = req.query;
  if (!amount) {
    return res.status(400).send('Missing required parameters');
  }

  const paddleApiKey = process.env.PADDLE_API_KEY;
  const paddleClientToken = process.env.PADDLE_CLIENT_TOKEN;
  if (!paddleApiKey || !paddleClientToken) {
    return res.status(500).send(
      'Paddle is not configured. Set PADDLE_API_KEY (server) and PADDLE_CLIENT_TOKEN (client-side token) in your environment.'
    );
  }

  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const amountCents = Math.round(amountNumber * 100);
  if (amountCents < 100) {
    return res.status(400).send('Amount too small (minimum is $1.00)');
  }

  applyCommonHeaders(res);

  const maskedForProcessor = product_name ? String(product_name).trim() : 'Digital Ebook';
  const realForBuyer = display_title ? String(display_title).trim() : '';

  const origin = `${req.protocol}://${req.get('host')}`;
  const extra = {
    display_title: realForBuyer,
    video_id: req.query.video_id ? String(req.query.video_id) : '',
    telegram_username: req.query.telegram_username ? String(req.query.telegram_username) : '',
  };
  const fromStoreSuccess = sameOriginUrl(qSuccess, origin);
  const forwardSuccess = fromStoreSuccess
    ? fromStoreSuccess
    : getEbooksReturnUrl(origin, 'success', maskedForProcessor, amountNumber.toFixed(2), {
        ...extra,
        display_title: realForBuyer || maskedForProcessor,
      });

  const successIntermediate = `${origin}/api/paddle-success?forward=${encodeURIComponent(forwardSuccess)}`;

  const currencyRaw = String(currency || 'USD').toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';

  /** Paddle custom_data is visible in the vendor dashboard — never store the real product title. */
  const customData = {};
  if (extra.video_id) customData.video_id = extra.video_id.slice(0, 200);
  if (extra.telegram_username) customData.telegram_username = extra.telegram_username.slice(0, 200);

  const apiBase = getPaddleApiBase();
  const createPayload = {
    items: [
      {
        quantity: 1,
        price: {
          description: maskedForProcessor.slice(0, 230),
          name: maskedForProcessor.slice(0, 200),
          tax_mode: 'account_setting',
          unit_price: {
            amount: String(amountCents),
            currency_code: currencyCode,
          },
          product: {
            name: maskedForProcessor.slice(0, 200),
            tax_category: 'standard',
            description: 'Digital access — unlocked instantly after payment confirmation.',
          },
        },
      },
    ],
    currency_code: currencyCode,
    collection_mode: 'automatic',
    custom_data: customData,
  };

  const createRes = await fetch(`${apiBase}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${paddleApiKey}`,
      'Content-Type': 'application/json',
      'Paddle-Version': '1',
    },
    body: JSON.stringify(createPayload),
  });

  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    const msg =
      createData?.error?.detail ||
      createData?.error?.message ||
      createData?.message ||
      JSON.stringify(createData?.error || createData).slice(0, 400);
    return res.status(createRes.status >= 400 && createRes.status < 600 ? createRes.status : 502).send(`Checkout failed (Paddle): ${msg}`);
  }

  const txn = createData?.data;
  const transactionId = txn?.id;
  if (!transactionId || !String(transactionId).startsWith('txn_')) {
    return res.status(502).send('Checkout failed (Paddle): missing transaction id');
  }

  const showPrivacyBlurb =
    Boolean(display_title && String(display_title).trim()) &&
    String(realForBuyer).trim() !== String(maskedForProcessor).trim();

  return sendPaddleCheckoutPage(res, {
    transactionId,
    clientToken: paddleClientToken,
    jsEnvironment: paddleJsEnvironment(),
    realTitle: realForBuyer || maskedForProcessor,
    maskedLabel: maskedForProcessor,
    amountStr: amountNumber.toFixed(2),
    currencyCode,
    successIntermediate,
    showPrivacyBlurb,
  });
}

function sendPayJSRCheckoutPage(res, payload) {
  const {
    checkoutUrl,
    realTitle,
    maskedLabel,
    zarAmountMajor,
    zarAmountMinor,
    listAmountMajor,
    listCurrency,
    currencies,
    showPrivacyBlurb,
  } = payload;
  const htmlReal = escapeHtml(realTitle);
  const htmlMasked = escapeHtml(maskedLabel);
  const htmlZar = escapeHtml(zarAmountMajor);
  const htmlList = escapeHtml(listAmountMajor);
  const htmlListCur = escapeHtml(listCurrency);
  const checkoutUrlJson = JSON.stringify(checkoutUrl);
  const zarMinorJson = JSON.stringify(zarAmountMinor);
  const currenciesJson = JSON.stringify(currencies || []);
  applyCommonHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>${escapeHtml(`${SITE_NAME} · Continue`)}</title>
  <style>${CHECKOUT_UI_CSS}</style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:var(--primary)">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
        </div>`
            : `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>A generic description is sent to the payment processor so your receipt and bank statement stay discreet.</span>
        </div>`
        }
        <div class="fx-panel">
          <p class="label">Amount to pay (PayJSR)</p>
          <p class="amount"><span class="cur-symbol">R</span>${htmlZar} <span class="cur-code">ZAR</span></p>
          <p class="label" style="margin-top:0.35rem">List price</p>
          <p style="font-size:0.88rem;color:var(--muted);margin-bottom:0.15rem">$${htmlList} ${htmlListCur}</p>
          <p class="label" style="margin-top:0.55rem">See equivalent in your currency</p>
          <div class="fx-row">
            <select id="display-currency" aria-label="Display currency"></select>
          </div>
          <p class="fx-equiv" id="fx-equiv">Loading rate…</p>
          <p class="fx-note">Payment is processed in <strong>South African Rand (ZAR)</strong> on PayJSR. The ZAR amount above is what your card will be charged. Currency equivalents are indicative.</p>
        </div>
        <a class="btn" id="btn-payjsr" href="${escapeHtml(checkoutUrl)}">Pay and receive</a>
        <p class="fine">You will receive access automatically after payment.</p>
      </div>
    </article>
  </div>
  <script>
    (function () {
      var CHECKOUT_URL = ${checkoutUrlJson};
      var ZAR_MINOR = ${zarMinorJson};
      var CURRENCIES = ${currenciesJson};
      var zarMajor = ZAR_MINOR / 100;
      var select = document.getElementById('display-currency');
      var equiv = document.getElementById('fx-equiv');
      var payBtn = document.getElementById('btn-payjsr');
      var preferred = (function () {
        try {
          var saved = localStorage.getItem('checkout_display_currency');
          if (saved) return saved.toUpperCase();
        } catch (e) {}
        try {
          var lang = (navigator.language || 'en-US').split('-')[1];
          if (lang && lang.length === 2) {
            var map = { US: 'USD', GB: 'GBP', BR: 'BRL', PT: 'EUR', ZA: 'ZAR', EU: 'EUR' };
            if (map[lang.toUpperCase()]) return map[lang.toUpperCase()];
          }
        } catch (e2) {}
        return 'USD';
      })();
      var popular = ['USD', 'EUR', 'GBP', 'BRL', 'CAD', 'AUD', 'ZAR', 'NGN', 'INR', 'MXN'];
      function currencyMeta(code) {
        for (var i = 0; i < CURRENCIES.length; i++) {
          if (CURRENCIES[i].code === code) return CURRENCIES[i];
        }
        return { code: code, symbol: '', decimals: 2, name: code };
      }
      function buildOptions() {
        var seen = {};
        var codes = [];
        popular.forEach(function (c) { if (!seen[c]) { seen[c] = true; codes.push(c); } });
        CURRENCIES.forEach(function (c) {
          if (c.code && !seen[c.code]) { seen[c.code] = true; codes.push(c.code); }
        });
        codes.sort();
        select.innerHTML = '';
        codes.forEach(function (code) {
          var meta = currencyMeta(code);
          var opt = document.createElement('option');
          opt.value = code;
          opt.textContent = code + (meta.name && meta.name !== code ? ' — ' + meta.name : '');
          select.appendChild(opt);
        });
        if (codes.indexOf(preferred) >= 0) select.value = preferred;
        else if (codes.length) select.value = codes[0];
      }
      function formatAmount(major, meta) {
        var n = Number(major);
        if (!isFinite(n)) return '—';
        var d = meta && meta.decimals != null ? meta.decimals : 2;
        var txt = n.toLocaleString(undefined, { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
        if (meta && meta.symbol) return meta.symbol + txt + ' ' + meta.code;
        return txt + ' ' + meta.code;
      }
      function updateFx() {
        var code = select.value;
        try { localStorage.setItem('checkout_display_currency', code); } catch (e) {}
        if (code === 'ZAR') {
          equiv.textContent = '≈ ' + formatAmount(zarMajor, currencyMeta('ZAR'));
          return;
        }
        equiv.textContent = 'Loading…';
        fetch('/api/payjsr-fx?from=ZAR&to=' + encodeURIComponent(code) + '&amount=' + encodeURIComponent(ZAR_MINOR))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || !data.ok) throw new Error((data && data.error) || 'rate unavailable');
            var meta = currencyMeta(code);
            var major = data.amount_minor / Math.pow(10, meta.decimals || 2);
            equiv.textContent = '≈ ' + formatAmount(major, meta);
            if (data.rate) {
              equiv.textContent += ' (1 ZAR ≈ ' + Number(data.rate).toFixed(4) + ' ' + code + ')';
            }
            if (data.approximate) {
              equiv.textContent += ' · indicative rate';
            }
          })
          .catch(function () {
            equiv.textContent = 'Exchange rate unavailable — you will pay R' + zarMajor.toFixed(2) + ' ZAR.';
          });
      }
      buildOptions();
      select.addEventListener('change', updateFx);
      updateFx();
      if (payBtn) {
        payBtn.addEventListener('click', function (ev) {
          if (!CHECKOUT_URL) {
            ev.preventDefault();
            alert('Could not open checkout. Try again.');
          }
        });
      }
    })();
  </script>
</body>
</html>`);
}

async function handlePayJSRCheckout(req, res) {
  const resolved = resolveCheckoutParams(req);
  const { amount, success_url, product_name, display_title, currency: listCurrencyRaw } = resolved;
  if (!amount) {
    return res.status(400).send('Missing required parameters');
  }

  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const listCurrency = normalizeCurrencyCode(listCurrencyRaw, 'USD');
  const listAmountMinor = majorToMinor(amountNumber, 2);
  if (listAmountMinor < 100) {
    return res.status(400).send('Amount too small (minimum is $1.00)');
  }

  const configuredLinks = getPayJSRPaymentLinks();
  if (!configuredLinks.length) {
    return res.status(500).send(
      'No PayJSR payment links configured. Create links in the PayJSR dashboard, then set PAYJSR_PAYMENT_LINKS in .env (e.g. 15usd|https://checkout.payjsr.com/your-link-id or 500|https://...).'
    );
  }

  applyCommonHeaders(res);

  const maskedForProcessor = product_name ? String(product_name).trim() : 'Digital Ebook';
  const realForBuyer = display_title ? String(display_title).trim() : '';

  let zarQuote = null;
  try {
    zarQuote = await cachedFxQuote(listCurrency, PAYJSR_CHECKOUT_CURRENCY, listAmountMinor, 2);
  } catch (err) {
    console.warn('PayJSR FX quote failed (matching by USD still possible):', err?.message || err);
  }

  const zarAmountMinor = zarQuote ? Math.max(100, zarQuote.amountMinor) : 0;
  const zarAmountMajor = zarQuote ? minorToMajor(zarAmountMinor, 2) : 0;

  const match = findMatchingPayJSRLink({
    listAmountMajor: amountNumber,
    listCurrency,
    zarAmountMajor,
    tolerance: Number(process.env.PAYJSR_LINK_TOLERANCE || 0.12),
  });

  if (!match) {
    const catalog = configuredLinks
      .map((l) => {
        if (l.amountUsd != null) return `$${l.amountUsd} USD`;
        if (l.amountZar != null) return `R${l.amountZar} ZAR`;
        return 'unknown';
      })
      .join(', ');
    return res.status(404).send(
      `No PayJSR payment link matches this price (${amountNumber} ${listCurrency}` +
        (zarAmountMajor ? ` ≈ R${zarAmountMajor.toFixed(2)} ZAR` : '') +
        `). Configured links: ${catalog || 'none'}. Add a matching entry to PAYJSR_PAYMENT_LINKS.`
    );
  }

  const checkoutUrl = match.link.url;
  // Show the link's ZAR amount when known (what PayJSR will charge); else FX estimate.
  const displayZarMajor =
    match.link.amountZar != null
      ? Number(match.link.amountZar)
      : zarAmountMajor || amountNumber;
  const displayZarMinor = majorToMinor(displayZarMajor, 2);

  console.log('PayJSR checkout matched existing link:', {
    match_type: match.matchType,
    score: match.score,
    list_amount: amountNumber,
    list_currency: listCurrency,
    link_amount_zar: match.link.amountZar,
    link_amount_usd: match.link.amountUsd,
    checkout_url: checkoutUrl,
  });

  const showPrivacyBlurb =
    Boolean(display_title && String(display_title).trim()) &&
    String(realForBuyer).trim() !== String(maskedForProcessor).trim();

  return sendPayJSRCheckoutPage(res, {
    checkoutUrl,
    realTitle: realForBuyer || maskedForProcessor,
    maskedLabel: maskedForProcessor,
    zarAmountMajor: displayZarMajor.toFixed(2),
    zarAmountMinor: displayZarMinor,
    listAmountMajor: amountNumber.toFixed(2),
    listCurrency,
    currencies: CHECKOUT_DISPLAY_CURRENCIES,
    showPrivacyBlurb,
  });
}

function getWhopCredentials() {
  return {
    apiKey: String(process.env.WHOP_API_KEY || process.env.WHO_API_KEY || '').trim(),
    companyId: String(process.env.WHOP_COMPANY_ID || process.env.WHO_COMPANY_ID || '').trim(),
  };
}

function getStripeCredentials() {
  return {
    secretKey: String(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SK || '').trim(),
    publishableKey: String(
      process.env.STRIPE_PUBLISHABLE_KEY ||
        process.env.STRIPE_PK ||
        process.env.VITE_STRIPE_PUBLISHABLE_KEY ||
        ''
    ).trim(),
  };
}

/** Reuse Whop one-time plans by price so we do not create a new plan/link per checkout. */
const whopPlanByPriceCache = new Map();
const WHOP_PLAN_CACHE_TTL_MS = 15 * 60 * 1000;

function whopPriceCacheKey(currencyLower, amountNumber) {
  return `${currencyLower}:${Number(amountNumber).toFixed(2)}`;
}

function whopPriceProductSlug(currencyLower, amountNumber) {
  return `ebook-${currencyLower}-${Number(amountNumber).toFixed(2).replace('.', '-')}`;
}

function planMatchesWhopPrice(plan, amountNumber, currencyLower) {
  if (!plan || String(plan.plan_type || '') !== 'one_time') return false;
  if (String(plan.currency || '').toLowerCase() !== currencyLower) return false;
  const planPrice = Number(plan.initial_price);
  if (!Number.isFinite(planPrice)) return false;
  return planPrice.toFixed(2) === Number(amountNumber).toFixed(2);
}

async function whopApiJson(apiKey, apiPath, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.whop.com/api/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function findWhopPlanByPrice(apiKey, companyId, amountNumber, currencyLower) {
  const cacheKey = whopPriceCacheKey(currencyLower, amountNumber);
  const cached = whopPlanByPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WHOP_PLAN_CACHE_TTL_MS) {
    return cached.planId ? cached : null;
  }

  let after = null;
  for (let page = 0; page < 25; page++) {
    const qs = new URLSearchParams({
      account_id: companyId,
      first: '100',
    });
    qs.append('plan_types', 'one_time');
    if (after) qs.set('after', after);

    const { ok, data } = await whopApiJson(apiKey, `/plans?${qs.toString()}`);
    if (!ok) {
      console.warn('Whop list plans failed:', data?.error?.message || data?.message || 'unknown');
      break;
    }

    const plans = Array.isArray(data?.data) ? data.data : [];
    for (const plan of plans) {
      if (planMatchesWhopPrice(plan, amountNumber, currencyLower) && plan.id) {
        const entry = {
          planId: String(plan.id),
          purchaseUrl: plan.purchase_url ? String(plan.purchase_url) : '',
          at: Date.now(),
        };
        whopPlanByPriceCache.set(cacheKey, entry);
        return entry;
      }
    }

    const pageInfo = data?.page_info;
    if (!pageInfo?.has_next_page || !pageInfo?.end_cursor) break;
    after = pageInfo.end_cursor;
  }

  return null;
}

function extractWhopCheckoutLink(checkout) {
  const planId = checkout?.plan?.id;
  let checkoutLink = checkout?.purchase_url ? String(checkout.purchase_url) : '';
  if (checkoutLink.startsWith('/')) checkoutLink = `https://whop.com${checkoutLink}`;
  if (!checkoutLink && planId) checkoutLink = `https://whop.com/checkout/${planId}`;
  return checkoutLink;
}

function rememberWhopPlan(cacheKey, checkout) {
  const plan = checkout?.plan;
  if (!plan?.id) return;
  whopPlanByPriceCache.set(cacheKey, {
    planId: String(plan.id),
    purchaseUrl: plan.purchase_url ? String(plan.purchase_url) : '',
    at: Date.now(),
  });
}

async function createWhopCheckoutConfiguration(apiKey, payload) {
  return whopApiJson(apiKey, '/checkout_configurations', { method: 'POST', body: payload });
}

function sendWhopCheckoutPage(res, payload) {
  const {
    checkoutUrl,
    realTitle,
    maskedLabel,
    amountStr,
    currencyCode,
    showPrivacyBlurb,
    processorName = 'Whop',
    finePrint,
  } = payload;
  const htmlReal = escapeHtml(realTitle);
  const htmlMasked = escapeHtml(maskedLabel);
  const htmlAmount = escapeHtml(amountStr);
  const htmlCur = escapeHtml(currencyCode);
  const safeCheckoutUrl = escapeForJs(checkoutUrl);
  const fine =
    finePrint ||
    `You will receive access automatically after payment.`;
  applyCommonHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(`${SITE_NAME} · Continue`)}</title>
  <style>${CHECKOUT_UI_CSS}</style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:var(--primary)">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
        </div>`
            : `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>A generic description is sent to the payment processor so your receipt and bank statement stay discreet.</span>
        </div>`
        }
        <p class="amount">$${htmlAmount} <small style="font-size:.76rem;color:var(--muted);font-weight:700">${htmlCur}</small></p>
        <a class="btn" id="btn-whop" href="${escapeHtml(checkoutUrl)}">Pay and receive</a>
        <p class="fine">${escapeHtml(fine)}</p>
      </div>
    </article>
  </div>
  <script>
    (function () {
      var CHECKOUT_URL = '${safeCheckoutUrl}';
      var btn = document.getElementById('btn-whop');
      if (btn) btn.addEventListener('click', function (e) {
        e.preventDefault();
        window.location.href = CHECKOUT_URL;
      });
    })();
  </script>
</body>
</html>`);
}

/** Must use www — bare host 301-redirects and Node fetch turns POST into GET on redirect. */
const ZUCKPAY_API_BASE = 'https://www.zuckpay.com.br/conta/v3';

function getZuckPayCredentials() {
  return {
    clientId: String(process.env.ZUCKPAY_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.ZUCKPAY_CLIENT_SECRET || '').trim(),
  };
}

function zuckPayAuthHeader() {
  const { clientId, clientSecret } = getZuckPayCredentials();
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function zuckPayApi(path, { method = 'GET', body } = {}) {
  const { clientId, clientSecret } = getZuckPayCredentials();
  const headers = {
    Authorization: zuckPayAuthHeader(),
    Accept: 'application/json',
  };
  const init = { method, headers, redirect: 'manual' };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    });
  }
  const res = await fetch(`${ZUCKPAY_API_BASE}${path}`, init);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    throw new Error(
      `ZuckPay API redirected (${res.status})${location ? ` to ${location}` : ''}. Check ZUCKPAY_API_BASE.`
    );
  }
  return res;
}

function buildZuckPayCheckoutContext(req, resolved) {
  const { amount, success_url, product_name, display_title } = resolved;
  const amountNumber = Number(amount);
  const maskedForProcessor = product_name ? String(product_name).trim() : 'Digital Ebook';
  const realForBuyer = display_title ? String(display_title).trim() : '';
  const origin = `${req.protocol}://${req.get('host')}`;
  const extra = {
    display_title: realForBuyer,
    video_id: req.query.video_id ? String(req.query.video_id) : '',
    telegram_username: req.query.telegram_username ? String(req.query.telegram_username) : '',
  };
  const fromStoreSuccess = sameOriginUrl(success_url, origin);
  const forwardSuccess = fromStoreSuccess
    ? fromStoreSuccess
    : getEbooksReturnUrl(origin, 'success', maskedForProcessor, amountNumber.toFixed(2), {
        ...extra,
        display_title: realForBuyer || maskedForProcessor,
      });
  const successIntermediate = `${origin}/api/zuckpay-success?forward=${encodeURIComponent(forwardSuccess)}`;
  const cancel_url = buildCheckoutSelfCancelUrl(req, { ...resolved, method: 'zuckpay' });
  const webhookUrl = `${origin}/api/zuckpay-webhook`;
  const currencyRaw = String(resolved.currency || 'USD').toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  const externalId = ['EBK', extra.video_id || 'item', Date.now().toString(36)].join('-').slice(0, 120);
  const showPrivacyBlurb =
    Boolean(display_title && String(display_title).trim()) &&
    String(realForBuyer).trim() !== String(maskedForProcessor).trim();

  return {
    amountNumber,
    maskedForProcessor,
    realForBuyer,
    forwardSuccess,
    successIntermediate,
    cancel_url,
    webhookUrl,
    currencyCode,
    externalId,
    showPrivacyBlurb,
    success_url: String(success_url),
    extra,
  };
}

function sendZuckPayCardCheckoutPage(res, payload) {
  const {
    stripePublishableKey,
    realTitle,
    maskedLabel,
    amountStr,
    currencyCode,
    showPrivacyBlurb,
    paymentCanceled,
    cancelUrl,
    chargeContext,
  } = payload;
  const htmlReal = escapeHtml(realTitle);
  const htmlMasked = escapeHtml(maskedLabel);
  const htmlAmount = escapeHtml(amountStr);
  const htmlCur = escapeHtml(currencyCode);
  const safeCancel = escapeForJs(cancelUrl);
  const ctxJson = JSON.stringify(chargeContext);
  const cancelBanner = paymentCanceled
    ? `<p class="cancel-banner" role="status">Payment cancelled. No charges were made — you can try again below.</p>`
    : '';
  applyCommonHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(`${SITE_NAME} · Checkout`)}</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>${CHECKOUT_UI_CSS}</style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout · Card</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        ${cancelBanner}
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:var(--primary)">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
        </div>`
            : `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>A generic description is sent to the payment processor so your receipt and bank statement stay discreet.</span>
        </div>`
        }
        <p class="amount">$${htmlAmount} <small style="font-size:.76rem;color:var(--muted);font-weight:700">${htmlCur}</small></p>
        <form id="zp-form" novalidate>
          <div class="field">
            <label for="zp-name">Name on card</label>
            <input id="zp-name" name="name" type="text" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="zp-email">Email</label>
            <input id="zp-email" name="email" type="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label>Card details</label>
            <div id="card-element"></div>
            <div id="card-errors" role="alert"></div>
          </div>
          <button type="submit" class="btn" id="zp-submit">Pay and receive</button>
        </form>
        <p class="fine">Encrypted card payment in USD. After paying you return to the store.</p>
        <a class="back" href="${escapeHtml(cancelUrl)}">Cancel and go back</a>
      </div>
    </article>
  </div>
  <script>
    (function () {
      var CTX = ${ctxJson};
      var CANCEL_URL = '${safeCancel}';
      var stripe = Stripe(${JSON.stringify(stripePublishableKey)});
      var elements = stripe.elements();
      var card = elements.create('card', {
        style: {
          base: { color: '#111827', fontFamily: 'system-ui, sans-serif', fontSize: '16px', '::placeholder': { color: '#9ca3af' } },
          invalid: { color: '#dc2626' }
        }
      });
      card.mount('#card-element');
      card.on('change', function (e) {
        document.getElementById('card-errors').textContent = e.error ? e.error.message : '';
      });

      var form = document.getElementById('zp-form');
      var submitBtn = document.getElementById('zp-submit');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var nome = String(document.getElementById('zp-name').value || '').trim();
        var email = String(document.getElementById('zp-email').value || '').trim();
        if (!nome || !email) {
          document.getElementById('card-errors').textContent = 'Enter your name and email.';
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing…';
        stripe.createPaymentMethod({
          type: 'card',
          card: card,
          billing_details: { name: nome, email: email }
        }).then(function (result) {
          if (result.error) {
            document.getElementById('card-errors').textContent = result.error.message || 'Card error';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Pay securely';
            return;
          }
          return fetch('/api/zuckpay-charge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(Object.assign({}, CTX, {
              payment_method: result.paymentMethod.id,
              nome: nome,
              email: email
            }))
          });
        }).then(function (res) {
          if (!res) return;
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || 'Payment failed');
            if (data.redirect) {
              window.location.replace(data.redirect);
              return;
            }
            throw new Error('Unexpected payment response');
          });
        }).catch(function (err) {
          document.getElementById('card-errors').textContent = err.message || 'Payment could not be completed.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Pay securely';
        });
      });
    })();
  </script>
</body>
</html>`);
}

async function handleZuckPayCheckout(req, res) {
  const resolved = resolveCheckoutParams(req);
  const { amount, success_url, paymentCanceled } = resolved;
  if (!amount || !success_url) {
    const missing = [!amount && 'amount', !success_url && 'success_url'].filter(Boolean).join(', ');
    return res.status(400).send(`Missing required parameters (${missing}). Open checkout from the video store again.`);
  }

  const { clientId, clientSecret } = getZuckPayCredentials();
  if (!clientId || !clientSecret) {
    return res.status(500).send(
      'ZuckPay is not configured. Set ZUCKPAY_CLIENT_ID and ZUCKPAY_CLIENT_SECRET in your environment.'
    );
  }

  const ctx = buildZuckPayCheckoutContext(req, resolved);
  if (!Number.isFinite(ctx.amountNumber) || ctx.amountNumber <= 0) {
    return res.status(400).send('Invalid amount');
  }

  applyCommonHeaders(res);

  const keysRes = await zuckPayApi('/card/keys');
  const keysData = await keysRes.json().catch(() => ({}));
  if (!keysRes.ok) {
    const msg = keysData?.message || keysData?.error || JSON.stringify(keysData).slice(0, 400);
    console.error('ZuckPay card keys failed:', keysRes.status, msg);
    return res
      .status(keysRes.status >= 400 && keysRes.status < 600 ? keysRes.status : 502)
      .send(`Checkout failed (ZuckPay): ${msg}`);
  }

  const stripePublishableKey = String(keysData?.publishableKey || '').trim();
  const stripeIntl = keysData?.stripe?.enabled && keysData?.stripe?.mode === 'international';
  if (!stripePublishableKey || !stripeIntl) {
    return res.status(502).send(
      'Checkout failed (ZuckPay): international card (USD) is not enabled on your ZuckPay account.'
    );
  }

  return sendZuckPayCardCheckoutPage(res, {
    stripePublishableKey,
    realTitle: ctx.realForBuyer || ctx.maskedForProcessor,
    maskedLabel: ctx.maskedForProcessor,
    amountStr: ctx.amountNumber.toFixed(2),
    currencyCode: ctx.currencyCode,
    showPrivacyBlurb: ctx.showPrivacyBlurb,
    paymentCanceled,
    cancelUrl: ctx.cancel_url,
    chargeContext: {
      amount: ctx.amountNumber,
      currency: ctx.currencyCode,
      success_url: ctx.success_url,
      product_name: ctx.maskedForProcessor,
      video_id: ctx.extra.video_id,
      telegram_username: ctx.extra.telegram_username,
      external_id_client: ctx.externalId,
    },
  });
}

async function handleZuckPayCharge(req, res) {
  const b = req.body || {};
  const payment_method = String(b.payment_method || '').trim();
  const nome = String(b.nome || '').trim();
  const email = String(b.email || '').trim();
  const amount = Number(b.amount);
  const currencyCode = /^[A-Z]{3}$/.test(String(b.currency || 'USD').toUpperCase())
    ? String(b.currency || 'USD').toUpperCase()
    : 'USD';
  const success_url = String(b.success_url || '').trim();
  const product_name = String(b.product_name || 'Digital Ebook').trim();
  const video_id = b.video_id ? String(b.video_id) : '';
  const telegram_username = b.telegram_username ? String(b.telegram_username) : '';
  const external_id_client = String(b.external_id_client || `EBK-${Date.now().toString(36)}`).slice(0, 120);

  if (!payment_method.startsWith('pm_') || !nome || !email || !Number.isFinite(amount) || amount <= 0 || !success_url) {
    return res.status(400).json({ error: 'Missing required payment fields' });
  }

  const { clientId, clientSecret } = getZuckPayCredentials();
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'ZuckPay is not configured' });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const extra = { video_id, telegram_username };
  const fromStoreSuccess = sameOriginUrl(success_url, origin);
  const forwardSuccess = fromStoreSuccess
    ? fromStoreSuccess
    : getEbooksReturnUrl(origin, 'success', product_name, amount.toFixed(2), extra);
  const successIntermediate = `${origin}/api/zuckpay-success?forward=${encodeURIComponent(forwardSuccess)}`;
  const webhookUrl = `${origin}/api/zuckpay-webhook`;

  const chargePayload = {
    nome,
    email,
    valor: amount,
    currency: currencyCode,
    payment_method,
    urlnoty: webhookUrl,
    return_url: successIntermediate,
    external_id_client,
  };

  const chargeRes = await zuckPayApi('/card/charge', { method: 'POST', body: chargePayload });
  const chargeData = await chargeRes.json().catch(() => ({}));
  if (!chargeRes.ok) {
    const msg = chargeData?.message || chargeData?.failureMessage || chargeData?.error || 'Charge failed';
    console.error('ZuckPay card charge failed:', chargeRes.status, msg);
    return res.status(chargeRes.status >= 400 && chargeRes.status < 600 ? chargeRes.status : 402).json({ error: msg });
  }

  if (chargeData.isPaid || chargeData.status === 'PAID') {
    const tid = String(chargeData.transactionId || '');
    const sep = forwardSuccess.includes('?') ? '&' : '?';
    const redirect = tid ? `${forwardSuccess}${sep}order_id=${encodeURIComponent(tid)}` : forwardSuccess;
    return res.json({ success: true, redirect });
  }

  if (chargeData.status === 'PENDING_3DS' && chargeData.threeDSecureUrl) {
    return res.json({ success: true, redirect: String(chargeData.threeDSecureUrl) });
  }

  const decline = chargeData?.failureMessage || chargeData?.message || 'Payment declined';
  return res.status(402).json({ error: decline });
}

async function handleWhopCheckout(req, res) {
  const resolved = resolveCheckoutParams(req);
  const { amount, success_url, product_name, display_title } = resolved;
  if (!amount || !success_url) {
    const missing = [!amount && 'amount', !success_url && 'success_url'].filter(Boolean).join(', ');
    return res.status(400).send(`Missing required parameters (${missing}). Open checkout from the video store again.`);
  }

  const { apiKey, companyId } = getWhopCredentials();
  if (!apiKey || !companyId) {
    return res.status(500).send(
      'Whop is not configured. Set WHOP_API_KEY and WHOP_COMPANY_ID in your environment.'
    );
  }

  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('Invalid amount');
  }

  applyCommonHeaders(res);

  const maskedForProcessor = 'Digital Ebook';
  const realForBuyer = display_title ? String(display_title).trim() : '';
  const origin = `${req.protocol}://${req.get('host')}`;
  const extra = {
    display_title: realForBuyer,
    video_id: req.query.video_id ? String(req.query.video_id) : '',
    telegram_username: req.query.telegram_username ? String(req.query.telegram_username) : '',
  };
  const fromStoreSuccess = sameOriginUrl(success_url, origin);
  const forwardSuccess = fromStoreSuccess
    ? fromStoreSuccess
    : getEbooksReturnUrl(origin, 'success', maskedForProcessor, amountNumber.toFixed(2), {
        ...extra,
        display_title: realForBuyer || maskedForProcessor,
      });
  const successIntermediate = `${origin}/api/whop-success?forward=${encodeURIComponent(forwardSuccess)}`;

  const currencyRaw = String(resolved.currency || 'USD').toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  const currencyLower = currencyCode.toLowerCase();

  const metadata = {};
  if (extra.video_id) metadata.video_id = extra.video_id.slice(0, 200);
  if (extra.telegram_username) metadata.telegram_username = extra.telegram_username.slice(0, 200);
  metadata.payment_method = 'whop';

  const priceCacheKey = whopPriceCacheKey(currencyLower, amountNumber);
  const existingPlan = await findWhopPlanByPrice(apiKey, companyId, amountNumber, currencyLower);

  let createPayload;
  if (existingPlan?.planId) {
    console.log(`Whop: reusing plan ${existingPlan.planId} for ${currencyCode} ${amountNumber.toFixed(2)}`);
    createPayload = {
      mode: 'payment',
      currency: currencyLower,
      redirect_url: successIntermediate,
      metadata,
      plan_id: existingPlan.planId,
    };
  } else {
    const priceProductSlug = whopPriceProductSlug(currencyLower, amountNumber);
    console.log(`Whop: creating plan for ${currencyCode} ${amountNumber.toFixed(2)} (${priceProductSlug})`);
    createPayload = {
      mode: 'payment',
      currency: currencyLower,
      redirect_url: successIntermediate,
      metadata,
      plan: {
        company_id: companyId,
        currency: currencyLower,
        plan_type: 'one_time',
        initial_price: amountNumber,
        force_create_new_plan: false,
        title: 'Digital Ebook',
        description: 'Digital access — unlocked instantly after payment confirmation.',
        visibility: 'hidden',
        product: {
          external_identifier: priceProductSlug,
          title: 'Digital Ebook',
          description: 'Digital ebook and educational content.',
          visibility: 'hidden',
          redirect_purchase_url: successIntermediate,
        },
      },
    };
  }

  const { ok: createOk, status: createStatus, data: createData } = await createWhopCheckoutConfiguration(
    apiKey,
    createPayload
  );
  if (!createOk) {
    const msg =
      createData?.error?.message ||
      createData?.message ||
      JSON.stringify(createData?.error || createData).slice(0, 400);
    console.error('Whop checkout create failed:', createStatus, msg);
    return res
      .status(createStatus >= 400 && createStatus < 600 ? createStatus : 502)
      .send(`Checkout failed (Whop): ${msg}`);
  }

  const checkout = createData?.data || createData;
  rememberWhopPlan(priceCacheKey, checkout);
  const checkoutLink = extractWhopCheckoutLink(checkout);
  if (!checkoutLink) {
    return res.status(502).send('Checkout failed (Whop): missing checkout URL');
  }

  const showPrivacyBlurb =
    Boolean(display_title && String(display_title).trim()) &&
    String(realForBuyer).trim() !== String(maskedForProcessor).trim();

  return sendWhopCheckoutPage(res, {
    checkoutUrl: checkoutLink,
    realTitle: realForBuyer || maskedForProcessor,
    maskedLabel: maskedForProcessor,
    amountStr: amountNumber.toFixed(2),
    currencyCode,
    showPrivacyBlurb,
  });
}

async function handleStripeCheckout(req, res) {
  const resolved = resolveCheckoutParams(req);
  const { amount, success_url, product_name, display_title } = resolved;
  if (!amount || !success_url) {
    const missing = [!amount && 'amount', !success_url && 'success_url'].filter(Boolean).join(', ');
    return res.status(400).send(`Missing required parameters (${missing}). Open checkout from the video store again.`);
  }

  const { secretKey } = getStripeCredentials();
  if (!secretKey) {
    return res.status(500).send(
      'Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.'
    );
  }

  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const amountCents = Math.round(amountNumber * 100);
  if (amountCents < 50) {
    return res.status(400).send('Amount too small (minimum is $0.50)');
  }

  applyCommonHeaders(res);

  const maskedForProcessor = product_name ? String(product_name).trim() : 'Digital Ebook';
  const realForBuyer = display_title ? String(display_title).trim() : '';
  const origin = `${req.protocol}://${req.get('host')}`;
  const extra = {
    display_title: realForBuyer,
    video_id: req.query.video_id ? String(req.query.video_id) : '',
    telegram_username: req.query.telegram_username ? String(req.query.telegram_username) : '',
  };
  const fromStoreSuccess = sameOriginUrl(success_url, origin);
  const forwardSuccess = fromStoreSuccess
    ? fromStoreSuccess
    : getEbooksReturnUrl(origin, 'success', maskedForProcessor, amountNumber.toFixed(2), {
        ...extra,
        display_title: realForBuyer || maskedForProcessor,
      });
  const successIntermediate = `${origin}/api/stripe-success?forward=${encodeURIComponent(forwardSuccess)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelReturn = req.query.cancel_url
    ? String(req.query.cancel_url)
    : `${origin}/?status=cancel`;

  const currencyRaw = String(resolved.currency || 'USD').toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  const currencyLower = currencyCode.toLowerCase();

  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', successIntermediate);
  body.set('cancel_url', cancelReturn);
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', currencyLower);
  body.set('line_items[0][price_data][unit_amount]', String(amountCents));
  body.set('line_items[0][price_data][product_data][name]', maskedForProcessor.slice(0, 200));
  body.set('metadata[payment_method]', 'stripe');
  if (extra.video_id) body.set('metadata[video_id]', extra.video_id.slice(0, 200));
  if (extra.telegram_username) body.set('metadata[telegram_username]', extra.telegram_username.slice(0, 200));

  const createRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    const msg =
      createData?.error?.message ||
      createData?.message ||
      JSON.stringify(createData?.error || createData).slice(0, 400);
    console.error('Stripe checkout create failed:', createRes.status, msg);
    return res
      .status(createRes.status >= 400 && createRes.status < 600 ? createRes.status : 502)
      .send(`Checkout failed (Stripe): ${msg}`);
  }

  const checkoutUrl = createData?.url ? String(createData.url) : '';
  if (!checkoutUrl) {
    return res.status(502).send('Checkout failed (Stripe): missing checkout URL');
  }

  const showPrivacyBlurb =
    Boolean(display_title && String(display_title).trim()) &&
    String(realForBuyer).trim() !== String(maskedForProcessor).trim();

  return sendWhopCheckoutPage(res, {
    checkoutUrl,
    realTitle: realForBuyer || maskedForProcessor,
    maskedLabel: maskedForProcessor,
    amountStr: amountNumber.toFixed(2),
    currencyCode,
    showPrivacyBlurb,
    processorName: 'Stripe',
  });
}

function handlePayPalCheckout(req, res) {
  const resolved = resolveCheckoutParams(req);
  const { amount, success_url, product_name, display_title, paymentCanceled } = resolved;
  const currency = resolved.currency || 'USD';
  if (!amount || !success_url) {
    const missing = [!amount && 'amount', !success_url && 'success_url'].filter(Boolean).join(', ');
    return res.status(400).send(`Missing required parameters (${missing}). Open checkout from the video store again.`);
  }
  const cancel_url = buildCheckoutSelfCancelUrl(req, resolved);

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const paypalClientId = process.env.PAYPAL_CLIENT_ID;
  if (!paypalClientId) {
    return res.status(500).send('PayPal Client ID not configured. Set PAYPAL_CLIENT_ID in Render.');
  }

  applyCommonHeaders(res);
  res.setHeader('Permissions-Policy', 'interest-cohort=()');

  const currencyRaw = String(currency || 'USD').toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  const paypalScriptUrl = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(paypalClientId)}&currency=${encodeURIComponent(currencyCode)}`;
  /** PayPal line item — must use masked product_name only, never display_title. */
  const paypalDescription = String(product_name || 'Digital Ebook').trim() || 'Digital Ebook';
  const displayTitleRaw = String(display_title || '').trim();
  const hasDisplayTitle = displayTitleRaw.length > 0;
  const safeName = escapeForJs(paypalDescription);
  const safeSuccess = escapeForJs(success_url);
  const safeCancel = escapeForJs(cancel_url);
  const safeBrand = escapeForJs(SITE_NAME);
  const amountStr = amountNum.toFixed(2);
  const pageTitle = escapeHtml(`${SITE_NAME} · Checkout`);
  const htmlBrand = escapeHtml(SITE_NAME);
  const htmlPaypalLabel = escapeHtml(paypalDescription);
  const htmlProductFallback = htmlPaypalLabel;
  const htmlRealTitle = hasDisplayTitle ? escapeHtml(displayTitleRaw) : '';
  const cancelBanner = paymentCanceled
    ? `<p class="cancel-banner" role="status">Payment cancelled. No charges were made — you can try again below.</p>`
    : '';
  const orderBlock = hasDisplayTitle
    ? `<p class="label">Your order</p>
        <p class="product product-real">${htmlRealTitle}</p>
        <div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <p class="privacy-p">PayPal only receives a generic description: <span class="paypal-label">“${htmlPaypalLabel}”</span>. Your PayPal receipt and card statement will <em>not</em> show the title above.</p>
        </div>`
    : `<p class="label">Your order</p>
        <p class="product">${htmlProductFallback}</p>
        <div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <p class="privacy-p">A generic description is sent to PayPal so your receipt and bank statement stay discreet.</p>
        </div>`;

  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Referrer-Policy" content="no-referrer">
  <title>${pageTitle}</title>
  <style>${CHECKOUT_UI_CSS}</style>
  <script src="${paypalScriptUrl}" data-namespace="paypal_sdk" referrerpolicy="no-referrer"></script>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout</p>
        <h1 class="brand">${htmlBrand}</h1>
        <div class="divider" aria-hidden="true"></div>
        ${cancelBanner}
        ${orderBlock}
        <p class="amount"><span class="cur-symbol">$</span>${amountStr}<span class="cur-code">${escapeHtml(currencyCode)}</span></p>
        <div class="pp-wrap">
          <p class="pp-label">Pay with PayPal or card</p>
          <div id="paypal-button-container"></div>
        </div>
        <p class="fine" id="loading">Loading payment…</p>
        <p class="fine">You will receive access automatically after payment.</p>
      </div>
    </article>
  </div>
  <script>
    (function(){
      var SUCCESS_URL = '${safeSuccess}';
      var CANCEL_URL = '${safeCancel}';
      function initPayPal(){
        if (typeof paypal_sdk === 'undefined' || !paypal_sdk.Buttons) { setTimeout(initPayPal,100); return; }
        var el = document.getElementById('loading');
        if (el) el.style.display = 'none';
        paypal_sdk.Buttons({
          createOrder: function(data, actions) {
            return actions.order.create({
              purchase_units: [{
                description: '${safeName}',
                amount: { value: '${amountStr}', currency_code: '${currencyCode}' }
              }],
              application_context: {
                brand_name: '${safeBrand}',
                landing_page: 'NO_PREFERENCE',
                user_action: 'PAY_NOW'
              }
            });
          },
          onApprove: function(data, actions) {
            return actions.order.capture().then(function(details) {
              var sep = SUCCESS_URL.indexOf('?') >= 0 ? '&' : '?';
              var email = (details.payer && details.payer.email_address) ? encodeURIComponent(details.payer.email_address) : '';
              var firstName = (details.payer && details.payer.name && details.payer.name.given_name) ? details.payer.name.given_name : '';
              var lastName = (details.payer && details.payer.name && details.payer.name.surname) ? details.payer.name.surname : '';
              var fullName = encodeURIComponent((firstName + ' ' + lastName).trim());
              var payerId = (details.payer && details.payer.payer_id) ? details.payer.payer_id : '';
              window.location.replace(SUCCESS_URL + sep + 'order_id=' + encodeURIComponent(data.orderID) + '&payer_id=' + encodeURIComponent(payerId) + '&buyer_email=' + email + '&buyer_name=' + fullName);
            });
          },
          onCancel: function() { window.location.replace(CANCEL_URL); },
          onError: function(err) { console.error(err); alert('Payment could not be completed. Please try again.'); },
          style: { layout: 'vertical', color: 'blue', shape: 'pill', label: 'paypal', height: 48 }
        }).render('#paypal-button-container');
      }
      initPayPal();
    })();
  </script>
</body>
</html>`);
}

// Dispatcher:
// - method=zuckpay -> ZuckPay international card (USD, Stripe) on this host
// - method=stripe -> Stripe Checkout (masked line item) + redirect to checkout.stripe.com
// - method=whop -> Whop checkout (API + redirect whop.com)
// - method=paypal -> masked PayPal flow (on this host)
// - method=paddle -> Paddle Billing: API transaction + Paddle.js overlay on this host
// - method=payjsr -> PayJSR hosted checkout (ZAR) with FX preview on this host
// Default: whop
app.get('/api/paypal-checkout', async (req, res) => {
  try {
    const method = String(req.query.method || CHECKOUT_DEFAULT_METHOD).toLowerCase();
    if (method === 'zuckpay') {
      return await handleZuckPayCheckout(req, res);
    }
    if (method === 'stripe') {
      return await handleStripeCheckout(req, res);
    }
    if (method === 'whop') {
      return await handleWhopCheckout(req, res);
    }
    if (method === 'payjsr') {
      return await handlePayJSRCheckout(req, res);
    }
    if (method === 'paddle') {
      return await handlePaddleCheckout(req, res);
    }
    return handlePayPalCheckout(req, res);
  } catch (err) {
    console.error('Checkout dispatch error:', err);
    return res.status(500).send('Checkout failed');
  }
});

app.get('/api/zuckpay-checkout', async (req, res) => {
  try {
    return await handleZuckPayCheckout(req, res);
  } catch (err) {
    console.error('ZuckPay checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

app.post('/api/zuckpay-charge', async (req, res) => {
  try {
    return await handleZuckPayCharge(req, res);
  } catch (err) {
    console.error('ZuckPay charge error:', err);
    return res.status(500).json({ error: 'Payment failed' });
  }
});

app.get('/api/whop-checkout', async (req, res) => {
  try {
    return await handleWhopCheckout(req, res);
  } catch (err) {
    console.error('Whop checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

app.get('/api/stripe-checkout', async (req, res) => {
  try {
    return await handleStripeCheckout(req, res);
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

// PayJSR checkout — same as /api/paypal-checkout?method=payjsr
app.get('/api/payjsr-checkout', async (req, res) => {
  try {
    return await handlePayJSRCheckout(req, res);
  } catch (err) {
    console.error('PayJSR checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

app.get('/api/paddle-checkout', async (req, res) => {
  try {
    return await handlePaddleCheckout(req, res);
  } catch (err) {
    console.error('Paddle checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

app.get('/api/payjsr-fx', async (req, res) => {
  try {
    const from = normalizeCurrencyCode(req.query.from, PAYJSR_CHECKOUT_CURRENCY);
    const to = normalizeCurrencyCode(req.query.to, 'USD');
    const amountMinor = Math.max(1, Math.round(Number(req.query.amount) || 0));
    if (!amountMinor) {
      return res.status(400).json({ ok: false, error: 'amount required (minor units)' });
    }
    const meta = CHECKOUT_DISPLAY_CURRENCIES.find((c) => c.code === to);
    const decimals = meta?.decimals ?? 2;
    const quote = await cachedFxQuote(from, to, amountMinor, decimals);
    return res.json({
      ok: true,
      from,
      to,
      amount_minor: quote.amountMinor,
      rate: quote.rate,
      decimals: quote.decimals,
      source: quote.source,
      approximate: quote.source !== 'env',
    });
  } catch (err) {
    console.error('PayJSR FX error:', err?.message || err);
    return res.status(502).json({ ok: false, error: err?.message || 'FX quote failed' });
  }
});

function sendCheckoutForwardPage(res, forward, paymentId) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Processing…</title>
</head>
<body>
  <script>
    (function () {
      var forwardUrl = ${JSON.stringify(forward)};
      var paymentId = ${JSON.stringify(paymentId)};
      var hasQuery = forwardUrl.indexOf('?') >= 0;
      var sep = hasQuery ? '&' : '?';
      if (paymentId) {
        window.location.replace(forwardUrl + sep + 'order_id=' + encodeURIComponent(paymentId));
      } else {
        window.location.replace(forwardUrl);
      }
    })();
  </script>
</body>
</html>
  `);
}

// After Paddle (or legacy processors), forward to the storefront success URL with order_id when present.
app.get('/api/paddle-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    const paymentId = String(
      req.query.payment_id ||
        req.query.order_id ||
        req.query.pid ||
        req.query.paymentId ||
        req.query.transaction_id ||
        req.query._ptxn ||
        ''
    );
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }
    return sendCheckoutForwardPage(res, forward, paymentId);
  } catch (err) {
    console.error('Paddle success forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.get('/api/payjsr-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    const paymentId = String(
      req.query.payment_id ||
        req.query.order_id ||
        req.query.pid ||
        req.query.paymentId ||
        req.query.transaction_id ||
        req.query._ptxn ||
        ''
    );
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }
    return sendCheckoutForwardPage(res, forward, paymentId);
  } catch (err) {
    console.error('Checkout forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.get('/api/whop-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    const paymentId = String(
      req.query.payment_id ||
        req.query.order_id ||
        req.query.receipt_id ||
        req.query.membership_id ||
        req.query.checkout_id ||
        ''
    );
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }
    return sendCheckoutForwardPage(res, forward, paymentId);
  } catch (err) {
    console.error('Whop success forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.get('/api/stripe-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    const paymentId = String(req.query.session_id || req.query.payment_id || req.query.order_id || '');
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }
    return sendCheckoutForwardPage(res, forward, paymentId);
  } catch (err) {
    console.error('Stripe success forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.get('/api/zuckpay-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    const paymentId = String(
      req.query.transaction_id ||
        req.query.transactionId ||
        req.query.order_id ||
        req.query.orderId ||
        ''
    );
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }
    return sendCheckoutForwardPage(res, forward, paymentId);
  } catch (err) {
    console.error('ZuckPay success forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.post('/api/zuckpay-webhook', (req, res) => {
  try {
    const event = req.body?.event;
    const txn = req.body?.transaction;
    if (event && txn?.id) {
      console.log('ZuckPay webhook:', event, txn.id, txn.status);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('ZuckPay webhook error:', err);
    res.sendStatus(200);
  }
});

app.get('/api/payjsr-links', (req, res) => {
  const links = getPayJSRPaymentLinks();
  res.json({
    ok: true,
    count: links.length,
    tolerance: Number(process.env.PAYJSR_LINK_TOLERANCE || 0.12),
    links: links.map((l) => ({
      amount_zar: l.amountZar,
      amount_usd: l.amountUsd,
      name: l.name || null,
      url: l.url,
    })),
  });
});

app.get('/api/health', async (req, res) => {
  const whop = getWhopCredentials();
  const stripe = getStripeCredentials();
  const zuck = getZuckPayCredentials();
  const payjsr = getPayJSRCredentials();
  const links = getPayJSRPaymentLinks();
  res.json({
    status: 'OK',
    site: SITE_NAME,
    zuckpay_configured: Boolean(zuck.clientId && zuck.clientSecret),
    whop_configured: Boolean(whop.apiKey && whop.companyId),
    stripe_configured: Boolean(stripe.secretKey),
    payjsr_configured: Boolean(payjsr.secretKey && payjsr.publicKey && payjsr.merchantUserId),
    payjsr_payment_links: links.length,
    paddle_configured: Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN),
    paypal_configured: Boolean(process.env.PAYPAL_CLIENT_ID),
    checkout_default: CHECKOUT_DEFAULT_METHOD,
    payjsr_checkout_currency: PAYJSR_CHECKOUT_CURRENCY,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} running on port ${PORT}`);
});
