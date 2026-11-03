// Medidor emocional en vivo
// Servidor Express + Socket.IO. Guarda cada reacción en un archivo JSONL.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'prueba';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://medidor-emocional.up.railway.app';
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

// ---------- Generador Excel (.xlsx) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x0021, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x0021, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function xmlEsc(v) {
  return String(v ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildExcelBuffer(rows) {
  const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const sheetRows = rows.map((row, rIdx) => {
    const rowNum = rIdx + 1;
    const isHeader = rIdx === 0;
    const cells = row.map((val, cIdx) => {
      const ref = `${cols[cIdx]}${rowNum}`;
      const style = isHeader ? ' s="1"' : '';
      if (!isHeader && typeof val === 'number' && Number.isFinite(val)) {
        return `<c r="${ref}" t="n"${style}><v>${val}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNum}">${cells}</row>`;
  }).join('');

  return buildZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Reacciones" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2B2B2B"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="38" customWidth="1"/>
    <col min="2" max="2" width="13" customWidth="1"/>
    <col min="3" max="3" width="12" customWidth="1"/>
    <col min="4" max="4" width="24" customWidth="1"/>
    <col min="5" max="5" width="14" customWidth="1"/>
    <col min="6" max="6" width="30" customWidth="1"/>
    <col min="7" max="7" width="12" customWidth="1"/>
    <col min="8" max="8" width="12" customWidth="1"/>
    <col min="9" max="9" width="22" customWidth="1"/>
  </cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`],
  ]);
}

// Excel .xlsx (admin)
function sendExcel(req, res) {
  if (!isAdmin(req)) return res.status(401).send('No autorizado');
  const fmtDate = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtTime = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const header = ['id', 'fecha', 'hora', 'nombre', 'cuadrante', 'descripcion_cuadrante', 'agrado_x', 'energia_y', 'palabra'];
  const rows = reactions.map(r => {
    const d = new Date(r.ts);
    return [r.id, fmtDate.format(d), fmtTime.format(d), r.nombre, r.cuadrante, QUADRANTS[r.cuadrante] || '', Number(r.x), Number(r.y), r.palabra];
  });
  const stamp = fmtDate.format(new Date());
  const xlsx = buildExcelBuffer([header, ...rows]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reacciones_${stamp}.xlsx"`);
  res.send(xlsx);
}
app.get('/api/excel', sendExcel);
app.get('/api/csv', sendExcel);

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
