const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/,"");
const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();
const MP_WEBHOOK_SECRET = String(process.env.MP_WEBHOOK_SECRET || "").trim();

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: true, methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "1mb" }));

const rooms = new Map();
const champRooms = new Map();
let questions = [];

try {
  questions = JSON.parse(fs.readFileSync(path.join(ROOT, "questions.json"), "utf8"));
  if (!Array.isArray(questions)) questions = [];
} catch (e) {
  questions = [];
}

const STORE_FILE = path.join(ROOT, "data", "mercadopago-orders.json");
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });

function loadOrders() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
let orders = loadOrders();

function saveOrders() {
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

const COIN_PACKAGES = Object.freeze({
  coins150:  { id: "coins150",  coins: 150,   price: 2.00,  title: "Pacote Inicial" },
  coins400:  { id: "coins400",  coins: 400,   price: 5.00,  title: "Pacote Popular" },
  coins2000: { id: "coins2000", coins: 2000,  price: 25.00, title: "Pacote Grande" },
  coins5000: { id: "coins5000", coins: 5000,  price: 50.00, title: "Pacote Premium" },
  coins10000:{ id: "coins10000",coins: 10000, price: 90.00, title: "Pacote Especial" }
});

let mpClient = null;
let preferenceClient = null;
let paymentClient = null;

if (MP_ACCESS_TOKEN) {
  mpClient = new MercadoPagoConfig({
    accessToken: MP_ACCESS_TOKEN,
    options: { timeout: 10000 }
  });
  preferenceClient = new Preference(mpClient);
  paymentClient = new Payment(mpClient);
}

function code() {
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}
function makeCode(map) {
  let c;
  do c = code(); while (map.has(c));
  return c;
}
function pickQuestions(n) {
  const a = [...questions];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, score: p.score || 0, ready: !!p.ready
  }));
}
function broadcast(room, msg) {
  const raw = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}
function send(p, msg) {
  if (p?.ws?.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
}
function json(res, status, obj) {
  return res.status(status).json(obj);
}
function safeText(v, max) {
  return String(v ?? "").trim().slice(0, max);
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function hashDevice(deviceId) {
  return crypto.createHash("sha256").update(String(deviceId)).digest("hex").slice(0, 32);
}
function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
function requireHttpsBase(req) {
  const b = baseUrl(req);
  if (!/^https:\/\//i.test(b) && process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_BASE_URL precisa usar HTTPS em produção.");
  }
  return b;
}
function getPaymentIdFromRequest(req) {
  return safeText(req.body?.data?.id || req.query["data.id"] || req.body?.id, 80);
}

function verifyWebhookSignature(req) {
  if (!MP_WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === "production") return false;
    return true;
  }

  const signature = String(req.headers["x-signature"] || "");
  const requestId = String(req.headers["x-request-id"] || "");
  const dataId = safeText(req.query["data.id"] || req.body?.data?.id, 80);
  const parts = {};
  for (const item of signature.split(",")) {
    const [k, ...rest] = item.split("=");
    if (k && rest.length) parts[k.trim()] = rest.join("=").trim();
  }
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const manifestParts = [];
  if (dataId) manifestParts.push(`id:${dataId};`);
  if (requestId) manifestParts.push(`request-id:${requestId};`);
  manifestParts.push(`ts:${ts};`);
  const manifest = manifestParts.join("");

  const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(manifest).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}

function findOrderByIdentifier(identifier) {
  const id = String(identifier || "");
  return Object.values(orders).find(o => o.preferenceId === id || o.paymentId === id) || null;
}

function parseExternalReference(ref) {
  const m = /^BQB:([^:]+):([^:]+):([^:]+)$/.exec(String(ref || ""));
  if (!m) return null;
  return { packageId: m[1], deviceHash: m[2], orderId: m[3] };
}

async function getPayment(paymentId) {
  if (!paymentClient) throw new Error("MP_ACCESS_TOKEN não configurado no Render.");
  return paymentClient.get({ id: String(paymentId) });
}

async function searchPaymentForOrder(order) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN não configurado.");
  const url = new URL("https://api.mercadopago.com/v1/payments/search");
  url.searchParams.set("external_reference", order.externalReference);
  url.searchParams.set("sort", "date_created");
  url.searchParams.set("criteria", "desc");
  url.searchParams.set("limit", "20");

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || "Falha ao consultar pagamentos no Mercado Pago.");
  return Array.isArray(d.results) ? d.results[0] : null;
}

