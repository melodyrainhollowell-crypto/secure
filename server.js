import 'dotenv/config';
import express from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const SITE_NAME = process.env.SITE_NAME || 'EbookStore';
/** Telegram for post-payment redirect (checkout success on this host). Videos-site passes Supabase user via ?telegram_username= when possible. */
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME || '';
/** Default checkout for videos-site and bare /api/paypal-checkout links. */
const CHECKOUT_DEFAULT_METHOD = 'whop';

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
  <style>
    :root { --bg-deep: #020617; --paper: rgba(2, 8, 36, 0.94); --primary: #ff3366; --accent: #00e5ff; --text: #e8e8e8; --muted: rgba(148, 163, 184, 0.92); }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 28px 18px;
      background: linear-gradient(180deg, #030925 0%, var(--bg-deep) 50%, #000 100%);
      color: var(--text);
    }
    .wrap { width: 100%; max-width: 420px; }
    .card {
      border-radius: 20px; background: var(--paper);
      border: 1px solid rgba(129, 140, 248, 0.22);
      box-shadow: 0 24px 64px rgba(0,0,0,.55); overflow: hidden;
    }
    .card-accent { height: 4px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .card-body { padding: 1.55rem 1.45rem 1.35rem; }
    .eyebrow { font-size: 0.68rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem; }
    .brand { font-size: 1.08rem; font-weight: 800; letter-spacing: -.03em; margin-bottom: .75rem; }
    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(129,140,248,.35), transparent); margin: .2rem 0 .85rem; }
    .label { font-size: .62rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: .25rem; }
    .real { font-size: .95rem; font-weight: 600; margin-bottom: .55rem; line-height: 1.42; }
    .privacy-callout {
      font-size: .72rem; line-height: 1.52; color: var(--muted);
      background: rgba(0, 229, 255, 0.06); border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 12px; padding: .7rem .85rem; margin-bottom: .9rem;
    }
    .privacy-callout strong {
      display: block; font-size: .65rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem;
    }
    .amount { font-size: 1.95rem; font-weight: 800; color: var(--primary); margin-bottom: 1rem; letter-spacing: -.04em; }
    .btn {
      display: block; width: 100%; text-align: center;
      font-weight: 800; padding: .85rem 1rem; border-radius: 14px;
      background: linear-gradient(120deg, #6c54ff 0%, #0096d9 52%, #00c9c8);
      color: #fff; border: none; cursor: pointer; font-family: inherit; font-size: .92rem;
      box-shadow: 0 14px 40px rgba(108, 84, 255, .28);
      transition: transform .15s, filter .15s;
    }
    .btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
    .fine { font-size: .66rem; color: var(--muted); text-align: center; margin-top: .7rem; line-height: 1.48; word-break: break-word; }
  </style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Secure checkout · Paddle</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:#7dd3fc">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
        </div>`
            : `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>A generic description is sent to the payment processor so your receipt and bank statement stay discreet.</span>
        </div>`
        }
        <p class="amount">$${htmlAmount} <small style="font-size:.76rem;color:var(--muted);font-weight:700">${htmlCur}</small></p>
        <button type="button" class="btn" id="btn-paddle">Open secure payment</button>
        <p class="fine">Checkout opens in a secure overlay. If nothing appears, tap the button again or disable strict blockers for this page.</p>
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
      window.addEventListener('load', function () {
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
    `Pay with card, Apple Pay, Cash App and more. Your private library unlocks instantly once payment is confirmed.`;
  applyCommonHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(`${SITE_NAME} · Continue`)}</title>
  <style>
    :root { --bg-deep: #0a0a0a; --paper: #141414; --primary: #00aff0; --primary-deep: #008ecf; --accent: #33c0ff; --text: #ffffff; --muted: #8e8e8e; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 28px 18px;
      background: linear-gradient(180deg, #0d0d0d 0%, var(--bg-deep) 50%, #000 100%);
      color: var(--text);
    }
    .wrap { width: 100%; max-width: 420px; }
    .card { border-radius: 20px; background: var(--paper); border: 1px solid rgba(0, 175, 240, 0.22); box-shadow: 0 24px 64px rgba(0,0,0,.55), 0 0 48px rgba(0, 175, 240, 0.06); overflow: hidden; }
    .card-accent { height: 4px; background: linear-gradient(90deg, var(--primary-deep), var(--primary), var(--accent)); }
    .card-body { padding: 1.55rem 1.45rem 1.35rem; }
    .eyebrow { font-size: 0.68rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem; }
    .brand { font-size: 1.08rem; font-weight: 800; letter-spacing: -.03em; margin-bottom: .75rem; }
    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(0, 175, 240, .35), transparent); margin: .2rem 0 .85rem; }
    .label { font-size: .62rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: .25rem; }
    .real { font-size: .95rem; font-weight: 600; margin-bottom: .55rem; line-height: 1.42; }
    .privacy-callout {
      font-size: .72rem; line-height: 1.52; color: var(--muted);
      background: rgba(0, 175, 240, 0.06); border: 1px solid rgba(0, 175, 240, 0.2);
      border-radius: 12px; padding: .7rem .85rem; margin-bottom: .9rem;
    }
    .privacy-callout strong {
      display: block; font-size: .65rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem;
    }
    .amount { font-size: 1.95rem; font-weight: 800; color: var(--primary); margin-bottom: 1rem; letter-spacing: -.04em; }
    .btn {
      display: block; width: 100%; text-align: center;
      font-weight: 800; padding: .85rem 1rem; border-radius: 14px;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-deep) 100%);
      color: #fff; border: none; cursor: pointer; font-family: inherit; font-size: .92rem;
      box-shadow: 0 10px 32px rgba(0, 175, 240, .28);
      text-decoration: none;
    }
    .fine { font-size: .66rem; color: var(--muted); text-align: center; margin-top: .7rem; line-height: 1.48; }
  </style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Secure encrypted checkout</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:#7dd3fc">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
        </div>`
            : `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>A generic description is sent to the payment processor so your receipt and bank statement stay discreet.</span>
        </div>`
        }
        <p class="amount">$${htmlAmount} <small style="font-size:.76rem;color:var(--muted);font-weight:700">${htmlCur}</small></p>
        <a class="btn" id="btn-whop" href="${escapeHtml(checkoutUrl)}">Pay Instantly</a>
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
      window.addEventListener('load', function () {
        setTimeout(function () { window.location.href = CHECKOUT_URL; }, 350);
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
  <style>
    :root { --bg-deep: #020617; --paper: rgba(2, 8, 36, 0.94); --primary: #ff3366; --accent: #00e5ff; --text: #e8e8e8; --muted: rgba(148, 163, 184, 0.92); }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 28px 18px;
      background: linear-gradient(180deg, #030925 0%, var(--bg-deep) 50%, #000 100%);
      color: var(--text);
    }
    .wrap { width: 100%; max-width: 420px; }
    .card { border-radius: 20px; background: var(--paper); border: 1px solid rgba(129, 140, 248, 0.22); box-shadow: 0 24px 64px rgba(0,0,0,.55); overflow: hidden; }
    .card-accent { height: 4px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .card-body { padding: 1.55rem 1.45rem 1.35rem; }
    .eyebrow { font-size: 0.68rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem; }
    .brand { font-size: 1.08rem; font-weight: 800; letter-spacing: -.03em; margin-bottom: .75rem; }
    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(129,140,248,.35), transparent); margin: .2rem 0 .85rem; }
    .label { font-size: .62rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: .25rem; }
    .real { font-size: .95rem; font-weight: 600; margin-bottom: .55rem; line-height: 1.42; }
    .cancel-banner {
      font-size: 0.82rem; line-height: 1.45; color: #fcd34d;
      background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.28);
      border-radius: 10px; padding: 0.65rem 0.75rem; margin-bottom: 0.85rem;
    }
    .privacy-callout {
      font-size: .72rem; line-height: 1.52; color: var(--muted);
      background: rgba(0, 229, 255, 0.06); border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 12px; padding: .7rem .85rem; margin-bottom: .9rem;
    }
    .privacy-callout strong {
      display: block; font-size: .65rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem;
    }
    .amount { font-size: 1.95rem; font-weight: 800; color: var(--primary); margin-bottom: 1rem; letter-spacing: -.04em; }
    .field { margin-bottom: .75rem; }
    .field label { display: block; font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: .35rem; }
    .field input {
      width: 100%; padding: .72rem .8rem; border-radius: 10px; border: 1px solid rgba(129,140,248,.28);
      background: rgba(255,255,255,.04); color: var(--text); font: inherit;
    }
    #card-element {
      padding: .78rem .8rem; border-radius: 10px; border: 1px solid rgba(129,140,248,.28);
      background: rgba(255,255,255,.04);
    }
    #card-errors { font-size: .74rem; color: #fca5a5; min-height: 1.1rem; margin-top: .45rem; }
    .btn {
      display: block; width: 100%; text-align: center;
      font-weight: 800; padding: .85rem 1rem; border-radius: 14px; margin-top: .85rem;
      background: linear-gradient(120deg, #6c54ff 0%, #0096d9 52%, #00c9c8);
      color: #fff; border: none; cursor: pointer; font-family: inherit; font-size: .92rem;
      box-shadow: 0 14px 40px rgba(108, 84, 255, .28);
    }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .fine { font-size: .66rem; color: var(--muted); text-align: center; margin-top: .7rem; line-height: 1.48; }
    .back { display: block; text-align: center; margin-top: .55rem; font-size: .72rem; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Secure checkout · Card (USD)</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <div class="divider"></div>
        ${cancelBanner}
        <p class="label">Your order</p>
        <p class="real">${htmlReal}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout" role="status">
          <strong>Privacy</strong>
          <span>Payment processor receives a neutral description (<span style="font-family:ui-monospace,monospace;color:#7dd3fc">${htmlMasked}</span>). Your receipt and bank statement avoid the title above.</span>
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
          <button type="submit" class="btn" id="zp-submit">Pay securely</button>
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
          base: { color: '#e8e8e8', fontFamily: 'system-ui, sans-serif', fontSize: '16px', '::placeholder': { color: '#94a3b8' } },
          invalid: { color: '#fca5a5' }
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
  <style>
    :root {
      --bg-deep: #020617;
      --bg-mid: #030925;
      --paper: rgba(2, 8, 36, 0.94);
      --paper-border: rgba(129, 140, 248, 0.22);
      --primary: #ff3366;
      --accent: #00e5ff;
      --text: #e8e8e8;
      --muted: #9fb3ff;
      --muted2: rgba(148, 163, 184, 0.88);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Roboto', 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px 18px;
      background: linear-gradient(180deg, var(--bg-mid) 0%, var(--bg-deep) 50%, #000 100%);
      color: var(--text);
      position: relative;
      overflow-x: hidden;
    }
    .ambient {
      pointer-events: none;
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 90% 55% at 50% -25%, rgba(255, 51, 102, 0.2), transparent),
        radial-gradient(ellipse 55% 45% at 100% 40%, rgba(0, 229, 255, 0.07), transparent),
        radial-gradient(ellipse 45% 45% at 0% 85%, rgba(255, 51, 102, 0.09), transparent);
    }
    .wrap { width: 100%; max-width: 420px; position: relative; z-index: 1; }
    .card {
      position: relative;
      border-radius: 20px;
      background: var(--paper);
      border: 1px solid var(--paper-border);
      box-shadow:
        0 0 0 1px rgba(255, 51, 102, 0.07),
        0 24px 64px rgba(0, 0, 0, 0.55),
        0 0 100px rgba(255, 51, 102, 0.06);
      overflow: hidden;
      backdrop-filter: blur(12px);
    }
    .card-accent { height: 4px; width: 100%; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .card-body { padding: 1.65rem 1.5rem 1.45rem; }
    .eyebrow {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 0.3rem;
    }
    .brand {
      font-size: 1.32rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: var(--text);
      line-height: 1.2;
      margin-bottom: 0.65rem;
    }
    .badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.78rem;
      color: var(--muted2);
      margin-bottom: 0.95rem;
    }
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(129, 140, 248, 0.35), transparent);
      margin: 0.15rem 0 0.95rem;
    }
    .cancel-banner {
      font-size: 0.82rem;
      line-height: 1.45;
      color: #fcd34d;
      background: rgba(251, 191, 36, 0.1);
      border: 1px solid rgba(251, 191, 36, 0.28);
      border-radius: 10px;
      padding: 0.65rem 0.75rem;
      margin-bottom: 0.85rem;
    }
    .label {
      font-size: 0.62rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.3rem;
    }
    .product { font-size: 0.9rem; color: var(--text); line-height: 1.45; margin-bottom: 0.8rem; opacity: 0.93; }
    .product-real { font-weight: 600; font-size: 0.95rem; margin-bottom: 0.45rem !important; }
    .privacy-callout {
      font-size: 0.72rem;
      line-height: 1.5;
      color: var(--muted2);
      background: rgba(0, 229, 255, 0.06);
      border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 12px;
      padding: 0.7rem 0.85rem;
      margin-bottom: 0.85rem;
    }
    .privacy-callout strong {
      display: block;
      font-size: 0.65rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 0.4rem;
    }
    .privacy-p { margin: 0; }
    .paypal-label {
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.88em;
      color: var(--muted);
      word-break: break-word;
    }
    .amount {
      font-size: 2.1rem;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: var(--primary);
      margin-bottom: 1.25rem;
      text-shadow: 0 0 48px rgba(255, 51, 102, 0.22);
    }
    .amount .cur-symbol { font-size: 1.25rem; opacity: 0.88; margin-right: 1px; }
    .amount .cur-code {
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--muted);
      margin-left: 6px;
      letter-spacing: 0.04em;
    }
    .pp-wrap {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(148, 163, 255, 0.14);
      border-radius: 16px;
      padding: 1rem 0.95rem 1.05rem;
    }
    .pp-label {
      font-size: 0.76rem;
      font-weight: 600;
      color: var(--muted2);
      text-align: center;
      margin-bottom: 0.6rem;
    }
    #paypal-button-container { min-height: 48px; }
    #loading { text-align: center; font-size: 0.78rem; color: var(--muted); margin-top: 0.7rem; }
    .fine {
      font-size: 0.66rem;
      line-height: 1.5;
      color: var(--muted2);
      text-align: center;
      margin-top: 0.55rem;
    }
  </style>
  <script src="${paypalScriptUrl}" data-namespace="paypal_sdk" referrerpolicy="no-referrer"></script>
