import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL ? '/tmp/whatsapp-agentphone' : join(ROOT, '.data');
const STORE_FILE = join(DATA_DIR, 'store.json');
const PORT = Number(process.env.PORT || 4173);
const API_BASE = (process.env.AGENTPHONE_BASE_URL || 'https://api.agentphone.ai').replace(/\/$/, '');
const API_KEY = process.env.AGENTPHONE_API_KEY || '';
const WEBHOOK_SECRET = process.env.AGENTPHONE_WEBHOOK_SECRET || '';
const demoMode = !API_KEY || API_KEY.includes('replace_me');
const clients = new Set();

const now = () => new Date().toISOString();
const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600e3).toISOString();

const seed = {
  schemaVersion: 2,
  connection: { connected: false, enabled: false, demo: true, numbers: [] },
  conversations: [],
  messages: {},
  templates: []
};

let store;
async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    store = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    if (store.schemaVersion !== seed.schemaVersion) {
      store = structuredClone(seed);
      await saveStore();
    }
  }
  catch { store = structuredClone(seed); await saveStore(); }
}
async function saveStore() { await writeFile(STORE_FILE, JSON.stringify(store, null, 2)); }

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function emit(type, data) {
  const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(chunk);
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function agentphone(path, options = {}) {
  if (demoMode) return null;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : {};
  if (!response.ok) throw Object.assign(new Error(data.detail || data.message || `AgentPhone returned ${response.status}`), { status: response.status, data });
  return data;
}
function conversationFor(phone, fromNumber) {
  let conversation = store.conversations.find(c => c.phone.replace(/\D/g, '') === String(phone).replace(/\D/g, ''));
  if (!conversation) {
    const digits = String(phone).replace(/\D/g, '');
    conversation = { id: randomUUID(), name: phone, phone, fromNumber, avatar: digits.slice(-2) || 'WA', color: '#8dbdb0', unread: 0, lastMessage: '', updatedAt: now(), windowExpiresAt: hoursFromNow(24) };
    store.conversations.unshift(conversation);
    store.messages[conversation.id] = [];
  }
  return conversation;
}
function normalizePhone(value) {
  const phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw Object.assign(new Error('Enter a valid international number, including the country code, such as +919876543210.'), { status: 400 });
  }
  return phone;
}
function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}
function recordMessage(conversation, message) {
  store.messages[conversation.id] ||= [];
  store.messages[conversation.id].push(message);
  conversation.lastMessage = message.body || (message.media_urls?.length ? 'Attachment' : 'Message');
  conversation.updatedAt = message.createdAt;
  if (message.direction === 'inbound') {
    conversation.unread = (conversation.unread || 0) + 1;
    conversation.windowExpiresAt = hoursFromNow(24);
  }
}
function canSend(conversation) { return Boolean(conversation.windowExpiresAt) && new Date(conversation.windowExpiresAt).getTime() > Date.now(); }