function validateApprovedPayment(payment, order) {
  if (!payment || payment.status !== "approved") return false;

  const parsed = parseExternalReference(payment.external_reference);
  if (!parsed) return false;
  if (parsed.orderId !== order.orderId) return false;
  if (parsed.packageId !== order.packageId) return false;
  if (parsed.deviceHash !== order.deviceHash) return false;

  const amount = Number(payment.transaction_amount);
  const pkg = COIN_PACKAGES[order.packageId];
  if (!pkg || Math.abs(amount - pkg.price) > 0.01) return false;

  if (String(payment.currency_id || "BRL").toUpperCase() !== "BRL") return false;
  return true;
}

async function reconcilePayment(order, paymentId) {
  let payment = null;

  if (paymentId) {
    payment = await getPayment(paymentId);
  } else {
    payment = await searchPaymentForOrder(order);
  }

  if (!payment) {
    return { approved: false, status: "pending", coins: 0, paymentId: null };
  }

  if (String(payment.external_reference || "") !== order.externalReference) {
    return { approved: false, status: payment.status || "unknown", coins: 0, paymentId: String(payment.id) };
  }

  order.paymentId = String(payment.id);
  order.status = String(payment.status || "unknown");

  if (validateApprovedPayment(payment, order)) {
    order.approved = true;
    order.coins = COIN_PACKAGES[order.packageId].coins;
    order.approvedAt = order.approvedAt || new Date().toISOString();
    saveOrders();
    return {
      approved: true,
      status: "approved",
      coins: order.coins,
      paymentId: order.paymentId,
      alreadyProcessed: !!order.processedAt
    };
  }

  saveOrders();
  return {
    approved: false,
    status: order.status,
    coins: 0,
    paymentId: order.paymentId
  };
}

async function processWebhook(paymentId) {
  if (!paymentId) return;
  try {
    const payment = await getPayment(paymentId);
    const externalReference = String(payment.external_reference || "");
    const parsed = parseExternalReference(externalReference);
    if (!parsed) return;

    const order = orders[parsed.orderId];
    if (!order) return;

    if (String(order.deviceHash) !== String(parsed.deviceHash) ||
        String(order.packageId) !== String(parsed.packageId)) return;

    order.paymentId = String(payment.id);
    order.status = String(payment.status || "unknown");

    if (validateApprovedPayment(payment, order)) {
      order.approved = true;
      order.coins = COIN_PACKAGES[order.packageId].coins;
      order.approvedAt = order.approvedAt || new Date().toISOString();
    }
    saveOrders();
  } catch (e) {
    console.error("Webhook processing error:", e);
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "BRASIL QUIZ BIBLICO",
    questions: questions.length,
    mercadopago: !!MP_ACCESS_TOKEN
  });
});

app.get("/questions.json", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(questions);
});

app.post("/api/rooms/create", (req, res) => {
  try {
    const c = makeCode(rooms);
    const room = {
      code: c,
      name: safeText(req.body?.name || "Sala Bíblica", 50),
      maxPlayers: 2,
      players: new Map(),
      questionIndex: 0,
      questions: pickQuestions(5),
      answers: new Map(),
      started: false
    };
    rooms.set(c, room);
    res.json({ code: c });
  } catch {
    json(res, 400, { error: "Dados inválidos." });
  }
});

