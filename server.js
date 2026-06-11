import 'dotenv/config';
import express from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const SITE_NAME = process.env.SITE_NAME || 'EbookStore';
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME || '';

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
).replace(/\/+$/, '');
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
).trim();

let payjsrKeyCache = '';
let payjsrKeyCacheAt = 0;
const PAYJSR_KEY_CACHE_MS = 120_000;

app.use(express.json());

// Landing page (dinâmica com SITE_NAME)
app.get('/', (req, res) => {
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

const applyCommonHeaders = (res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
};

const getEbooksReturnUrl = (origin, status, productName, amount) => {
  const params = new URLSearchParams();
  params.set('status', status);
  if (productName) params.set('product_name', String(productName));
  if (amount !== undefined && amount !== null && amount !== '') params.set('amount', String(amount));
  return `${origin}/?${params.toString()}`;
};

async function getPayjsrSecretKey() {
  const fromEnv = String(process.env.PAYJSR_SECRET_KEY || '').trim();
  if (fromEnv) return fromEnv;

  const now = Date.now();
  if (payjsrKeyCache && now - payjsrKeyCacheAt < PAYJSR_KEY_CACHE_MS) return payjsrKeyCache;

  if (!SUPABASE_URL || !SUPABASE_KEY) return '';

  try {
    const url = `${SUPABASE_URL}/rest/v1/site_config?select=stripe_secret_key&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!r.ok) return payjsrKeyCache || '';
    const rows = await r.json();
    const key = String(rows?.[0]?.stripe_secret_key || '').trim();
    if (key) {
      payjsrKeyCache = key;
      payjsrKeyCacheAt = now;
    }
    return key || payjsrKeyCache || '';
  } catch (e) {
    console.warn('PayJSR key from Supabase failed:', e.message);
    return payjsrKeyCache || '';
  }
}

function sendPayjsrCheckoutPage(res, payload) {
  const { checkoutUrl, realTitle, maskedLabel, amountStr, currencyCode, showPrivacyBlurb } = payload;
  const safeCheckoutUrl = escapeForJs(checkoutUrl);
  applyCommonHeaders(res);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(`${SITE_NAME} · Continue`)}</title>
  <style>
    :root { --bg-deep: #020617; --paper: rgba(2, 8, 36, 0.94); --primary: #ff3366; --accent: #00e5ff; --text: #e8e8e8; --muted: rgba(148, 163, 184, 0.92); }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 28px 18px; background: linear-gradient(180deg, #030925 0%, var(--bg-deep) 50%, #000 100%); color: var(--text); }
    .wrap { width: 100%; max-width: 420px; }
    .card { border-radius: 20px; background: var(--paper); border: 1px solid rgba(129, 140, 248, 0.22); box-shadow: 0 24px 64px rgba(0,0,0,.55); overflow: hidden; }
    .card-accent { height: 4px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .card-body { padding: 1.55rem 1.45rem 1.35rem; }
    .eyebrow { font-size: 0.68rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: .35rem; }
    .brand { font-size: 1.08rem; font-weight: 800; margin-bottom: .75rem; }
    .label { font-size: .62rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: .25rem; }
    .real { font-size: .95rem; font-weight: 600; margin-bottom: .55rem; line-height: 1.42; }
    .privacy-callout { font-size: .72rem; line-height: 1.52; color: var(--muted); background: rgba(0, 229, 255, 0.06); border: 1px solid rgba(0, 229, 255, 0.2); border-radius: 12px; padding: .7rem .85rem; margin-bottom: .9rem; }
    .amount { font-size: 1.95rem; font-weight: 800; color: var(--primary); margin-bottom: 1rem; }
    .btn { display: block; width: 100%; text-align: center; font-weight: 800; padding: .85rem 1rem; border-radius: 14px; background: linear-gradient(120deg, #6c54ff 0%, #0096d9 52%, #00c9c8); color: #fff; border: none; cursor: pointer; font-size: .92rem; text-decoration: none; }
    .fine { font-size: .66rem; color: var(--muted); text-align: center; margin-top: .7rem; line-height: 1.48; }
  </style>
</head>
<body>
  <div class="wrap">
    <article class="card">
      <div class="card-accent"></div>
      <div class="card-body">
        <p class="eyebrow">Secure checkout</p>
        <h1 class="brand">${escapeHtml(SITE_NAME)}</h1>
        <p class="label">Your order</p>
        <p class="real">${escapeHtml(realTitle)}</p>
        ${
          showPrivacyBlurb
            ? `<div class="privacy-callout"><strong style="display:block;font-size:.65rem;color:var(--accent);margin-bottom:.35rem">Privacy</strong>Payment processor receives: <span style="font-family:ui-monospace,monospace">${escapeHtml(maskedLabel)}</span></div>`
            : `<div class="privacy-callout"><strong style="display:block;font-size:.65rem;color:var(--accent);margin-bottom:.35rem">Privacy</strong>A generic description is sent to the payment processor.</div>`
        }
        <p class="amount">$${escapeHtml(amountStr)} <small style="font-size:.76rem;color:var(--muted)">${escapeHtml(currencyCode)}</small></p>
        <a class="btn" id="btn-payjsr" href="${escapeHtml(checkoutUrl)}">Continue to secure payment</a>
        <p class="fine">Card and PayPal accepted. After payment you return to the store.</p>
      </div>
    </article>
  </div>
  <script>
    (function () {
      var url = '${safeCheckoutUrl}';
      document.getElementById('btn-payjsr').addEventListener('click', function (e) { e.preventDefault(); window.location.href = url; });
      window.addEventListener('load', function () { setTimeout(function () { window.location.href = url; }, 350); });
    })();
  </script>
</body>
</html>`);
}

async function handlePayJSRCheckout(req, res) {
  const { amount, currency = 'USD', success_url, cancel_url, product_name, display_title } = req.query;
  if (!amount || !success_url) {
    return res.status(400).send('Missing required parameters (amount, success_url)');
  }

  const payjsrSecretKey = await getPayjsrSecretKey();
  if (!payjsrSecretKey) {
    return res.status(500).send('PayJSR not configured. Set PAYJSR_SECRET_KEY or stripe_secret_key in Supabase site_config.');
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
  const forwardSuccess = String(success_url);
  const cancelReturn = cancel_url
    ? String(cancel_url)
    : getEbooksReturnUrl(origin, 'cancel', maskedForProcessor, amountNumber.toFixed(2));
  const successIntermediate = `${origin}/api/payjsr-success?forward=${encodeURIComponent(forwardSuccess)}`;

  const payload = {
    amount: amountCents,
    currency: String(currency || 'USD').toUpperCase(),
    description: maskedForProcessor,
    billing_type: 'one_time',
    mode: 'redirect',
    success_url: successIntermediate,
    cancel_url: cancelReturn,
    metadata: {
      product_name: maskedForProcessor,
      display_title: realForBuyer || maskedForProcessor,
    },
  };

  let createRes = await fetch('https://api.payjsr.com/v1/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': payjsrSecretKey },
    body: JSON.stringify(payload),
  });
  if (!createRes.ok && createRes.status === 404) {
    createRes = await fetch('https://api.payjsr.com/v1/api-create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': payjsrSecretKey },
      body: JSON.stringify(payload),
    });
  }

  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    return res
      .status(createRes.status)
      .send(`Checkout failed (PayJSR): ${createData?.error || createData?.message || 'unknown error'}`);
  }

  const normalized = createData?.data || createData || {};
  const checkoutUrl =
    normalized?.checkout_url ||
    normalized?.payment_link ||
    normalized?.payment_url ||
    normalized?.url;
  if (!checkoutUrl) {
    return res.status(502).send('Checkout failed (PayJSR): missing checkout/payment link');
  }

  const showPrivacyBlurb =
    Boolean(realForBuyer) && realForBuyer !== maskedForProcessor;

  return sendPayjsrCheckoutPage(res, {
    checkoutUrl: String(checkoutUrl),
    realTitle: realForBuyer || maskedForProcessor,
    maskedLabel: maskedForProcessor,
    amountStr: amountNumber.toFixed(2),
    currencyCode: String(currency || 'USD').toUpperCase(),
    showPrivacyBlurb,
  });
}

