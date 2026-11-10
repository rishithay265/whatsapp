import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA_DIR = join(ROOT, '.data');
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
  connection: { connected: true, enabled: true, demo: true, numbers: [{ id: 'demo-number', phone_number: '+91 98765 43210', agent_id: 'demo-agent' }] },
  conversations: [
    { id: 'ananya', name: 'Ananya Rao', phone: '+91 99887 71204', avatar: 'AR', color: '#c6a6e8', unread: 2, lastMessage: 'Can you share the tracking link?', updatedAt: new Date(Date.now() - 4 * 60e3).toISOString(), windowExpiresAt: hoursFromNow(21), pinned: true },
    { id: 'rohan', name: 'Rohan Mehta', phone: '+91 98110 44028', avatar: 'RM', color: '#8fcbd2', unread: 0, lastMessage: 'Perfect, thank you!', updatedAt: new Date(Date.now() - 42 * 60e3).toISOString(), windowExpiresAt: hoursFromNow(8) },
    { id: 'meera', name: 'Meera Iyer', phone: '+91 94440 71255', avatar: 'MI', color: '#e7b287', unread: 0, lastMessage: 'I need to reschedule.', updatedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), windowExpiresAt: hoursFromNow(-2) },
    { id: 'arjun', name: 'Arjun Nair', phone: '+91 98470 55019', avatar: 'AN', color: '#96b8ec', unread: 0, lastMessage: 'The blue one looks good.', updatedAt: new Date(Date.now() - 25 * 3600e3).toISOString(), windowExpiresAt: hoursFromNow(-1) }
  ],
  messages: {
    ananya: [
      { id: 'm-a1', direction: 'inbound', body: 'Hi! Is my order on the way?', createdAt: new Date(Date.now() - 13 * 60e3).toISOString(), status: 'read' },
      { id: 'm-a2', direction: 'outbound', body: 'Hi Ananya, yes. It left our warehouse this morning.', createdAt: new Date(Date.now() - 10 * 60e3).toISOString(), status: 'read' },
      { id: 'm-a3', direction: 'inbound', body: 'Can you share the tracking link?', createdAt: new Date(Date.now() - 4 * 60e3).toISOString(), status: 'delivered' }
    ],
    rohan: [
      { id: 'm-r1', direction: 'outbound', body: 'Your appointment is confirmed for tomorrow at 3:30 PM.', buttons: ['Confirm', 'Reschedule', 'Cancel'], createdAt: new Date(Date.now() - 50 * 60e3).toISOString(), status: 'read' },
      { id: 'm-r2', direction: 'inbound', body: 'Confirm', replyTo: { messageId: 'm-r1', message: 'Your appointment is confirmed for tomorrow at 3:30 PM.' }, createdAt: new Date(Date.now() - 45 * 60e3).toISOString() },
      { id: 'm-r3', direction: 'outbound', body: 'Perfect, thank you!', createdAt: new Date(Date.now() - 42 * 60e3).toISOString(), status: 'read', reaction: '❤️' }
    ],
    meera: [{ id: 'm-m1', direction: 'inbound', body: 'I need to reschedule.', createdAt: new Date(Date.now() - 27 * 3600e3).toISOString() }],
    arjun: [{ id: 'm-j1', direction: 'inbound', body: 'The blue one looks good.', createdAt: new Date(Date.now() - 49 * 3600e3).toISOString() }]
  },
  templates: [
    { id: 't1', name: 'order_shipped', language: 'en_US', category: 'UTILITY', status: 'APPROVED', body: 'Your order {{1}} has shipped.' },
    { id: 't2', name: 'appointment_reminder', language: 'en_US', category: 'UTILITY', status: 'APPROVED', body: 'Reminder: your appointment is on {{1}} at {{2}}.' }
  ]
};

let store;
async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try { store = JSON.parse(await readFile(STORE_FILE, 'utf8')); }
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
function canSend(conversation) { return !conversation.windowExpiresAt || new Date(conversation.windowExpiresAt).getTime() > Date.now(); }

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

const server = http.createServer(async (req, res) => {
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
      if (!demoMode) {
        try {
          const remote = await agentphone('/integrations/whatsapp/status');
          connection = { ...remote, demo: false, numbers: remote.connections?.flatMap(c => c.numbers || []) || [] };
        } catch (error) { connection = { connected: false, enabled: false, demo: false, error: error.message, numbers: [] }; }
      }
      return json(res, 200, { connection, conversations: store.conversations, messages: store.messages, templates: store.templates, config: { demoMode } });
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
      if (demoMode) setTimeout(async () => {
        const replies = ['Got it, thanks!', 'Yes, that works for me.', 'Can you share a few more details?', 'Perfect.'];
        const reply = { id: randomUUID(), direction: 'inbound', body: replies[Math.floor(Math.random() * replies.length)], createdAt: now(), status: 'delivered' };
        recordMessage(conversation, reply); await saveStore(); emit('message', { conversation, message: reply });
      }, 1400);
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
});

server.listen(PORT, () => console.log(`WhatsApp console running at http://localhost:${PORT}${demoMode ? ' (demo mode)' : ''}`));