app.post("/api/championship/rooms/create", (req, res) => {
  try {
    const c = makeCode(champRooms);
    const mode = ["individual", "team1", "team2", "team4"].includes(req.body?.mode)
      ? req.body.mode : "individual";
    const maxPlayers = mode === "individual" ? 10 : mode === "team4" ? 8 : mode === "team2" ? 4 : 2;
    champRooms.set(c, {
      code: c, mode, maxPlayers, players: new Map(),
      questions: pickQuestions(30), index: 0, ready: false,
      answers: new Map(), scores: new Map()
    });
    res.json({ code: c });
  } catch {
    json(res, 400, { error: "Dados inválidos." });
  }
});

app.post("/api/store/create", async (req, res) => {
  try {
    if (!preferenceClient) {
      return json(res, 503, { error: "Mercado Pago não está configurado no servidor. Adicione MP_ACCESS_TOKEN no Render." });
    }

    const packageId = safeText(req.body?.packageId, 30);
    const pkg = COIN_PACKAGES[packageId];
    const deviceId = safeText(req.body?.deviceId, 160);
    const email = safeText(req.body?.email, 180).toLowerCase();

    if (!pkg) return json(res, 400, { error: "Pacote de moedas inválido." });
    if (deviceId.length < 8) return json(res, 400, { error: "Identificador do dispositivo inválido." });
    if (!validEmail(email)) return json(res, 400, { error: "E-mail inválido." });

    const orderId = crypto.randomUUID();
    const deviceHash = hashDevice(deviceId);
    const externalReference = `BQB:${packageId}:${deviceHash}:${orderId}`;
    const publicBase = requireHttpsBase(req);

    const preference = await preferenceClient.create({
      body: {
        external_reference: externalReference,
        items: [{
          id: packageId,
          title: `${pkg.title} — ${pkg.coins} moedas`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: pkg.price
        }],
        payer: { email },
        notification_url: `${publicBase}/api/mercadopago/webhook`,
        back_urls: {
          success: `${publicBase}/?mp=success`,
          pending: `${publicBase}/?mp=pending`,
          failure: `${publicBase}/?mp=failure`
        },
        auto_return: "approved",
        metadata: {
          order_id: orderId,
          package_id: packageId,
          device_hash: deviceHash
        }
      }
    });

    orders[orderId] = {
      orderId,
      packageId,
      coins: pkg.coins,
      amount: pkg.price,
      email,
      deviceHash,
      externalReference,
      preferenceId: String(preference.id),
      paymentId: null,
      status: "created",
      approved: false,
      createdAt: new Date().toISOString()
    };
    saveOrders();

    return res.json({
      ok: true,
      orderId,
      preferenceId: String(preference.id),
      initPoint: preference.init_point,
      sandboxInitPoint: preference.sandbox_init_point || null
    });
  } catch (e) {
    console.error("Mercado Pago create:", e);
    return json(res, 500, { error: e?.message || "Erro ao criar pagamento no Mercado Pago." });
  }
});

app.get("/api/store/status/:identifier", async (req, res) => {
  try {
    const identifier = safeText(req.params.identifier, 120);
    const deviceHash = hashDevice(safeText(req.query.deviceId, 160));
    const order = findOrderByIdentifier(identifier);

    if (!order) return json(res, 404, { error: "Compra não encontrada. Inicie uma nova compra." });
    if (order.deviceHash !== deviceHash) return json(res, 403, { error: "Compra não pertence a este dispositivo." });

    // If we already know the payment, refresh it directly. Otherwise search by preference/external_reference.
    const result = await reconcilePayment(order, order.paymentId || null);

    return res.json({
      ok: true,
      approved: !!result.approved,
      status: result.status,
      coins: result.approved ? order.coins : 0,
      paymentId: result.paymentId || order.paymentId || null,
      preferenceId: order.preferenceId
    });
  } catch (e) {
    console.error("Mercado Pago status:", e);
    return json(res, 500, { error: e?.message || "Erro ao consultar o pagamento." });
  }
});

