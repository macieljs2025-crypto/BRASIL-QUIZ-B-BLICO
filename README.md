# BRASIL QUIZ BÍBLICO — jogo + painel administrativo

O `index.html` continua sendo o jogo. O `admin.html` é um painel separado e não existe botão de administrador na interface do jogador.

## Painel
Abra `/admin` no endereço do Render. Informe o único `ADMIN_EMAIL` configurado no servidor. O código de 6 dígitos é enviado por SMTP e expira em 10 minutos.

## Firebase
O painel usa Firebase Admin no servidor. Configure `FIREBASE_DATABASE_URL` e `FIREBASE_SERVICE_ACCOUNT_JSON` no Render. Usuários são armazenados em `users/{id}`. O jogo sincroniza conta/status com o servidor quando salva.

## E-mail
Configure SMTP. Para Gmail, use uma App Password quando aplicável; não coloque a senha normal no HTML.

## Render
Build: `npm install`\nStart: `npm start`

## Mercado Pago
As variáveis existentes do Mercado Pago continuam sendo usadas pelo `server.js`.
