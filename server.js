// Medidor emocional en vivo
// Servidor Express + Socket.IO. Guarda cada reacción en un archivo JSONL.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'prueba';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // opcional, p. ej. https://medidor.up.railway.app
const EVENT_TITLE = process.env.EVENT_TITLE || '¿Cómo te hizo sentir?';
const TZ = 'America/Bogota';
const COOLDOWN_MS = 1500;

fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'reacciones.jsonl');

// ---------- Datos ----------
let reactions = [];
if (fs.existsSync(DATA_FILE)) {
  reactions = fs.readFileSync(DATA_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
console.log(`Reacciones cargadas: ${reactions.length}`);

const QUADRANTS = {
  rojo: 'Alta energía / No agradable',
  amarillo: 'Alta energía / Agradable',
  azul: 'Baja energía / No agradable',
  verde: 'Baja energía / Agradable',
};

function quadrantOf(x, y) {
  if (y > 0) return x < 0 ? 'rojo' : 'amarillo';
  return x < 0 ? 'azul' : 'verde';
}

function cleanWord(w) {
  return String(w || '')
    .trim()
    .replace(/[^\p{L}\p{N}\-']/gu, '')
    .slice(0, 30)
    .toLowerCase();
}

function isAdminKey(k) {
  if (!k) return false;
  if (process.env.ADMIN_KEY) return k === process.env.ADMIN_KEY;
  return k === 'prueba' || k === 'cambia-esta-clave';
}

function isAdmin(req) {
  const k = req.query.key || req.get('x-admin-key');
  return isAdminKey(k);
}

// ---------- App ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/vendor/wordcloud2.js', (req, res) =>
  res.sendFile(require.resolve('wordcloud/src/wordcloud2.js')));

app.get('/api/config', (req, res) => res.json({ title: EVENT_TITLE }));

// Envío de una reacción (participantes)
const lastByClient = new Map();
app.post('/api/reacciones', (req, res) => {
  const nombre = String(req.body.nombre || '').trim().slice(0, 60);
  const palabra = cleanWord(req.body.palabra);
  const x = parseInt(req.body.x, 10);
  const y = parseInt(req.body.y, 10);

  const validAxis = v => Number.isInteger(v) && v !== 0 && v >= -5 && v <= 5;
  if (!nombre) return res.status(400).json({ error: 'Escribe tu nombre.' });
  if (!validAxis(x) || !validAxis(y)) return res.status(400).json({ error: 'Elige una casilla en el medidor.' });
  if (!palabra) return res.status(400).json({ error: 'Escribe una palabra.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  const cid = String(req.body.cid || '').trim().slice(0, 40);
  const clientKey = cid ? `${ip}:${cid}` : `${ip}:${nombre.toLowerCase()}`;
  const now = Date.now();
  if (now - (lastByClient.get(clientKey) || 0) < COOLDOWN_MS) {
    return res.status(429).json({ error: 'Espera unos segundos antes de enviar otra reacción.' });
  }
  lastByClient.set(clientKey, now);
  if (lastByClient.size > 2000) {
    for (const [k, ts] of lastByClient) {
      if (now - ts > COOLDOWN_MS * 2) lastByClient.delete(k);
    }
  }

  const r = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    nombre, palabra, x, y,
    cuadrante: quadrantOf(x, y),
  };
  reactions.push(r);
  fs.appendFile(DATA_FILE, JSON.stringify(r) + '\n', err => err && console.error(err));
  io.to('admin').emit('reaccion', r);
  res.json({ ok: true });
});

// Estado completo (admin)
app.get('/api/estado', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  res.json({ reactions, title: EVENT_TITLE });
});

// CSV (admin)
app.get('/api/csv', (req, res) => {
  if (!isAdmin(req)) return res.status(401).send('No autorizado');
  const fmtDate = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtTime = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['id', 'fecha', 'hora', 'nombre', 'cuadrante', 'descripcion_cuadrante', 'agrado_x', 'energia_y', 'palabra'];
  const rows = reactions.map(r => {
    const d = new Date(r.ts);
    return [r.id, fmtDate.format(d), fmtTime.format(d), r.nombre, r.cuadrante, QUADRANTS[r.cuadrante], r.x, r.y, r.palabra].map(esc).join(',');
  });
  const stamp = fmtDate.format(new Date());
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reacciones_${stamp}.csv"`);
  res.send('﻿' + [header.join(','), ...rows].join('\r\n'));
});

// Borrar todo (admin)
app.post('/api/reset', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (fs.existsSync(DATA_FILE)) {
    try {
      fs.renameSync(DATA_FILE, path.join(DATA_DIR, `respaldo_${Date.now()}.jsonl`));
    } catch (err) {
      console.error('Error respaldando archivo de reacciones:', err);
    }
  }
  reactions = [];
  io.to('admin').emit('reset');
  res.json({ ok: true });
});

// QR de la vista de participante (admin)
app.get('/api/qr', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).send('No autorizado');
  const base = PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
  const url = base.replace(/\/$/, '') + '/';
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#2b2b2b', light: '#00000000' } });
  res.json({ url, svg });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

io.on('connection', socket => {
  if (isAdminKey(socket.handshake.auth?.key)) {
    socket.join('admin');
    socket.emit('estado', { reactions, title: EVENT_TITLE });
  }
});

server.listen(PORT, () => {
  console.log(`Medidor emocional escuchando en puerto ${PORT}`);
  console.log(`  Participante: http://localhost:${PORT}/`);
  console.log(`  Admin:        http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  if (!process.env.ADMIN_KEY) console.warn('ADVERTENCIA: define la variable ADMIN_KEY antes del evento en producción.');
});
