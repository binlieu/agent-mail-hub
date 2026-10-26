'use strict';
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('amh.dashboard.token') || '';
let snapshot;
let polling;
let replyTo;
let sendKey = crypto.randomUUID();
let createdCredentials;
let before;
let threadId;
let threadCursor = 0;
let refreshing = false;
let instanceId;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function time(value) { return new Date(value).toLocaleString(); }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result;
}
function action(label, handler, className = 'text-action') {
  const button = element('button', label, className);
  button.type = 'button'; button.addEventListener('click', () => run(handler)); return button;
}
async function run(work) { try { error(''); await work(); } catch (failure) { error(failure.message); } }
function empty(container, message) { container.replaceChildren(element('p', message, 'empty')); }
function logout() {
  token = ''; sessionStorage.removeItem('amh.dashboard.token'); clearInterval(polling);
  $('dashboard').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('connection').textContent = 'Sign in to connect';
  $('messages').replaceChildren(); $('agents').replaceChildren(); $('events').replaceChildren(); $('thread').replaceChildren();
  snapshot = undefined; instanceId = undefined; threadId = undefined; replyTo = undefined;
  createdCredentials = undefined; $('new-credentials').hidden = true;
}
function fillRecipients() {
  if (!snapshot) return;
  const selected = $('recipient').value;
  const agents = snapshot.agents.filter(agent => agent.enabled && agent.project === $('message-project').value);
  $('recipient').replaceChildren(...agents.map(agent => new Option(agent.name, agent.name)));
  if (agents.some(agent => agent.name === selected)) $('recipient').value = selected;
}
function renderAgents() {
  const filter = $('project-filter').value;
  const agents = snapshot.agents.filter(agent => !filter || agent.project === filter);
  $('agents').replaceChildren();
  if (!agents.length) empty($('agents'), 'No agents yet. Register one below or use add-agent.');
  for (const agent of agents) {
    const card = element('div', undefined, 'agent-card');
    const title = element('div', undefined, 'agent-title');
    title.append(element('span', agent.name.slice(0, 2).toUpperCase(), 'avatar'), element('span', agent.name));
    card.append(title, element('div', `${agent.project} · ${agent.provider} / ${agent.model}`, 'agent-meta'));
    const footer = element('div', undefined, 'd-flex align-items-center justify-content-between gap-2 mt-3');
    footer.append(element('span', !agent.enabled ? 'Disabled' : agent.connected ? 'Adapter connected' : 'Offline / inbox available', `agent-status${agent.connected ? ' online' : ''}`));
    footer.append(action(agent.enabled ? 'Disable' : 'Enable', async () => { await api(`/api/agents/${agent.name}`, 'PATCH', { enabled: !agent.enabled }); await refresh(); }));
    card.append(footer, element('p', `${agent.unread} awaiting acknowledgement`, 'agent-meta mb-0'));
    $('agents').append(card);
  }
}
function messageCard(message, inThread = false) {
  const card = element('article', undefined, 'message-card');
  const route = element('div', undefined, 'message-route');
  route.append(element('strong', message.sender), element('span', '→'), element('strong', message.recipient));
  const timestamp = element('time', time(message.created_at)); timestamp.dateTime = message.created_at; route.append(timestamp);
  const footer = element('div', undefined, 'message-footer');
  footer.append(element('span', message.status, `status ${message.status}`), element('span', message.project, 'project-tag'), element('span', message.kind));
  if (!inThread) footer.append(action('View conversation', () => openThread(message.conversation_id)));
  if (message.recipient === '@human') {
    footer.append(action('Reply', () => {
      replyTo = message.id; $('compose-title').textContent = `Reply to ${message.sender}`;
      $('message-project').value = message.project; fillRecipients(); $('recipient').value = message.sender;
      $('message-project').disabled = true; $('recipient').disabled = true; $('question').disabled = true; $('question').checked = false;
      $('cancel-reply').hidden = false; sendKey = crypto.randomUUID(); $('body').focus();
    }));
    if (!message.acknowledged_at) footer.append(action('Acknowledge', async () => { await api(`/api/messages/${message.id}/ack`, 'POST'); await refresh(); }));
  }
  card.append(route, element('p', message.body, 'message-body'), footer);
  return card;
}
async function refresh() {
  if (refreshing || !token) return;
  refreshing = true;
  const usedToken = token;
  try {
    const project = $('project-filter').value;
    const data = await api(`/api/dashboard?limit=50${project ? `&project=${encodeURIComponent(project)}` : ''}`);
    if (token !== usedToken) return;
    const firstLoad = !snapshot;
    snapshot = data;
    $('agent-count').textContent = data.agents.length;
    $('connected-count').textContent = data.agents.filter(agent => agent.connected).length;
    $('message-count').textContent = data.totalMessages;
    $('unread-count').textContent = data.agents.reduce((sum, agent) => sum + agent.unread, 0);
    $('pause').textContent = data.paused ? 'Resume delivery' : 'Pause delivery'; $('paused-banner').hidden = !data.paused;
    const projects = [...new Set(data.agents.map(agent => agent.project))].sort();
    $('project-filter').replaceChildren(new Option('All projects', ''), ...projects.map(name => new Option(name, name)));
    $('project-filter').value = project;
    if (firstLoad && !data.agents.some(agent => agent.project === $('message-project').value) && data.agents[0]) $('message-project').value = data.agents[0].project;
    renderAgents(); fillRecipients();
    if (replyTo) {
      const existing = await api(`/api/messages/${replyTo}`); $('recipient').value = existing.sender;
    }
    $('messages').replaceChildren(...data.messages.map(message => messageCard(message)));
    if (!data.messages.length) empty($('messages'), 'No messages yet. Send a question to an agent to begin.');
    before = data.nextBefore; $('older').disabled = !before || data.messages.length < 50;
    $('events').replaceChildren(...data.events.map(event => {
      const row = element('div', undefined, 'event'); row.append(element('div', event.action.replaceAll('_', ' '), 'event-action'), element('div', `${event.actor} · ${time(event.created_at)}`, 'event-detail')); return row;
    }));
    if (!data.events.length) empty($('events'), 'Delivery events will appear here.');
    $('connection').textContent = '● Hub connected';
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · Refreshes every 4 seconds. Older message pages reset on refresh.`;
  } finally { refreshing = false; }
}
async function openThread(id) {
  threadId = id; threadCursor = 0; $('thread').replaceChildren(); $('thread-panel').hidden = false;
  await moreThread(); $('thread-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function moreThread() {
  const data = await api(`/api/conversations/${threadId}?after=${threadCursor}&limit=50`);
  $('thread').append(...data.items.map(message => messageCard(message, true)));
  threadCursor = data.nextCursor; $('thread-more').hidden = data.items.length < 50;
}
function cancelReply() {
  replyTo = undefined; $('compose-title').textContent = 'Send a message'; $('cancel-reply').hidden = true;
  $('message-project').disabled = false; $('recipient').disabled = false; $('question').disabled = false;
  sendKey = crypto.randomUUID();
}
async function login() {
  const me = await api('/api/me');
  if (me.role !== 'admin') throw new Error('Use the dashboard administrator token, not an agent token.');
  instanceId = me.instanceId;
  sessionStorage.setItem('amh.dashboard.token', token);
  $('token').value = ''; $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
  clearInterval(polling); await refresh();
  polling = setInterval(() => { if (!document.hidden) run(refresh); }, 4000);
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); token = $('token').value.trim(); run(login); });
$('logout').addEventListener('click', logout);
$('refresh').addEventListener('click', () => run(refresh));
$('project-filter').addEventListener('change', () => run(refresh));
$('message-project').addEventListener('input', fillRecipients);
$('pause').addEventListener('click', () => run(async () => { await api('/api/pause', 'POST', { paused: !snapshot.paused }); await refresh(); }));
$('cancel-reply').addEventListener('click', cancelReply);
$('close-thread').addEventListener('click', () => { $('thread-panel').hidden = true; threadId = undefined; });
$('thread-more').addEventListener('click', () => run(moreThread));
$('older').addEventListener('click', () => run(async () => {
  const project = $('project-filter').value;
  const data = await api(`/api/dashboard?limit=50&before=${before}${project ? `&project=${encodeURIComponent(project)}` : ''}`);
  $('messages').append(...data.messages.map(message => messageCard(message))); before = data.nextBefore;
  $('older').disabled = !before || data.messages.length < 50;
}));
$('message-form').addEventListener('submit', event => {
  event.preventDefault(); const button = event.submitter;
  run(async () => {
    button.disabled = true;
    try {
      await api('/api/messages', 'POST', { project: $('message-project').value, to: $('recipient').value, body: $('body').value, kind: $('question').checked ? 'question' : 'message', idempotencyKey: sendKey, ...(replyTo ? { replyTo } : {}) });
      $('body').value = ''; cancelReply(); await refresh();
    } finally { button.disabled = false; }
  });
});
$('agent-form').addEventListener('submit', event => {
  event.preventDefault(); const button = event.submitter;
  run(async () => {
    if (createdCredentials) throw new Error('Save the previous credential file before creating another agent.');
    button.disabled = true;
    try {
      const agent = await api('/api/agents', 'POST', { name: $('agent-name').value, project: $('agent-project').value, provider: $('agent-provider').value || 'unspecified', model: $('agent-model').value || 'unspecified' });
      createdCredentials = { version: 1, instanceId, url: `http://127.0.0.1:${location.port}`, name: agent.name, project: agent.project, token: agent.token };
      $('new-credentials').hidden = false; $('agent-name').value = ''; await refresh();
    } finally { button.disabled = false; }
  });
});
$('download-credentials').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(createdCredentials, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = createdCredentials.name + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); createdCredentials = undefined; $('new-credentials').hidden = true;
});
if (token) run(login);
