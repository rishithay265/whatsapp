const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v = '') => String(v).replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));

const state = { conversations: [], messages: {}, templates: [], selectedId: null, filter: 'all', search: '', connection: {}, config: {}, replyTo: null, attachment: null };
const starterTemplates = [
  { name:'order_confirmation', category:'UTILITY', body:'Hi {{1}}, your order {{2}} has been confirmed. We will notify you when it ships.' },
  { name:'appointment_reminder', category:'UTILITY', body:'Hi {{1}}, this is a reminder for your appointment on {{2}} at {{3}}. Reply to reschedule.' },
  { name:'payment_confirmation', category:'UTILITY', body:'Hi {{1}}, we received your payment of {{2}} for reference {{3}}. Thank you.' },
  { name:'support_follow_up', category:'UTILITY', body:'Hi {{1}}, we are following up on support request {{2}}. Reply here if you still need help.' },
  { name:'welcome_updates', category:'MARKETING', body:'Hi {{1}}, welcome to {{2}}. We will send you relevant news and offers here. Reply STOP to opt out.' }
];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function time(value) { return new Intl.DateTimeFormat([], { hour:'numeric', minute:'2-digit' }).format(new Date(value)); }
function relative(value) {
  const ms = Date.now() - new Date(value).getTime(), mins = Math.round(ms / 60000);
  if (mins < 1) return 'now'; if (mins < 60) return `${mins}m`; if (mins < 1440) return `${Math.round(mins/60)}h`;
  return new Intl.DateTimeFormat([], { month:'short', day:'numeric' }).format(new Date(value));
}
function selected() { return state.conversations.find(c => c.id === state.selectedId); }
function windowOpen(c) { return Boolean(c?.windowExpiresAt) && new Date(c.windowExpiresAt).getTime() > Date.now(); }
function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = message; $('#toasts').append(el); setTimeout(() => el.remove(), 3200);
}

function renderConversations() {
  const filtered = state.conversations.filter(c => {
    const q = state.search.toLowerCase();
    const matches = !q || `${c.name} ${c.phone} ${c.lastMessage}`.toLowerCase().includes(q);
    const type = state.filter === 'all' || (state.filter === 'unread' && c.unread) || (state.filter === 'open' && windowOpen(c));
    return matches && type;
  }).sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  $('#conversationList').innerHTML = filtered.length ? filtered.map(c => `<button class="conversation ${c.id === state.selectedId ? 'active' : ''}" data-id="${c.id}">
    <span class="avatar" style="background:${c.color || '#b9d5cd'}">${esc(c.avatar || c.name.slice(0,2))}</span>
    <span class="conversation-copy"><span class="conversation-top"><span class="conversation-name">${esc(c.name)}</span><span class="conversation-time">${relative(c.updatedAt)}</span></span><span class="conversation-last">${esc(c.lastMessage || 'No messages yet')}</span></span>
    <span class="conversation-meta">${c.unread ? `<span class="unread">${c.unread}</span>` : ''}${c.pinned ? '<span class="pin">◆</span>' : ''}</span>
  </button>`).join('') : '<div class="empty-state"><div><h2>No conversations</h2><p>Try another search or start a new chat.</p></div></div>';
  $$('.conversation').forEach(el => el.onclick = () => selectConversation(el.dataset.id));
}

