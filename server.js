'use strict';
const express = require('express'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const BOT_TOKEN = process.env.BOT_TOKEN || '', DEV = process.env.DEV === '1', PORT = +process.env.PORT || 3000,
  FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

/* ---------- Конфиг (держи в соответствии с клиентом) ---------- */
const SYMBOLS = [
  { id: 'charge', mult: 2, pair: 0.5, weight: 22 }, { id: 'battery', mult: 3, pair: 1, weight: 21 },
  { id: 'glitch', mult: 5, pair: 1, weight: 20 }, { id: 'moon', mult: 10, pair: 1, weight: 19 },
  { id: 'jackpot', mult: 25, pair: 1, weight: 18 }];
const BETS = [10, 50, 100, 250];
const START_COINS = 100, WELCOME = 200, ENERGY_STEP = 50, AUTH_MAX_AGE = 86400;
const tapCost = l => Math.round(50 * Math.pow(1.8, l)), energyCost = l => Math.round(100 * Math.pow(1.7, l));
const BOOSTS = { x2: { cost: 500, dur: 300 }, turbo: { cost: 300, dur: 300 }, auto: { cost: 800, dur: 300 }, full: { cost: 100, dur: 0 } };
const GAME_RATE = { snake: 8, tetris: 20 };
const BOT_USERNAME = process.env.BOT_USERNAME || '', APP_NAME = process.env.APP_NAME || '';
const STARS = process.env.STARS === '1', WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const REF_BONUS = 300, REF_NEW = 100, REF_MAX = 50; // рефералы: тому, кто пригласил / новичку / лимит приглашений
// Товары за Telegram Stars: только бусты по времени, монеты за Stars не продаются
const STAR_ITEMS = {
  x2h: { title: 'Х2 коины, 1 час', desc: 'Тап и игры x2', stars: 50, boost: 'x2', dur: 3600 },
  auto1h: { title: 'Автотап, 1 час', desc: 'Тап каждую секунду', stars: 75, boost: 'auto', dur: 3600 } };
const refLink = p => BOT_USERNAME ? 'https://t.me/' + BOT_USERNAME + (APP_NAME ? '/' + APP_NAME : '') + '?startapp=ref_' + p.id.slice(2) : '';
const starList = () => STARS ? Object.entries(STAR_ITEMS).map(([id, i]) => ({ id, title: i.title, desc: i.desc, price: i.stars })) : [];
const tg = (m, b) => fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + m, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()); // макс. коинов в секунду за раунд (антиабьюз)

/* ---------- Хранилище (JSON-файл; для роста замени на SQLite/Postgres) ---------- */
let db = { players: {} };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => { timer = null;
    fs.writeFile(FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(FILE + '.tmp', FILE, () => {}); }); }, 1000);
}
process.on('SIGTERM', () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });

/* ---------- Проверка Telegram initData ---------- */
function verify(raw) {
  if (!BOT_TOKEN || !raw) return null;
  const p = new URLSearchParams(raw), hash = p.get('hash'); if (!hash) return null; p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > AUTH_MAX_AGE) return null;
  try { return { user: JSON.parse(p.get('user')), start: p.get('start_param') || '' }; } catch (e) { return null; }
}

