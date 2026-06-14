# Ebooks Checkout Site

Site de ebooks para hospedagem no Render. Funciona como **front/máscara** do checkout (**ZuckPay** + **Whop** + PayPal + **Paddle Billing**) — quando o provedor verifica a origem, vê este domínio de ebooks.

## Deploy no Render

1. Crie conta em [render.com](https://render.com)
2. **New** → **Web Service**
3. Conecte o repositório (pode ser um subdiretório ou repo separado com este código)
4. Configuração:
   - **Root Directory**: `ebooks-site` (se estiver dentro do repo principal)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free

5. **Environment Variables** no Render:
   - `SITE_NAME` — Nome do site (ex: "Readify Books", "BookVault")
   - `WHOP_API_KEY` — Company API key do Whop ([docs](https://docs.whop.com/developer/api/getting-started))
   - `WHOP_COMPANY_ID` — ID da company (`biz_...`) no Whop
   - `ZUCKPAY_CLIENT_ID` / `ZUCKPAY_CLIENT_SECRET` — ZuckPay API (`method=zuckpay`, cartão internacional USD)
   - `PAYPAL_CLIENT_ID` — Checkout PayPal direto (`method=paypal`)
   - `PADDLE_API_KEY` — API key do Paddle Billing (`pdl_live_apikey_...` ou `pdl_sdbx_apikey_...`)
   - `PADDLE_CLIENT_TOKEN` — Client-side token do Paddle (para `Paddle.js` na página intermediária)
   - `TELEGRAM_USERNAME` — Opcional, usado na landing
   - Opcional: `PADDLE_ENV=sandbox` se precisar forçar sandbox (normalmente inferido pelo prefixo da API key)

6. Após o deploy, copie a URL (ex: `https://ebooks-checkout.onrender.com`)

## Configurar no site de vídeos (Railway / env)

Defina a URL deste site como origem do checkout mascarado, por exemplo:

- `EBOOKS_SITE_URL` ou `VITE_CHECKOUT_URL` = `https://seu-ebooks-site.onrender.com` (sem barra no final)

O fluxo continua: o cliente sai do catálogo de vídeos e abre o checkout **neste** domínio (ebooks), com `method=zuckpay` (ativo no storefront), `method=whop`, `method=paypal` ou `method=paddle`.

## Endpoints

- `GET /` — Landing page com ebooks fictícios (e redireciona queries de checkout para `/api/paypal-checkout`)
- `GET /terms-of-service.html` — Termos (Alpha Agency; URL público injetado no deploy)
- `GET /privacy-policy.html` — Política de privacidade
- `GET /refund-policy.html` — Política de reembolso
- `GET /api/paypal-checkout?...&method=zuckpay|whop|paypal|paddle` — ZuckPay (cartão USD mascarado), Whop (API + redirect whop.com), PayPal in-page ou Paddle (transação via API + overlay Paddle.js)
- `GET /api/zuckpay-checkout` — Atalho para o handler ZuckPay
- `POST /api/zuckpay-charge` — Cobrança cartão internacional (Stripe via ZuckPay)
- `GET /api/zuckpay-success` — Retorno 3DS / redireciona para o `success_url` do vídeo
- `POST /api/zuckpay-webhook` — Webhook de notificação ZuckPay (`urlnoty`)
- `GET /api/whop-checkout` — Atalho para o handler Whop
- `GET /api/whop-success` — Redireciona para o `success_url` do vídeo após pagamento Whop
- `GET /api/paddle-checkout` — Atalho para o mesmo handler do Paddle
- `GET /api/payjsr-checkout` — Legado: mesmo que Paddle (substitui PayJSR)
- `GET /api/paddle-success` / `GET /api/payjsr-success` — Redireciona para o `success_url` do vídeo com `order_id` quando existir
- `GET /api/health` — Health check

Documentação Paddle: [developer.paddle.com](https://developer.paddle.com/)