function renderChat() {
  const header = $('#chatHeader'), messageList = $('#messages');
  if (!header || !messageList) return;
  const c = selected();
  if (!c) { header.innerHTML = ''; messageList.innerHTML = '<div class="empty-state"><div><h2>Select a conversation</h2><p>Your WhatsApp messages will appear here.</p></div></div>'; return; }
  header.innerHTML = `<div class="contact"><span class="avatar" style="background:${c.color}">${esc(c.avatar)}</span><div><h2>${esc(c.name)}</h2><p><span class="online-dot"></span>${esc(c.phone)} · WhatsApp</p></div></div><div class="header-actions"><button class="header-action" title="Search messages"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button><button class="header-action" title="Conversation details"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg></button></div>`;
  const open = windowOpen(c), expires = c.windowExpiresAt && new Date(c.windowExpiresAt);
  $('#windowBanner').classList.toggle('visible', !open);
  $('#windowBanner').innerHTML = open ? '' : 'The 24-hour window is closed. Use an approved template to send a message.';
  $('#messageInput').disabled = !open; $('#messageInput').placeholder = open ? 'Write a message' : 'Use a template to continue';
  const list = state.messages[c.id] || [];
  messageList.innerHTML = `<div class="day-divider">${open && expires ? `Window open until ${time(expires)}` : 'Conversation'}</div>` + list.map(messageHTML).join('');
  messageList.scrollTop = messageList.scrollHeight;
  $$('.reply-action').forEach(btn => btn.onclick = () => setReply(btn.dataset.id));
  $$('.react-action').forEach(btn => btn.onclick = () => react(btn.dataset.id));
  $('#chatPanel').classList.add('mobile-open');
}

function messageHTML(m) {
  const quote = m.replyTo || (m.reply_to_message_id ? findMessage(m.reply_to_message_id) : null);
  const interactive = m.buttons?.length ? `<div class="interactive-buttons">${m.buttons.map(b=>`<span>${esc(b)}</span>`).join('')}</div>` : m.list ? `<div class="interactive-buttons"><span>☷ ${esc(m.list.button || 'Choose')}</span></div>` : m.cta ? `<div class="interactive-buttons"><span>↗ ${esc(m.cta.display_text)}</span></div>` : '';
  const body = m.template ? `<span class="template-label">Template · ${esc(m.template.name)}</span>${m.body ? `\n${esc(m.body)}` : ''}` : esc(m.body || (m.media_urls?.length ? 'Attachment' : ''));
  return `<div class="message-row ${m.direction}" data-message-id="${m.id}"><div class="message-bubble">
    ${quote ? `<div class="quote">${esc(quote.message || quote.body || 'Quoted message')}</div>` : ''}
    <div class="message-body">${body}</div>${m.media_urls?.length ? `<div class="code">${esc(m.media_urls[0])}</div>` : ''}${interactive}
    <div class="message-footer"><span>${time(m.createdAt)}</span>${m.direction === 'outbound' ? `<span class="checks">${m.status === 'read' ? '✓✓' : '✓'}</span>` : ''}</div>
    ${m.reaction ? `<span class="reaction-chip">${esc(m.reaction)}</span>` : ''}
    <span class="message-actions"><button class="reply-action" data-id="${m.id}" title="Reply">↩</button><button class="react-action" data-id="${m.id}" title="React">♡</button></span>
  </div></div>`;
}
function findMessage(id) { for (const list of Object.values(state.messages)) { const m = list.find(x => x.id === id); if (m) return m; } return null; }
async function selectConversation(id) {
  state.selectedId = id; renderConversations();
  if (!$('#chatHeader')) {
    $('#chatPanel').innerHTML = chatOriginal;
    bindChat();
    $$('.rail-button').forEach(button => button.classList.toggle('active', button.dataset.view === 'chats'));
  }
  renderChat();
  const c = selected(); if (c?.unread) { c.unread = 0; try { await api('/api/conversations/read', { method:'POST', body:JSON.stringify({ id }) }); } catch {} renderConversations(); }
}
function setReply(id) { state.replyTo = findMessage(id); $('#replyPreview').classList.remove('hidden'); $('#replyPreview').innerHTML = `<span>Replying to: ${esc(state.replyTo.body).slice(0,100)}</span><button class="secondary" id="cancelReply">Cancel</button>`; $('#cancelReply').onclick = clearReply; $('#messageInput').focus(); }
function clearReply() { state.replyTo = null; $('#replyPreview').classList.add('hidden'); }
async function react(id) { const reaction = prompt('Reaction: emoji or love, like, dislike, laugh, emphasize, question', '❤️'); if (!reaction) return; try { await api(`/api/messages/${id}/reactions`, { method:'POST', body:JSON.stringify({ reaction }) }); } catch(e) { toast(e.message, true); } }