/* ---------- Игрок ---------- */
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 1000;
function settle(p) { // энергия и автотап считаются лениво по времени
  const now = Date.now(), t0 = p.ts, b = p.boosts, power = 1 + p.tapLvl;
  p.energy = Math.min(p.maxEnergy, p.energy + (now - t0) / 1000 + ov(t0, now, t0, b.turbo) * 4);
  const au = ov(t0, now, t0, b.auto);
  if (au > 0) { const g = (au + ov(t0, now, t0, Math.min(b.auto, b.x2))) * power; p.coins += g; p.total += g; }
  p.ts = now;
}
function getPlayer(req) {
  const raw = req.get('X-Init-Data') || ''; let u = null;
  if (DEV && raw.startsWith('dev:')) { const [, id, name, ref] = raw.split(':'); req.start = ref || ''; u = { id: (id || 'x').replace(/\W/g, '').slice(0, 20), first_name: (name || 'dev').slice(0, 16) }; }
  else { const v = verify(raw); u = v && v.user; req.start = (v && v.start) || ''; }
  if (!u) throw Object.assign(new Error('auth'), { status: 401 });
  const pid = 'tg' + u.id;
  const p = db.players[pid] || (db.players[pid] = {
    id: pid, name: [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 16) || u.username || 'Player', registered: false,
    coins: START_COINS, energy: 100, maxEnergy: 100, tapLvl: 0, energyLvl: 0, total: 0,
    boosts: { x2: 0, turbo: 0, auto: 0 }, best: { snake: 0, tetris: 0 }, ts: Date.now(), tapTs: 0 });
  settle(p); return p;
}
const view = p => { const now = Date.now(), L = k => Math.max(0, p.boosts[k] - now);
  return { id: p.id, registered: p.registered, name: p.name, coins: Math.floor(p.coins), energy: Math.floor(p.energy), maxEnergy: p.maxEnergy,
    tapPower: 1 + p.tapLvl, tapLvl: p.tapLvl, energyLvl: p.energyLvl, total: Math.floor(p.total), best: p.best,
    boosts: { x2: L('x2'), turbo: L('turbo'), auto: L('auto') }, refs: p.refs || 0, refLink: refLink(p), stars: starList() }; };

