# BRASIL QUIZ BÍBLICO — Mercado Pago

## Arquivos
- `index_MERCADO_PAGO_FINAL.html`: jogo + fluxo Checkout Pro.
- `server_MERCADO_PAGO_FINAL.js`: servidor Render, WebSocket e Mercado Pago.
- `package_MERCADO_PAGO_FINAL.json`: dependências.

## Render
Renomeie:
- `index_MERCADO_PAGO_FINAL.html` -> `index_MERCADO_PAGO_FINAL.html` (já é o nome usado pelo servidor)
- `server_MERCADO_PAGO_FINAL.js` -> `server.js`
- `package_MERCADO_PAGO_FINAL.json` -> `package.json`

Build Command:
`npm install`

Start Command:
`node server.js`

## Variáveis de ambiente do Render
Obrigatórias para pagamentos reais:
- `MP_ACCESS_TOKEN` = Access Token de produção do Mercado Pago
- `MP_WEBHOOK_SECRET` = chave secreta gerada em Webhooks > Configurar notificações no Mercado Pago

Recomendado:
- `PUBLIC_BASE_URL` = URL HTTPS do serviço Render, por exemplo `https://SEU-SERVICO.onrender.com`
- `NODE_ENV` = `production`

Webhook:
`https://SEU-SERVICO.onrender.com/api/mercadopago/webhook`

Ative o evento de pagamentos no painel do Mercado Pago.

## Importante
Nunca coloque `MP_ACCESS_TOKEN` dentro do HTML ou GitHub. Ele deve ficar somente nas Environment Variables do Render.

O arquivo `data/mercadopago-orders.json` é uma persistência local de pedidos. Em instâncias gratuitas do Render o filesystem pode ser efêmero. Para saldo/moedas realmente permanente entre reinícios, o próximo passo é usar um banco persistente (por exemplo PostgreSQL/Render Postgres) para os pedidos e saldos.