async function send(payload = {}) {
  const c = selected(); if (!c) return;
  const input = $('#messageInput'), text = input.value.trim();
  if (!text && !payload.template && !state.attachment) return;
  const number = state.connection.numbers?.[0]?.phone_number;
  const data = { conversationId:c.id, from_number:number, body:text, ...payload };
  if (state.replyTo) data.reply_to_message_id = state.replyTo.id;
  if (state.attachment) data.media_urls = [state.attachment];
  $('#sendButton').disabled = true;
  try { const result = await api('/api/messages', { method:'POST', body:JSON.stringify(data) }); state.messages[c.id] ||= []; if (!state.messages[c.id].some(m => m.id === result.message.id)) state.messages[c.id].push(result.message); Object.assign(c, result.conversation); input.value=''; input.style.height='auto'; clearReply(); clearAttachment(); renderChat(); renderConversations(); }
  catch(e) { toast(e.message, true); }
  finally { $('#sendButton').disabled = false; }
}

function modal(title, subtitle, content, onSubmit) {
  $('#modalContent').innerHTML = `<h2>${title}</h2><p class="sub">${subtitle}</p><form id="modalForm">${content}<div class="modal-footer"><button class="secondary" type="button" id="modalCancel">Cancel</button><button class="primary">Continue</button></div></form>`;
  $('#modalBackdrop').classList.remove('hidden'); $('#modalCancel').onclick = closeModal; $('#modalForm').onsubmit = async e => { e.preventDefault(); try { await onSubmit(new FormData(e.currentTarget)); closeModal(); } catch(error) { toast(error.message, true); } };
}
function closeModal() { $('#modalBackdrop').classList.add('hidden'); }
function showInteractive(kind) {
  $('#morePopover').classList.add('hidden');
  if (kind === 'buttons') modal('Add reply buttons','Give the customer up to three choices.',`<div class="field"><label>Message</label><textarea name="body" required placeholder="Confirm your appointment?"></textarea></div><div class="field"><label>Button labels, comma separated</label><input name="items" required placeholder="Confirm, Reschedule, Cancel"></div>`, f => send({ body:f.get('body'), buttons:String(f.get('items')).split(',').map(x=>x.trim()).filter(Boolean).slice(0,3) }));
  if (kind === 'list') modal('Create a list menu','Add up to ten options.',`<div class="field"><label>Message</label><textarea name="body" required placeholder="What do you need?"></textarea></div><div class="field"><label>Menu button</label><input name="button" required maxlength="20" value="Choose"></div><div class="field"><label>Options, one per line</label><textarea name="items" required placeholder="Book a table\nOrder status\nTalk to a human"></textarea></div>`, f => send({ body:f.get('body'), list:{ button:f.get('button'), options:String(f.get('items')).split('\n').map(x=>x.trim()).filter(Boolean).slice(0,10) } }));
  if (kind === 'cta') modal('Add a link button','Send one tappable web link.',`<div class="field"><label>Message</label><textarea name="body" required placeholder="Your order is on the way."></textarea></div><div class="field"><label>Button label</label><input name="label" required maxlength="20" placeholder="Track order"></div><div class="field"><label>HTTPS URL</label><input name="url" type="url" required placeholder="https://example.com/track"></div><div class="field"><label>Footer (optional)</label><input name="footer" placeholder="Opens our tracking page"></div>`, f => send({ body:f.get('body'), cta:{ display_text:f.get('label'), url:f.get('url'), footer:f.get('footer') } }));
  if (kind === 'template') showTemplates();
}
function showTemplates() {
  const approved = state.templates.filter(t => t.status === 'APPROVED');
  if (!approved.length) return toast('No approved WhatsApp templates are available for this account.', true);
  modal('Send a template','Approved templates work even after the 24-hour window closes.',`<div class="field"><label>Template</label><select name="template">${approved.map(t=>`<option value="${esc(t.name)}">${esc(t.name)} · ${esc(t.language)}</option>`).join('')}</select></div><div class="field"><label>Variables, comma separated</label><input name="variables" placeholder="1234, Tuesday"></div>`, f => { const t = approved.find(x=>x.name===f.get('template')); return send({ body:'', template:{ name:t.name, language:t.language, variables:String(f.get('variables')).split(',').map(x=>x.trim()).filter(Boolean) } }); });
}
function newChat() { modal('Add WhatsApp contact','Use the full international number with its country code. The contact will open as a blank conversation.',`<div class="field"><label>Contact name</label><input name="name" required maxlength="80" autocomplete="name" placeholder="Customer name"></div><div class="field"><label>WhatsApp number</label><input name="phone" type="tel" required autocomplete="tel" placeholder="+919876543210"></div>`, async f => { const result=await api('/api/conversations',{method:'POST',body:JSON.stringify({name:f.get('name'),phone:f.get('phone'),from_number:state.connection.numbers?.[0]?.phone_number})}); const existing=state.conversations.find(c=>c.id===result.conversation.id); if(existing)Object.assign(existing,result.conversation);else state.conversations.unshift(result.conversation); state.messages[result.conversation.id] ||= []; await selectConversation(result.conversation.id); if(state.templates.some(t=>t.status==='APPROVED'))showTemplates(); }); }
function clearAttachment(){state.attachment=null;$('#attachmentPreview').classList.add('hidden')}