function redirectWhopToTelegram(req, res) {
  const tg = String(TELEGRAM_USERNAME || req.query.telegram_username || '').replace(/^@/, '').trim();
  const title = String(req.query.display_title || req.query.product_name || 'purchase').trim();
  const amount = String(req.query.amount || '').trim();
  const msg = `Hi! I want to pay for: ${title}${amount ? ` ($${amount})` : ''}. Please send payment options.`;
  const url = tg
    ? `https://t.me/${tg}?text=${encodeURIComponent(msg)}`
    : `https://t.me/share/url?url=&text=${encodeURIComponent(msg)}`;
  return res.redirect(302, url);
}

function handlePayPalCheckout(req, res) {
  const { amount, currency = 'USD', success_url, cancel_url, product_name, display_title } = req.query;
  if (!amount || !success_url || !cancel_url) {
    return res.status(400).send('Missing required parameters');
  }

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
        ${orderBlock}
        <p class="amount"><span class="cur-symbol">$</span>${amountStr}<span class="cur-code">${escapeHtml(currencyCode)}</span></p>
        <div class="pp-wrap">
          <p class="pp-label">Pay with PayPal or card</p>
          <div id="paypal-button-container"></div>
        </div>
        <p class="fine" id="loading">Loading secure payment…</p>
        <p class="fine">After paying you will return to the store. Cancel opens a neutral page.</p>
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
// - method=payjsr -> PayJSR masked checkout (default)
// - method=whop -> disabled; redirects to Telegram
// - method=paypal -> masked PayPal flow
app.get('/api/paypal-checkout', async (req, res) => {
  try {
    const method = String(req.query.method || 'payjsr').toLowerCase();
    if (method === 'whop') return redirectWhopToTelegram(req, res);
    if (method === 'payjsr') return await handlePayJSRCheckout(req, res);
    return handlePayPalCheckout(req, res);
  } catch (err) {
    console.error('Checkout dispatch error:', err);
    return res.status(500).send('Checkout failed');
  }
});

// Explicit PayJSR endpoint (optional)
app.get('/api/payjsr-checkout', async (req, res) => {
  try {
    return await handlePayJSRCheckout(req, res);
  } catch (err) {
    console.error('PayJSR checkout error:', err);
    return res.status(500).send('Checkout failed');
  }
});

// Intermediary success page to forward to the original `success_url`
app.get('/api/payjsr-success', (req, res) => {
  try {
    const forward = String(req.query.forward || '');
    const paymentId = String(
      req.query.payment_id || req.query.order_id || req.query.pid || req.query.paymentId || ''
    );
    if (!forward) {
      return res.status(400).send('Missing forward URL');
    }

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
  } catch (err) {
    console.error('PayJSR success forward error:', err);
    res.status(500).send('Forward failed');
  }
});

app.get('/api/health', async (req, res) => {
  const key = await getPayjsrSecretKey();
  res.json({
    status: 'OK',
    site: SITE_NAME,
    payjsr_configured: Boolean(key),
    supabase_configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} running on port ${PORT}`);
});