/* ---------- API ---------- */
const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '10kb' }));
const route = fn => (req, res) => {
  try { const p = getPlayer(req), out = fn(req.body || {}, p, req); if (out && out.error) return res.status(400).json(out); save(); res.json(out); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
const x2 = p => p.boosts.x2 > Date.now() ? 2 : 1;

app.get('/api/me', route((b, p) => view(p)));

app.post('/api/register', route((b, p, req) => {
  const n = String(b.name || '').replace(/[<>]/g, '').trim().slice(0, 16); if (n.length < 2) return { error: 'name' };
  if (!p.registered) {
    p.registered = true; p.coins += WELCOME;
    const m = /^ref_(\w+)$/.exec(req.start || ''), r = m && db.players['tg' + m[1]];
    if (r && r.id !== p.id && r.registered && !p.refBy && (r.refs || 0) < REF_MAX) { p.refBy = r.id; p.coins += REF_NEW; r.coins += REF_BONUS; r.refs = (r.refs || 0) + 1; } }
  p.name = n; return view(p); }));

app.post('/api/tap', route((b, p) => {
  if (!p.registered) return { error: 'reg' };
  const now = Date.now(), el = (now - (p.tapTs || now)) / 1000;
  const n = Math.max(0, Math.min(Math.floor(+b.n) || 0, 100, Math.floor(p.energy), Math.floor(30 + el * 15)));
  const g = n * (1 + p.tapLvl) * x2(p); p.energy -= n; p.coins += g; p.total += g; p.tapTs = now; return view(p); }));

app.post('/api/upgrade', route((b, p) => {
  if (b.type === 'tap') { const c = tapCost(p.tapLvl); if (p.coins < c) return { error: 'coins' }; p.coins -= c; p.tapLvl++; }
  else if (b.type === 'energy') { const c = energyCost(p.energyLvl); if (p.coins < c) return { error: 'coins' };
    p.coins -= c; p.energyLvl++; p.maxEnergy += ENERGY_STEP; p.energy += ENERGY_STEP; }
  else return { error: 'type' };
  return view(p); }));

app.post('/api/boost', route((b, p) => {
  const d = BOOSTS[b.id]; if (!d) return { error: 'id' }; if (p.coins < d.cost) return { error: 'coins' };
  if (d.dur) p.boosts[b.id] = Math.max(Date.now(), p.boosts[b.id]) + d.dur * 1000;
  else { if (p.energy >= p.maxEnergy) return { error: 'full' }; p.energy = p.maxEnergy; }
  p.coins -= d.cost; return view(p); }));

const sessions = new Map();
app.post('/api/game/start', route((b, p) => { if (GAME_RATE[b.game]) sessions.set(p.id, { game: b.game, t: Date.now() }); return view(p); }));
app.post('/api/game/end', route((b, p) => {
  const s = sessions.get(p.id); sessions.delete(p.id);
  if (s && s.game === b.game) {
    const dur = (Date.now() - s.t) / 1000, sc = Math.floor(Math.min(Math.max(+b.score || 0, 0), dur * GAME_RATE[s.game] + 10));
    if (sc > 0) { const g = sc * x2(p); p.coins += g; p.total += g; p.best[s.game] = Math.max(p.best[s.game] || 0, sc); } }
  return view(p); }));

app.post('/api/spin', route((b, p) => {
  const bet = Math.floor(+b.bet), have = Math.floor(p.coins);
  if (!(bet >= 1) || bet > have || !(BETS.includes(bet) || bet === have)) return { error: 'bet' };
  p.coins -= bet;
  const tw = SYMBOLS.reduce((a, s) => a + s.weight, 0);
  const pick = () => { let r = crypto.randomInt(tw); for (const s of SYMBOLS) if ((r -= s.weight) < 0) return s; return SYMBOLS[0]; };
  const r = [pick(), pick(), pick()]; let mult = 0;
  if (r[0] === r[1] && r[1] === r[2]) mult = r[0].mult; else if (r[0] === r[1]) mult = r[0].pair; else if (r[1] === r[2]) mult = r[1].pair;
  const win = Math.floor(bet * mult); p.coins += win;
  return { symbols: r.map(s => s.id), mult, win, state: view(p) }; }));

app.get('/api/top', route((b, p) => {
  const all = Object.values(db.players).filter(x => x.registered).sort((a, c) => c.total - a.total);
  return { rows: all.slice(0, 20).map(x => ({ id: x.id, name: x.name, score: Math.floor(x.total) })), rank: all.findIndex(x => x.id === p.id) + 1, me: p.id }; }));

/* ---------- Telegram Stars ---------- */
app.post('/api/stars/invoice', async (req, res) => {
  try {
    const p = getPlayer(req), it = STARS && STAR_ITEMS[(req.body || {}).id];
    if (!it) return res.status(400).json({ error: 'item' });
    const r = await tg('createInvoiceLink', { title: it.title, description: it.desc, payload: p.id + ':' + req.body.id, currency: 'XTR', prices: [{ label: it.title, amount: it.stars }] });
    if (!r.ok) return res.status(502).json({ error: 'telegram' });
    res.json({ link: r.result });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

app.post('/tg/webhook', async (req, res) => {
  if (!WEBHOOK_SECRET || req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200); const u = req.body || {};
  try {
    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query, [pid, id] = String(q.invoice_payload).split(':'), it = STAR_ITEMS[id];
      const ok = !!(STARS && db.players[pid] && it && q.currency === 'XTR' && q.total_amount === it.stars);
      await tg('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok, error_message: ok ? undefined : 'Товар недоступен' }); }
    const sp = u.message && u.message.successful_payment;
    if (sp) {
      const [pid, id] = String(sp.invoice_payload).split(':'), p = db.players[pid], it = STAR_ITEMS[id];
      db.charges = db.charges || {};
      if (p && it && sp.total_amount === it.stars && !db.charges[sp.telegram_payment_charge_id]) {
        db.charges[sp.telegram_payment_charge_id] = { pid, id, t: Date.now() };
        p.boosts[it.boost] = Math.max(Date.now(), p.boosts[it.boost]) + it.dur * 1000; save(); } }
    if (u.message && u.message.text === '/paysupport')
      await tg('sendMessage', { chat_id: u.message.chat.id, text: 'Вопросы по оплате: ' + (process.env.SUPPORT_CONTACT || 'напишите администратору') });
  } catch (e) { console.error(e); } });

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log('Шкед casino 101km: http://localhost:' + PORT + (DEV ? '  (DEV: /?dev=имя)' : '')));
