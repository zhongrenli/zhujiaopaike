const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedule.json');

const defaultState = {
  assistants: [],
  timeSlots: [
    { label: '上午一', time: '08:30 - 10:30' },
    { label: '上午二', time: '10:30 - 12:30' },
    { label: '下午一', time: '13:30 - 15:30' },
    { label: '下午二', time: '15:30 - 17:30' }
  ],
  schedule: {},
  updatedAt: null,
  updatedBy: null
};

const clients = new Set();

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultState, null, 2));
  }
}

function readState() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return sanitizeState(parsed);
  } catch (error) {
    return { ...defaultState };
  }
}

function sanitizeState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const assistants = Array.isArray(source.assistants)
    ? [...new Set(source.assistants.map(String).map(name => name.trim()).filter(Boolean))]
    : [];
  const timeSlots = Array.isArray(source.timeSlots) && source.timeSlots.length
    ? source.timeSlots.slice(0, 12).map(slot => ({
        label: String(slot && slot.label ? slot.label : '').trim() || '未命名',
        time: String(slot && slot.time ? slot.time : '').trim() || '未设置'
      }))
    : defaultState.timeSlots;
  const schedule = {};

  if (source.schedule && typeof source.schedule === 'object') {
    Object.entries(source.schedule).forEach(([key, value]) => {
      const slotIndex = Number(key);
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= timeSlots.length) return;
      if (!Array.isArray(value)) return;
      const names = [...new Set(value.map(String).map(name => name.trim()).filter(Boolean))]
        .filter(name => assistants.includes(name));
      if (names.length) schedule[String(slotIndex)] = names;
    });
  }

  return {
    assistants,
    timeSlots,
    schedule,
    updatedAt: source.updatedAt || null,
    updatedBy: source.updatedBy || null
  };
}

function writeState(nextState) {
  const state = sanitizeState({
    ...nextState,
    updatedAt: new Date().toISOString(),
    updatedBy: nextState.updatedBy || 'unknown'
  });
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  broadcast(state);
  return state;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('请求内容过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  });
}

function addEventClient(req, res) {
  const client = { id: randomUUID(), res };
  clients.add(client);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: state\n`);
  res.write(`data: ${JSON.stringify(readState())}\n\n`);

  req.on('close', () => {
    clients.delete(client);
  });
}

function broadcast(state) {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    client.res.write(payload);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, readState());
      return;
    }

    if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === '/api/state') {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      sendJson(res, 200, writeState(payload));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      addEventClient(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Bad request' });
  }
});

server.listen(PORT, HOST, () => {
  ensureDataFile();
  console.log(`助教排班系统已启动：http://${HOST}:${PORT}`);
});