</head>
<body>
  <div class="ambient" aria-hidden="true"></div>
  <div class="wrap">
    <article class="card">
      <div class="card-accent" aria-hidden="true"></div>
      <div class="card-body">
        <p class="eyebrow">Checkout</p>
        <h1 class="brand">${htmlBrand}</h1>
        <p class="badge"><span aria-hidden="true">🔒</span> Encrypted session · PayPal secure payment</p>
        <div class="divider" aria-hidden="true"></div>
        ${cancelBanner}
        ${orderBlock}
        <p class="amount"><span class="cur-symbol">$</span>${amountStr}<span class="cur-code">${escapeHtml(currencyCode)}</span></p>
        <div class="pp-wrap">
          <p class="pp-label">Pay with PayPal or card</p>
          <div id="paypal-button-container"></div>
        </div>
        <p class="fine" id="loading">Loading secure payment…</p>
        <p class="fine">After paying you will return to the store. If you cancel, you stay on this checkout page.</p>
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
// - method=whop -> Whop checkout configuration (masked product/plan) + redirect to whop.com
// - method=paypal -> masked PayPal flow (on this host)
// - method=paddle (or legacy payjsr) -> Paddle Billing: API transaction + Paddle.js overlay on this host
// Default: whop (Stripe/PayPal/Paddle/ZuckPay via explicit method=...)
app.get('/api/paypal-checkout', async (req, res) => {
  try {
    const method = String(req.query.method || CHECKOUT_DEFAULT_METHOD).toLowerCase();
    if (method === 'zuckpay') {
      return await handleZuckPayCheckout(req, res);
    }
    if (method === 'stripe') {
      return res.status(503).send('Stripe checkout is temporarily disabled. Please use the store checkout button (Whop).');
    }
    if (method === 'whop') {
      return await handleWhopCheckout(req, res);
    }
    if (method === 'paddle' || method === 'payjsr') {
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
  return res.status(503).send('Stripe checkout is temporarily disabled. Please use Whop checkout.');
});

// Legacy path name — same as /api/paypal-checkout?method=paddle
app.get('/api/payjsr-checkout', async (req, res) => {
  try {
    return await handlePaddleCheckout(req, res);
  } catch (err) {
    console.error('Paddle checkout error:', err);
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

app.get('/api/health', (req, res) => {
  const whop = getWhopCredentials();
  const stripe = getStripeCredentials();
  const zuck = getZuckPayCredentials();
  res.json({
    status: 'OK',
    site: SITE_NAME,
    zuckpay_configured: Boolean(zuck.clientId && zuck.clientSecret),
    whop_configured: Boolean(whop.apiKey && whop.companyId),
    stripe_configured: Boolean(stripe.secretKey),
    paddle_configured: Boolean(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN),
    paypal_configured: Boolean(process.env.PAYPAL_CLIENT_ID),
    checkout_default: CHECKOUT_DEFAULT_METHOD,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} running on port ${PORT}`);
});