async function serveStatic(req, res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  const full = normalize(join(PUBLIC, requested));
  if (!full.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(full);
    const file = info.isDirectory() ? join(full, 'index.html') : full;
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { json(res, 404, { error: 'Not found' }); }
}

await loadStore();

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(keepAlive); clients.delete(res); });
      return;
    }
    if (p === '/api/bootstrap' && req.method === 'GET') {
      let connection = store.connection;
      let templates = store.templates;
      if (!demoMode) {
        try {
          const remote = await agentphone('/integrations/whatsapp/status');
          connection = { ...remote, demo: false, numbers: remote.connections?.flatMap(c => c.numbers || []) || [] };
          const connectionId = remote.connections?.[0]?.connection_id;
          if (connectionId) {
            try {
              const result = await agentphone(`/integrations/whatsapp/${encodeURIComponent(connectionId)}/templates?status=APPROVED`);
              templates = Array.isArray(result) ? result : (result.templates || result.data || []);
              store.templates = templates;
            } catch (error) {
              console.error('Unable to load WhatsApp templates:', error.message);
            }
          }
        } catch (error) { connection = { connected: false, enabled: false, demo: false, error: error.message, numbers: [] }; }
      }
      return json(res, 200, { connection, conversations: store.conversations, messages: store.messages, templates, config: { demoMode } });
    }
    if (p === '/api/conversations' && req.method === 'POST') {
      const input = await body(req);
      const name = String(input.name || '').trim();
      if (!name) return json(res, 400, { error: 'Contact name is required.' });
      const phone = normalizePhone(input.phone);
      let conversation = store.conversations.find(c => c.phone === phone);
      if (conversation) {
        conversation.name = name;
        conversation.avatar = initials(name);
      } else {
        conversation = {
          id: randomUUID(), name, phone, fromNumber: input.from_number || null,
          avatar: initials(name), color: '#b9d5cd', unread: 0, lastMessage: '',
          updatedAt: now(), windowExpiresAt: null
        };
        store.conversations.unshift(conversation);
        store.messages[conversation.id] = [];
      }
      await saveStore();
      emit('conversation', conversation);
      return json(res, 201, { conversation });
    }
    if (p === '/api/conversations/read' && req.method === 'POST') {
      const input = await body(req);
      const c = store.conversations.find(x => x.id === input.id);
      if (c) { c.unread = 0; await saveStore(); emit('conversation', c); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/messages' && req.method === 'POST') {
      const input = await body(req);
      const conversation = store.conversations.find(c => c.id === input.conversationId) || conversationFor(input.to_number, input.from_number);
      const isTemplate = Boolean(input.template);
      if (!isTemplate && !canSend(conversation)) return json(res, 422, { error: 'The 24-hour WhatsApp window is closed. Send an approved template.' });
      const payload = { from_number: input.from_number, to_number: conversation.phone, channel: 'whatsapp', body: input.body ?? '' };
      for (const key of ['media_urls', 'reply_to_message_id', 'buttons', 'list', 'cta', 'template']) if (input[key] != null) payload[key] = input[key];
      const remote = await agentphone('/v1/messages', { method: 'POST', body: JSON.stringify(payload) });
      const message = { id: remote?.id || remote?.data?.id || randomUUID(), direction: 'outbound', createdAt: now(), status: demoMode ? 'sent' : 'queued', ...payload };
      recordMessage(conversation, message);
      await saveStore();
      emit('message', { conversation, message });
      return json(res, 201, { conversation, message });
    }
    const reactionMatch = p.match(/^\/api\/messages\/([^/]+)\/reactions$/);
    if (reactionMatch && req.method === 'POST') {
      const input = await body(req);
      await agentphone(`/v1/messages/${encodeURIComponent(reactionMatch[1])}/reactions`, { method: 'POST', body: JSON.stringify({ reaction: input.reaction }) });
      let found;
      for (const list of Object.values(store.messages)) {
        found = list.find(m => m.id === reactionMatch[1]);
        if (found) break;
      }
      if (found) found.reaction = input.reaction;
      await saveStore(); emit('reaction', { messageId: reactionMatch[1], reaction: input.reaction });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/webhooks/agentphone' && req.method === 'POST') {
      const supplied = url.searchParams.get('secret') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (WEBHOOK_SECRET && supplied !== WEBHOOK_SECRET) return json(res, 401, { error: 'Invalid webhook secret' });
      const event = await body(req);
      if (event.event === 'agent.message' && (event.channel === 'whatsapp' || event.data?.channel === 'whatsapp')) {
        const d = event.data || {};
        const conversation = conversationFor(d.from, d.to);
        const message = { id: d.id || d.messageId || randomUUID(), direction: 'inbound', body: d.message || d.body || '', media_urls: d.media_urls || d.mediaUrls, replyTo: d.replyTo, createdAt: d.createdAt || now(), raw: event };
        recordMessage(conversation, message); await saveStore(); emit('message', { conversation, message });
      }
      return json(res, 200, { received: true });
    }
    if (p === '/api/templates' && req.method === 'GET') {
      const connectionId = url.searchParams.get('connection_id');
      if (!demoMode && connectionId) return json(res, 200, await agentphone(`/integrations/whatsapp/${encodeURIComponent(connectionId)}/templates`));
      return json(res, 200, store.templates);
    }
    if (p === '/api/templates' && req.method === 'POST') {
      const input = await body(req);
      const remote = await agentphone(`/integrations/whatsapp/${encodeURIComponent(input.connection_id)}/templates`, { method: 'POST', body: JSON.stringify(input.template) });
      const template = remote || { id: randomUUID(), status: 'PENDING', ...input.template };
      store.templates.push(template); await saveStore(); emit('template', template);
      return json(res, 201, template);
    }
    if (p === '/api/templates' && req.method === 'DELETE') {
      const connectionId = url.searchParams.get('connection_id');
      const name = url.searchParams.get('name');
      const hsm = url.searchParams.get('hsm_id');
      if (!demoMode) await agentphone(`/integrations/whatsapp/${encodeURIComponent(connectionId)}/templates?name=${encodeURIComponent(name)}${hsm ? `&hsm_id=${encodeURIComponent(hsm)}` : ''}`, { method: 'DELETE' });
      store.templates = store.templates.filter(t => !(t.name === name && (!hsm || t.id === hsm)));
      await saveStore(); emit('templates', store.templates);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'API route not found' });
    return serveStatic(req, res, p);
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.message, details: error.data });
  }
}

export default handler;

// Vercel owns the HTTP listener. Start one only when this file is run directly.
if (!IS_VERCEL && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`WhatsApp console running at http://localhost:${PORT}${demoMode ? ' (demo mode)' : ''}`);
  });
}
