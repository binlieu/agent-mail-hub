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
let registrationOptions;

function shellQuote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
function updateModelChoice(resetModel = false) {
  if (!registrationOptions) return;
  const provider = registrationOptions.providers.find(item => item.id === $('agent-provider').value);
  if (resetModel) $('agent-model').replaceChildren(...provider.models.map(item => new Option(item.label, item.id)), new Option('Enter exact model ID…', 'custom'));
  const model = provider.models.find(item => item.id === $('agent-model').value);
  const custom = $('agent-model').value === 'custom';
  $('custom-model-field').hidden = !custom; $('agent-custom-model').required = custom;
  $('model-effect').textContent = model?.description || 'Use an exact model ID supported by your client. Configure its effort in the client.';
  const previousEffort = $('agent-effort').value;
  const efforts = model?.efforts || ['default'];
  $('agent-effort').replaceChildren(...efforts.map(id => new Option(registrationOptions.efforts[id].label, id)));
  $('agent-effort').value = efforts.includes(previousEffort) ? previousEffort : 'default';
  updateSessionPreview();
}
function updateSessionPreview() {
  if (!registrationOptions) return;
  const provider = $('agent-provider').value;
  const model = $('agent-model').value === 'custom' ? $('agent-custom-model').value.trim() : $('agent-model').value;
  const effort = $('agent-effort').value;
  $('effort-effect').textContent = registrationOptions.efforts[effort].description;
  let command = provider;
  if (model && model !== 'default') command += ` --model ${shellQuote(model)}`;
  if (effort !== 'default') command += provider === 'claude' ? ` --effort ${shellQuote(effort)}` : ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}`;
  $('agent-session-command').textContent = command;
}
async function loadModelOptions() {
  const button = $('agent-form').querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    registrationOptions = await api('/api/model-options');
    updateModelChoice(true);
    $('model-options-status').textContent = `Presets reviewed ${registrationOptions.reviewedOn}. Availability depends on your account, client version and organization. These are requested settings, not verified session settings.`;
    button.disabled = false;
  } catch (failure) {
    $('model-options-status').textContent = 'Model presets unavailable. Restart this hub with the updated app before registering an agent.';
  }
}

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
  $('messages').replaceChildren(); $('agents').replaceChildren(); $('events').replaceChildren(); $('thread').replaceChildren(); $('handoff-detail').replaceChildren();
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
    card.append(element('div', `Requested effort: ${agent.reasoningEffort || 'default'} · Session settings are not verified`, 'agent-meta'));
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
  if (message.handoff) footer.append(action(`Handoff: ${message.handoff.state}`, () => openHandoff(message.handoff.id)));
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
  if (message.evidence?.length) {
    const attachments = element('div', undefined, 'evidence-list mt-3');
    for (const item of message.evidence) attachments.append(evidenceLink(item));
    card.append(attachments);
  }
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
function evidenceLink(item) {
  const row = element('div', undefined, 'evidence-item');
  row.append(action(`Download ${item.filename} (${item.size} bytes)`, () => downloadEvidence(item.id)));
  row.append(element('div', `SHA-256: ${item.sha256}`, 'small text-secondary evidence-hash'));
  row.append(element('div', `Source: ${item.source_ref}`, 'small text-secondary evidence-hash'));
  for (const receipt of item.reviews ?? []) row.append(element('div', `${receipt.reviewer}: ${receipt.state} — ${receipt.note}`, 'small text-secondary'));
  return row;
}
async function downloadEvidence(id) {
  const item = await api(`/api/evidence/${id}?content=true`);
  const bytes = Uint8Array.from(atob(item.content), character => character.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (sha !== item.sha256) throw new Error('Downloaded evidence checksum mismatch; file was not saved.');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = element('a'); link.href = url; link.download = item.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function openHandoff(id) {
  const item = await api(`/api/handoffs/${id}`);
  const panel = $('handoff-detail'); panel.replaceChildren();
  panel.append(element('p', `${item.sender} → ${item.recipient} · ${item.state}`, 'fw-semibold'), element('h3', item.packet.objective, 'h6'), element('p', item.packet.context, 'message-body'));
  panel.append(element('p', `Workspace reference: ${item.packet.workspaceRef}`, 'small text-secondary evidence-hash'));
  for (const [label, field] of [['Completed before transfer', 'completed'], ['Remaining at transfer', 'remaining'], ['Next steps', 'nextSteps']]) {
    panel.append(element('h3', label, 'h6 mt-3'));
    const list = element('ul', undefined, 'small');
    for (const entry of item.packet[field]) list.append(element('li', entry));
    panel.append(list);
  }
  panel.append(element('h3', 'Transferred evidence', 'h6 mt-3'));
  for (const entry of item.evidence) panel.append(evidenceLink(entry));
  for (const update of item.updates) panel.append(element('p', `${update.state}: ${update.note}`, 'small mt-3'));
  if (item.completionEvidence.length) {
    panel.append(element('h3', 'Result evidence', 'h6 mt-3'));
    for (const entry of item.completionEvidence) panel.append(evidenceLink(entry));
  }
  panel.append(element('p', 'Review and completion are agent claims. Checksums verify transferred bytes; they do not prove the claims are correct.', 'panel-footnote mt-3'));
  $('handoff-panel').hidden = false;
  $('handoff-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  clearInterval(polling); await refresh(); await loadModelOptions();
  polling = setInterval(() => { if (!document.hidden) run(refresh); }, 4000);
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); token = $('token').value.trim(); run(login); });
$('logout').addEventListener('click', logout);
$('refresh').addEventListener('click', () => run(refresh));
$('project-filter').addEventListener('change', () => run(refresh));
$('message-project').addEventListener('input', fillRecipients);
$('pause').addEventListener('click', () => run(async () => { await api('/api/pause', 'POST', { paused: !snapshot.paused }); await refresh(); }));
$('cancel-reply').addEventListener('click', cancelReply);
$('close-handoff').addEventListener('click', () => { $('handoff-panel').hidden = true; });
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
      if (!registrationOptions) throw new Error('Model presets are not available yet.');
      const model = $('agent-model').value === 'custom' ? $('agent-custom-model').value.trim() : $('agent-model').value;
      const agent = await api('/api/agents', 'POST', { name: $('agent-name').value, project: $('agent-project').value, provider: $('agent-provider').value, model, reasoningEffort: $('agent-effort').value });
      createdCredentials = { version: 1, instanceId, url: `http://127.0.0.1:${location.port}`, name: agent.name, project: agent.project, token: agent.token };
      $('new-credentials').hidden = false; $('agent-name').value = ''; await refresh();
    } finally { button.disabled = false; }
  });
});
$('agent-provider').addEventListener('change', () => { $('agent-effort').value = 'default'; updateModelChoice(true); });
$('agent-model').addEventListener('change', () => updateModelChoice());
$('agent-effort').addEventListener('change', updateSessionPreview);
$('agent-custom-model').addEventListener('input', updateSessionPreview);
$('agent-form').querySelector('button[type="submit"]').disabled = true;
$('download-credentials').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(createdCredentials, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = createdCredentials.name + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); createdCredentials = undefined; $('new-credentials').hidden = true;
});
if (token) run(login);