async function createStarterTemplates() {
  const connectionId = state.connection.connections?.[0]?.connection_id;
  if (!connectionId) return toast('Connect a WhatsApp Business Account before creating templates.', true);
  const button = $('#createTemplatePack');
  button.disabled = true; button.textContent = 'Submitting…';
  try {
    const result = await api('/api/templates/starter-pack', { method:'POST', body:JSON.stringify({ connection_id:connectionId }) });
    const created = result.results.filter(item=>item.ok).length;
    const failed = result.results.length - created;
    toast(`${created} templates submitted to Meta${failed ? `; ${failed} failed` : ''}.`, Boolean(failed));
    const fresh = await api('/api/bootstrap'); state.templates = fresh.templates; state.connection = fresh.connection; renderPage('templates');
  } catch(error) { toast(error.message, true); button.disabled = false; button.textContent = 'Create starter pack'; }
}

function renderPage(view) {
  $$('.rail-button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  if (view === 'chats') { $('#chatPanel').innerHTML = chatOriginal; bindChat(); renderChat(); return; }
  const title = view === 'templates' ? 'Message templates' : 'WhatsApp settings';
  $('#chatPanel').innerHTML = `<div class="page-content"><div class="page-title-row"><div><h2>${title}</h2><p>${view==='templates'?'Approved templates can start or reopen conversations.':'Connection and webhook status for this inbox.'}</p></div>${view==='templates'?'<button class="primary" id="createTemplatePack">Create starter pack</button>':''}</div>${view==='templates' ? `<h3 class="section-label">Your Meta templates</h3>${state.templates.length ? state.templates.map(t=>`<div class="template-card"><div class="template-card-top"><b>${esc(t.name)}</b><span class="status">${esc(t.status)}</span></div><div class="template-body">${esc(t.body || t.components?.find(c=>c.type==='BODY')?.text || `${t.category} · ${t.language}`)}</div></div>`).join('') : '<div class="settings-block"><p>No templates have been returned by Meta yet.</p></div>'}<h3 class="section-label">Professional starter pack</h3>${starterTemplates.map(t=>`<div class="template-card starter"><div class="template-card-top"><b>${esc(t.name)}</b><span class="status draft">${esc(t.category)}</span></div><div class="template-body">${esc(t.body)}</div></div>`).join('')}` : `<div class="settings-block"><h3>AgentPhone connection</h3><p><span class="connection-pill ${state.connection.connected?'':'offline'}">● ${state.connection.connected?'Connected':'Not connected'}</span></p><p style="margin-top:12px">${state.config.demoMode?'Demo mode is active. Add AGENTPHONE_API_KEY to .env and restart the server.':`Connected numbers: ${esc(state.connection.numbers?.map(n=>n.phone_number).join(', ') || 'none')}`}</p></div><div class="settings-block"><h3>Inbound webhook</h3><p>Point AgentPhone at this HTTPS endpoint. Use the configured secret as a query parameter or Bearer token.</p><div class="code">${location.origin}/api/webhooks/agentphone?secret=YOUR_SECRET</div></div>`}</div>`;
  if(view==='templates') $('#createTemplatePack').onclick=createStarterTemplates;
}

let chatOriginal = $('#chatPanel').innerHTML;
function bindChat(){ $('#composer').onsubmit=e=>{e.preventDefault();send()}; $('#messageInput').oninput=e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,110)+'px'}; $('#messageInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}; $('#moreBtn').onclick=()=>$('#morePopover').classList.toggle('hidden'); $('#attachBtn').onclick=()=>$('#fileInput').click(); }

async function init() {
  try { const data=await api('/api/bootstrap'); Object.assign(state,data); state.selectedId=state.conversations[0]?.id; renderConversations(); bindChat(); renderChat(); connectEvents(); }
  catch(e){toast(e.message,true)}
}
function connectEvents(){ const events=new EventSource('/api/events'); events.addEventListener('message',e=>{const {conversation,message}=JSON.parse(e.data); const exists=state.conversations.find(c=>c.id===conversation.id); if(exists)Object.assign(exists,conversation);else state.conversations.unshift(conversation); state.messages[conversation.id]||=[]; if(!state.messages[conversation.id].some(m=>m.id===message.id))state.messages[conversation.id].push(message); renderConversations();if(state.selectedId===conversation.id)renderChat()}); events.addEventListener('reaction',e=>{const d=JSON.parse(e.data),m=findMessage(d.messageId);if(m)m.reaction=d.reaction;renderChat()}); events.onerror=()=>{}; }

$('#search').oninput=e=>{state.search=e.target.value;renderConversations()};
$$('.filter').forEach(b=>b.onclick=()=>{$$('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.filter=b.dataset.filter;renderConversations()});
$$('.rail-button').forEach(b=>b.onclick=()=>renderPage(b.dataset.view));
$('#newChat').onclick=newChat; $('#modalClose').onclick=closeModal; $('#modalBackdrop').onclick=e=>{if(e.target===e.currentTarget)closeModal()};
$$('#morePopover button').forEach(b=>b.onclick=()=>showInteractive(b.dataset.kind));
$('#fileInput').onchange=e=>{const file=e.target.files[0];if(!file)return;state.attachment=prompt('AgentPhone needs a public HTTPS URL for this file. Paste its URL:','https://');if(state.attachment){$('#attachmentPreview').classList.remove('hidden');$('#attachmentPreview').innerHTML=`<span>${esc(file.name)} · ${esc(state.attachment)}</span><button class="secondary" id="cancelAttachment">Remove</button>`;$('#cancelAttachment').onclick=clearAttachment}};
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();$('#search').focus()}if(e.key==='Escape'){$('#morePopover').classList.add('hidden');closeModal()}});
if(matchMedia('(max-width:720px)').matches) $('#chatHeader').onclick=e=>{if(e.offsetX<55)$('#chatPanel').classList.remove('mobile-open')};
init();
