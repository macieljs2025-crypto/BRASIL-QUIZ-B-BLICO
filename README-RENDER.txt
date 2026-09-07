# BRASIL QUIZ BÍBLICO — Render

Esta pasta já contém `index.html` + `server.js` + `package.json` + `questions.json`.

## Como publicar no Render
1. Suba todos estes arquivos para o seu repositório GitHub, mantendo-os na mesma pasta.
2. No Render, crie **New > Web Service** (não Static Site).
3. Conecte o repositório.
4. Runtime: Node.
5. Build Command: `npm install`
6. Start Command: `npm start`
7. Publique.
8. Abra o endereço `https://SEU-SERVICO.onrender.com/`.

O servidor já entrega o `index.html` na raiz, o `questions.json`, cria salas 1x1 e disponibiliza WebSocket em `/ws`. O campeonato usa `/champ-ws`.

**Pagamentos:** os endpoints de Pix/Mercado Pago estão deixados como pendentes para não inventar credenciais. Depois de o jogo abrir, podemos configurar o pagamento separadamente.
