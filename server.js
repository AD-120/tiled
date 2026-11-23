// Tiled — one video split across many phone screens, kept in sync.
// Each controller opens a "room"; phones join the room by code / QR.
// Run: npm start

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const VIDEOS = path.join(PUBLIC, 'videos');
const UPLOADS = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'tiled-uploads');
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024;
const ROOM_TTL_MS = 60 * 60 * 1000; // idle rooms (no one connected) are dropped after 1h
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const LEAD_MS = 700; // every play/seek is scheduled this far ahead so all phones start together

fs.mkdirSync(UPLOADS, { recursive: true });
const now = () => Date.now();

// ---------- videos ----------
function builtinVideos() {
  try {
    return fs.readdirSync(VIDEOS).filter(f => VIDEO_EXT.test(f)).sort()
      .map(f => ({ name: f, src: `videos/${encodeURIComponent(f)}` }));
  } catch { return []; }
}

// ---------- rooms ----------
const rooms = new Map(); // code -> room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do code = Array.from(crypto.randomBytes(4), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  while (rooms.has(code));
  return code;
}

function createRoom(code = newCode()) {
  const first = builtinVideos()[0];
  const room = {
    code,
    clients: new Map(), // id -> { ws, role, tile, w, h }
    uploads: [],        // [{ name, src, file }]
    lastSeen: now(),
    state: {
      video: first ? first.src : null,
      rows: 2, cols: 1,
      gap: 0,          // bezel compensation in CSS px between tiles
      fit: 'cover',    // cover = fill the wall (crop), contain = whole video visible
      loop: true,
      audio: 'first',  // first | all | none
      orient: 'portrait', // how phones are held: portrait | landscape
      playing: false,
      pos: 0,          // media time (s) valid at `at`
      at: now(),       // server time (ms)
      duration: null,
    },
  };
  rooms.set(code, room);
  return room;
}

const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function deleteRoom(room) {
  for (const u of room.uploads) fs.rm(u.file, { force: true }, () => {});
  rooms.delete(room.code);
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size === 0 && now() - room.lastSeen > ROOM_TTL_MS) deleteRoom(room);
  }
}, 5 * 60 * 1000).unref();

const videosOf = room => [...builtinVideos(), ...room.uploads.map(({ name, src }) => ({ name, src }))];

function currentPos(s, t = now()) {
  if (!s.playing) return s.pos;
  let p = s.pos + (t - s.at) / 1000;
  if (s.duration) {
    if (s.loop) p = ((p % s.duration) + s.duration) % s.duration;
    else p = Math.min(p, s.duration);
  }
  return Math.max(0, p);
}

function screensOf(room) {
  return [...room.clients.entries()]
    .filter(([, c]) => c.role === 'screen')
    .map(([id, c]) => ({ id, tile: c.tile, w: c.w, h: c.h }));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients.values()) if (c.ws.readyState === 1) c.ws.send(data);
}
const broadcastState = room => broadcast(room, {
  t: 'state', room: room.code, state: room.state, screens: screensOf(room), videos: videosOf(room), serverNow: now(),
});

function freeTile(room) {
  const n = room.state.rows * room.state.cols;
  const taken = new Set(screensOf(room).map(s => s.tile));
  for (let i = 0; i < n; i++) if (!taken.has(i)) return i;
  return 0;
}

function setVideo(room, src) {
  const s = room.state;
  s.video = src; s.duration = null; s.playing = false; s.pos = 0; s.at = now();
}

function handleCommand(room, m) {
  const s = room.state;
  const t = now();
  switch (m.action) {
    case 'play':
      if (s.playing) return;
      s.pos = currentPos(s, t); s.at = t + LEAD_MS; s.playing = true;
      break;
    case 'pause':
      if (!s.playing) return;
      s.pos = currentPos(s, t); s.at = t; s.playing = false;
      break;
    case 'seek':
      s.pos = Math.max(0, Number(m.pos) || 0);
      s.at = s.playing ? t + LEAD_MS : t;
      break;
    case 'restart':
      s.pos = 0; s.at = t + LEAD_MS; s.playing = true;
      break;
    case 'resync': // re-anchor without moving: forces everyone to re-seek
      s.pos = currentPos(s, t + LEAD_MS); s.at = t + LEAD_MS;
      break;
    case 'layout': {
      s.rows = Math.max(1, Math.min(6, m.rows | 0));
      s.cols = Math.max(1, Math.min(6, m.cols | 0));
      // re-pack screens whose tile no longer exists
      const n = s.rows * s.cols;
      const used = new Set();
      for (const c of room.clients.values()) {
        if (c.role !== 'screen') continue;
        if (c.tile >= n || used.has(c.tile)) c.tile = -1; else used.add(c.tile);
      }
      for (const c of room.clients.values()) {
        if (c.role === 'screen' && c.tile === -1) { c.tile = freeTile(room); used.add(c.tile); }
      }
      break;
    }
    case 'settings':
      if (typeof m.gap === 'number') s.gap = Math.max(0, Math.min(200, m.gap));
      if (m.fit === 'cover' || m.fit === 'contain') s.fit = m.fit;
      if (typeof m.loop === 'boolean') { s.pos = currentPos(s, t); s.at = t; s.loop = m.loop; }
      if (['first', 'all', 'none'].includes(m.audio)) s.audio = m.audio;
      if (m.orient === 'portrait' || m.orient === 'landscape') s.orient = m.orient;
      break;
    case 'video':
      if (!videosOf(room).some(v => v.src === m.video)) return;
      setVideo(room, m.video);
      break;
    case 'identify':
      broadcast(room, { t: 'identify' });
      return;
    default:
      return;
  }
  broadcastState(room);
}