app.post("/api/mercadopago/webhook", async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    return res.sendStatus(401);
  }

  const paymentId = getPaymentIdFromRequest(req);
  res.sendStatus(200);

  // Process after acknowledging the notification.
  if (paymentId) setImmediate(() => processWebhook(paymentId));
});

// Compatibility endpoint for old clients.
app.post("/api/pix/create", (req, res) => {
  res.status(410).json({ error: "Use Mercado Pago para compras de moedas." });
});
app.get("/api/pix/status/:id", (req, res) => {
  res.status(410).json({ error: "Use /api/store/status/:id." });
});

app.use(express.static(ROOT, {
  index: "index.html",
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    }
  }
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const c = (u.searchParams.get("code") || "").toUpperCase();
  const pid = u.searchParams.get("playerId") || crypto.randomUUID();
  const name = safeText(u.searchParams.get("name") || "Jogador", 30);
  const room = rooms.get(c);

  if (!room) {
    ws.send(JSON.stringify({ type: "room_error", message: "Sala não encontrada ou expirada." }));
    return ws.close();
  }
  if (room.players.size >= room.maxPlayers && !room.players.has(pid)) {
    ws.send(JSON.stringify({ type: "room_error", message: "A sala já está cheia." }));
    return ws.close();
  }

  let p = room.players.get(pid);
  if (!p) {
    p = { id: pid, name, ws, score: 0, ready: false };
    room.players.set(pid, p);
  } else {
    p.ws = ws;
    p.name = name;
  }

  ws.room = room;
  ws.player = p;
  broadcast(room, { type: "room_state", code: room.code, name: room.name, players: publicPlayers(room) });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "rtc_signal") {
      for (const other of room.players.values()) {
        if (other.id !== p.id) send(other, { type: "rtc_signal", data: m.data });
      }
      return;
    }

    if (m.type === "ready") {
      p.ready = true;
      broadcast(room, { type: "room_state", code: room.code, name: room.name, players: publicPlayers(room) });
      if (room.players.size === 2 && [...room.players.values()].every(x => x.ready)) {
        room.started = true;
        room.questionIndex = 0;
        room.answers.clear();
        room.questions = pickQuestions(5);
        for (const x of room.players.values()) { x.score = 0; x.ready = false; }
        broadcast(room, { type: "battle_start", questions: room.questions });
        broadcast(room, { type: "room_state", code: room.code, name: room.name, players: publicPlayers(room) });
      }
      return;
    }

    if (m.type === "answer" && room.started) {
      if (room.answers.has(p.id)) return;
      const idx = Number(m.index);
      const q = room.questions[room.questionIndex];
      if (!q) return;
      const correct = idx === Number(q[2]);
      if (correct) p.score += 10;
      room.answers.set(p.id, { selectedIndex: idx, correct });

      const scores = {};
      for (const x of room.players.values()) scores[x.id] = x.score;
      send(p, {
        type: "answer_result",
        correct,
        correctIndex: Number(q[2]),
        selectedIndex: idx,
        scores,
        allAnswered: room.answers.size === room.players.size
      });

      if (room.answers.size === room.players.size) {
        setTimeout(() => {
          room.questionIndex++;
          if (room.questionIndex >= room.questions.length) {
            const vals = [...room.players.values()];
            let winner = null;
            if (vals.length === 2) {
              winner = vals[0].score === vals[1].score ? null :
                (vals[0].score > vals[1].score ? vals[0].id : vals[1].id);
            }
            const finalScores = {};
            for (const x of vals) finalScores[x.id] = x.score;
            broadcast(room, { type: "battle_end", winner, scores: finalScores });
            room.started = false;
            room.answers.clear();
            broadcast(room, { type: "room_state", code: room.code, name: room.name, players: publicPlayers(room) });
          } else {
            room.answers.clear();
            broadcast(room, { type: "next_question", index: room.questionIndex });
          }
        }, 700);
      }
    }
  });

  ws.on("close", () => {
    if (room.players.get(p.id)?.ws === ws) {
      p.ws = null;
      p.ready = false;
      broadcast(room, { type: "room_state", code: room.code, name: room.name, players: publicPlayers(room) });
    }
  });
});