// ---------- http ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// /control without a room opens a fresh one
app.get('/control', (req, res) => {
  const code = normCode(req.query.room);
  if (!code) return res.redirect(302, `/control?room=${createRoom().code}`);
  res.sendFile(path.join(PUBLIC, 'control.html'));
});

app.use(express.static(PUBLIC, { maxAge: 0 }));
app.use('/uploads', express.static(UPLOADS, { maxAge: '1h', index: false }));

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// Public address phones should open. Locally, swap localhost for the LAN IP.
function baseUrl(req) {
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) && lanAddresses()[0]) {
    return `http://${lanAddresses()[0]}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}
const joinUrl = (req, code) => `${baseUrl(req)}/?room=${code}`;

app.get('/api/info', (req, res) => {
  const code = normCode(req.query.room);
  res.json({ joinUrl: joinUrl(req, code), base: baseUrl(req) });
});

app.get('/qr.svg', async (req, res) => {
  const code = normCode(req.query.room);
  const svg = await QRCode.toString(joinUrl(req, code), { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } });
  res.type('image/svg+xml').send(svg);
});

// Upload a video into a room: raw body streamed to disk.
app.post('/api/upload', (req, res) => {
  const room = rooms.get(normCode(req.query.room));
  if (!room) return res.status(404).json({ error: 'room not found' });
  const name = String(req.query.name || 'video.mp4').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  if (!VIDEO_EXT.test(name)) return res.status(400).json({ error: 'unsupported file type' });
  const len = Number(req.get('content-length') || 0);
  if (len > MAX_UPLOAD) return res.status(413).json({ error: 'file too large' });

  const fileName = `${room.code}-${crypto.randomBytes(4).toString('hex')}${path.extname(name).toLowerCase()}`;
  const file = path.join(UPLOADS, fileName);
  const out = fs.createWriteStream(file);
  let size = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    out.destroy(); fs.rm(file, { force: true }, () => {});
    if (!res.headersSent) res.status(code).json({ error: msg });
    req.destroy();
  };
  req.on('data', chunk => { size += chunk.length; if (size > MAX_UPLOAD) fail(413, 'file too large'); });
  req.on('aborted', () => fail(400, 'aborted'));
  out.on('error', () => fail(500, 'write failed'));
  out.on('finish', () => {
    if (failed) return;
    if (!rooms.has(room.code)) { fs.rm(file, { force: true }, () => {}); return res.status(410).end(); }
    const entry = { name, src: `uploads/${fileName}`, file };
    room.uploads.push(entry);
    setVideo(room, entry.src);
    broadcastState(room);
    res.json({ ok: true, src: entry.src });
  });
  req.pipe(out);
});

// A phone (or the desktop controller) opens a new room.
app.post('/api/room', (_, res) => {
  if (rooms.size >= 1000) return res.status(503).json({ error: 'too many rooms' });
  res.json({ code: createRoom().code });
});

app.get('/healthz', (_, res) => res.send('ok'));

const server = http.createServer(app);

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

// keep connections alive through proxies that drop idle sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 25000).unref();

let nextId = 1;
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  const id = nextId++;
  const client = { ws, role: 'pending', tile: -1, w: 0, h: 0 };
  let room = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', c: m.c, s: now() })); return; }

    if (m.t === 'hello') {
      const code = normCode(m.room);
      room = rooms.get(code);
      if (!room) {
        // a controller may recreate its room after a server restart; screens may not invent rooms
        if (m.role === 'control' && code.length >= 4) room = createRoom(code);
        else { ws.send(JSON.stringify({ t: 'noroom' })); return; }
      }
      room.clients.set(id, client);
      room.lastSeen = now();
      client.role = m.role === 'screen' ? 'screen' : 'control';
      if (client.role === 'screen') {
        client.w = m.w | 0; client.h = m.h | 0;
        const n = room.state.rows * room.state.cols;
        const wanted = Number.isInteger(m.tile) ? m.tile : -1;
        const taken = new Set(screensOf(room).filter(s => s.id !== id).map(s => s.tile));
        client.tile = wanted >= 0 && wanted < n && !taken.has(wanted) ? wanted : freeTile(room);
      }
      ws.send(JSON.stringify({ t: 'welcome', id }));
      broadcastState(room);
      return;
    }

    if (!room) return;
    room.lastSeen = now();

    switch (m.t) {
      case 'viewport':
        client.w = m.w | 0; client.h = m.h | 0;
        broadcastState(room);
        return;
      case 'setTile': {
        const n = room.state.rows * room.state.cols;
        const tile = m.tile | 0;
        if (tile < 0 || tile >= n) return;
        for (const c of room.clients.values()) {
          if (c !== client && c.role === 'screen' && c.tile === tile) c.tile = client.tile; // swap
        }
        client.tile = tile;
        broadcastState(room);
        return;
      }
      case 'duration':
        if (m.video === room.state.video && m.d > 0 && !room.state.duration) {
          room.state.duration = m.d; broadcastState(room);
        }
        return;
      case 'cmd': // anyone in the room (they have the code) can drive the wall
        handleCommand(room, m);
        return;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.clients.delete(id);
    room.lastSeen = now();
    broadcastState(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Tiled is running\n');
  console.log(`  Open the controller:  http://localhost:${PORT}/control`);
  for (const ip of lanAddresses()) console.log(`  On your network:      http://${ip}:${PORT}/control`);
  console.log(`\n  Built-in videos: ${builtinVideos().length} · uploads go to ${UPLOADS}\n`);
});