const champWss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== "/champ-ws") return;
  champWss.handleUpgrade(req, socket, head, ws => champWss.emit("connection", ws, req));
});

champWss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://localhost");
  const c = (u.searchParams.get("code") || "").toUpperCase();
  const pid = u.searchParams.get("playerId") || crypto.randomUUID();
  const name = safeText(u.searchParams.get("name") || "Jogador", 30);
  const room = champRooms.get(c);

  if (!room) {
    ws.send(JSON.stringify({ type: "champ_error", message: "Sala de campeonato não encontrada." }));
    return ws.close();
  }
  if (room.players.size >= room.maxPlayers && !room.players.has(pid)) {
    ws.send(JSON.stringify({ type: "champ_error", message: "Sala cheia." }));
    return ws.close();
  }

  let p = room.players.get(pid);
  if (!p) {
    p = { id: pid, name, ws, ready: false, score: 0 };
    room.players.set(pid, p);
  } else {
    p.ws = ws;
    p.name = name;
  }

  const state = () => ({
    type: "champ_state",
    code: room.code,
    mode: room.mode,
    title: room.mode === "individual" ? "CAMPEONATO INDIVIDUAL" : "CAMPEONATO",
    maxPlayers: room.maxPlayers,
    players: [...room.players.values()].map(x => ({
      id: x.id,
      name: x.name,
      host: [...room.players.keys()][0] === x.id,
      ready: x.ready
    }))
  });
  const bc = m => {
    const raw = JSON.stringify(m);
    for (const x of room.players.values()) {
      if (x.ws?.readyState === WebSocket.OPEN) x.ws.send(raw);
    }
  };

  ws.send(JSON.stringify(state()));
  bc(state());

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "champ_ready") {
      p.ready = true;
      bc(state());
      if (room.players.size === room.maxPlayers && [...room.players.values()].every(x => x.ready)) {
        room.index = 0;
        room.questions = pickQuestions(30);
        room.answers.clear();
        for (const x of room.players.values()) { x.score = 0; x.ready = false; }
        bc({ type: "champ_start", questions: room.questions });
        bc(state());
      }
    } else if (m.type === "champ_answer" || m.type === "champ_timeout") {
      if (room.answers.has(p.id)) return;
      const q = room.questions[room.index];
      if (!q) return;
      const idx = m.type === "champ_timeout" ? -1 : Number(m.index);
      const correct = idx === Number(q[2]);
      if (correct) p.score += 10;
      room.answers.set(p.id, { idx, correct });
      send(p, { type: "champ_answer_result", correct, myScore: p.score, selectedIndex: idx });

      if (room.answers.size === room.players.size) {
        setTimeout(() => {
          room.index++;
          room.answers.clear();
          if (room.index >= room.questions.length) {
            const results = [...room.players.values()]
              .sort((a,b) => b.score-a.score)
              .map((x,i) => ({
                position: i+1,
                name: x.name,
                score: x.score,
                prize: i===0 ? 500 : i===1 ? 250 : i===2 ? 125 : 0
              }));
            bc({ type: "champ_end", results });
            room.players.forEach(x => x.ready = false);
          } else {
            bc({ type: "champ_next", index: room.index });
          }
        }, 700);
      }
    }
  });

  ws.on("close", () => {
    if (room.players.get(p.id)?.ws === ws) {
      p.ws = null;
      p.ready = false;
      bc(state());
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BRASIL QUIZ BIBLICO rodando na porta ${PORT}`);
  console.log(`Mercado Pago: ${MP_ACCESS_TOKEN ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
});
