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
let threadRequest = 0;
let threadTrigger;
let refreshing = false;
let instanceId;
let registrationOptions;
let localTokenRequest = 0;

function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
marked.use({ renderer: {
  html: ({text}) => escapeHtml(text),
  image: ({text}) => escapeHtml(`[Image: ${text}]`)
} });
function markdownBody(text, sourceToggle = false) {
  const container = element('div', undefined, 'message-body markdown-body');
  const preview = element('div');
  preview.append(DOMPurify.sanitize(marked.parse(text, {gfm:true,breaks:true}), {
    RETURN_DOM_FRAGMENT:true,
    ALLOWED_TAGS:['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','pre','code','a','table','thead','tbody','tr','th','td'],
    ALLOWED_ATTR:['href','title','start','align']
  }));
  for (const link of preview.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    try {
      if (!href || !['http:','https:','mailto:'].includes(new URL(href, location.origin).protocol)) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    } catch { link.removeAttribute('href'); }
  }
  container.append(preview);
  if (sourceToggle) {
    const source = element('pre', text, 'markdown-source'); source.hidden = true;
    const toggle = action('Show Markdown source', () => {
      source.hidden = !source.hidden; preview.hidden = !source.hidden;
      toggle.textContent = source.hidden ? 'Show Markdown source' : 'Show rendered preview';
      toggle.setAttribute('aria-pressed', String(!source.hidden));
    });
    toggle.setAttribute('aria-pressed', 'false');
    container.prepend(toggle); container.append(source);
  }
  return container;
}

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
  closeThread();
  hideLocalToken();
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
function renderUsage(usage, name, expanded) {
  const panel = element('section', undefined, 'agent-usage');
  const details = element('details', undefined, 'usage-details');
  details.dataset.agentUsage = name; details.open = expanded;
  details.append(element('summary', `Usage details${usage?.stale ? ' · Stale reading' : ''}`));
  const format = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const metric = (label, value, stale = false) => {
    const row = element('div', undefined, 'usage-metric');
    row.append(element('strong', label), element('span', value + (stale ? ' · Stale' : '')));
    panel.append(row);
  };
  const ctx = usage?.context;
  metric('Context', ctx?.usedPercent !== null && ctx?.usedPercent !== undefined ? `${format(ctx.usedPercent)}% used · ${format(ctx.remainingPercent)}% free` : 'Unavailable', ctx?.stale);
  if (ctx?.usedPercent !== null && ctx?.usedPercent !== undefined) {
    const progress = element('progress', `${format(ctx.usedPercent)}% used`, ctx.stale ? 'usage-progress stale' : 'usage-progress');
    progress.max = 100; progress.value = ctx.usedPercent; progress.setAttribute('aria-label', 'Context used'); panel.append(progress);
  }
  if (ctx?.usedTokens !== null && ctx?.usedTokens !== undefined) panel.append(element('div', `${format(ctx.usedTokens)}${ctx.windowTokens === null ? '' : ` / ${format(ctx.windowTokens)}`} context tokens${ctx.remainingTokens === null ? '' : ` · ${format(ctx.remainingTokens)} left`}`, 'usage-detail'));
  if (ctx) details.append(element('div', `Context observed ${time(ctx.observedAt)}`, 'usage-detail'));
  if (usage?.sessionTokens !== null && usage?.sessionTokens !== undefined) {
    if (!ctx?.usedTokens) panel.append(element('div', `Tokens consumed: ${format(usage.sessionTokens)}${usage.tokensStale ? ' · Stale' : ''}`, 'usage-detail'));
    details.append(element('div', `Reported token usage: ${format(usage.sessionTokens)} (not remaining allowance) · ${time(usage.sessionTokensObservedAt)}${usage.tokensStale ? ' · Stale' : ''}`, 'usage-detail'));
  }
  if (!usage?.limits?.length) metric('Account allowance', 'Unavailable');
  for (const window of usage?.limits || []) {
    const duration = window.windowMinutes === null ? window.label : window.windowMinutes >= 1440 ? `${format(window.windowMinutes / 1440)}-day` : window.windowMinutes >= 60 ? `${format(window.windowMinutes / 60)}-hour` : `${window.windowMinutes}-minute`;
    metric(`Shared ${duration} allowance`, window.expired ? `Expired reading · last ${format(window.remainingPercent)}% left` : `${format(window.remainingPercent)}% left`, window.stale);
    details.append(element('div', `${window.label} · Observed ${time(window.observedAt)}${window.resetsAt ? ` · Resets ${time(window.resetsAt)}` : ''}`, 'usage-detail'));
  }
  if (usage?.limits?.length) details.append(element('div', 'Allowance is shared by sessions on that account; it is not a token balance.', 'usage-detail'));
  details.append(element('div', usage ? `Host reported · ${usage.source} · Session ${usage.sessionId.slice(0, 8)}` : 'No host telemetry connected for this agent.', 'usage-detail'));
  const guide = element('a', 'Usage setup and meaning', 'text-action'); guide.href = '#how-to-use'; details.append(guide); panel.append(details);
  return panel;
}
function renderAgents() {
  const filter = $('project-filter').value;
  const agents = snapshot.agents.filter(agent => !filter || agent.project === filter);
  const expandedUsage = new Set([...$('agents').querySelectorAll('details[open]')].map(node => node.dataset.agentUsage));
  $('agents').replaceChildren();
  if (!agents.length) empty($('agents'), 'No agents yet. Register one below or use add-agent.');
  for (const agent of agents) {
    const card = element('div', undefined, 'agent-card');
    const title = element('div', undefined, 'agent-title');
    title.append(element('span', agent.name.slice(0, 2).toUpperCase(), 'avatar'), element('span', agent.name));
    card.append(title, element('div', `${agent.project} · ${agent.provider} / ${agent.model}`, 'agent-meta'));
    card.append(element('div', `Requested effort: ${agent.reasoningEffort || 'default'} · Session settings are not verified`, 'agent-meta'));
    card.append(renderUsage(agent.usage, agent.name, expandedUsage.has(agent.name)));
    const worker=snapshot.workers?.find(item=>item.agent===agent.name);
    if(worker)card.append(element('div',`Automatic worker: ${worker.state} · ${worker.provider}`, 'agent-meta'));
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
  if(message.worker){
    footer.append(element('span',`Worker: ${message.worker.state}`));
    if(message.worker.error)footer.append(element('span',message.worker.error));
    if(['failed','blocked','interrupted'].includes(message.worker.state))footer.append(action('Retry worker task',async()=>{await api(`/api/worker-jobs/${message.id}/retry`,'POST');await refresh();}));
  }
  if (message.handoff) footer.append(action(`Handoff: ${message.handoff.state}`, () => openHandoff(message.handoff.id)));
  if (!inThread) {
    const button = action('View conversation', () => openThread(message.conversation_id));
    button.dataset.conversation = message.conversation_id; footer.append(button);
  }
  if (message.recipient === '@human') {
    footer.append(action('Reply', () => {
      closeThread();
      replyTo = message.id; $('compose-title').textContent = `Reply to ${message.sender}`;
      $('message-project').value = message.project; fillRecipients(); $('recipient').value = message.sender;
      $('message-project').disabled = true; $('recipient').disabled = true; $('question').disabled = true; $('question').checked = false;
      $('cancel-reply').hidden = false; sendKey = crypto.randomUUID(); $('body').focus();
    }));
    if (!message.acknowledged_at) footer.append(action('Acknowledge', async () => { await api(`/api/messages/${message.id}/ack`, 'POST'); await refresh(); }));
  }
  card.append(route, markdownBody(message.body, inThread), footer);
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
    renderAgents(); fillRecipients(); renderWorkers();
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
  closeThread();
  const panel = $('handoff-detail'); panel.replaceChildren();
  panel.append(element('p', `${item.sender} → ${item.recipient} · ${item.state}`, 'fw-semibold'), element('h3', item.packet.objective, 'h6'), markdownBody(item.packet.context, true));
  panel.append(element('p', `Workspace reference: ${item.packet.workspaceRef}`, 'small text-secondary evidence-hash'));
  for (const [label, field] of [['Completed before transfer', 'completed'], ['Remaining at transfer', 'remaining'], ['Next steps', 'nextSteps']]) {
    panel.append(element('h3', label, 'h6 mt-3'));
    const list = element('ul', undefined, 'small');
    for (const entry of item.packet[field]) { const row = element('li'); row.append(markdownBody(entry)); list.append(row); }
    panel.append(list);
  }
  panel.append(element('h3', 'Transferred evidence', 'h6 mt-3'));
  for (const entry of item.evidence) panel.append(evidenceLink(entry));
  for (const update of item.updates) { panel.append(element('h4', update.state, 'h6 mt-3'), markdownBody(update.note)); }
  if (item.completionEvidence.length) {
    panel.append(element('h3', 'Result evidence', 'h6 mt-3'));
    for (const entry of item.completionEvidence) panel.append(evidenceLink(entry));
  }
  panel.append(element('p', 'Review and completion are agent claims. Checksums verify transferred bytes; they do not prove the claims are correct.', 'panel-footnote mt-3'));
  $('handoff-panel').hidden = false;
  $('handoff-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function workerProviderForAgent(){
  const agent=snapshot?.agents.find(item=>item.name===$('worker-agent').value);
  if(agent&&/claude|anthropic/i.test(agent.provider))$('worker-provider').value='claude';
  else if(agent&&/codex|openai/i.test(agent.provider))$('worker-provider').value='codex';
  fillWorkerDependencies();
}
function fillWorkerDependencies(){
  const selected=$('worker-dependency').value;
  const agent=snapshot?.agents.find(item=>item.name===$('worker-agent').value);
  const peers=snapshot?.agents.filter(item=>item.enabled&&item.project===agent?.project&&item.name!==agent?.name)||[];
  const current=[...$('worker-dependency').options].slice(1).map(option=>option.value);
  if(current.length!==peers.length||current.some((name,index)=>name!==peers[index].name)){
    $('worker-dependency').replaceChildren(new Option('Start independently',''),...peers.map(item=>new Option(item.name,item.name)));
    if(peers.some(item=>item.name===selected))$('worker-dependency').value=selected;
  }
}
function renderWorkers(){
  const selected=$('worker-agent').value;
  const agents=snapshot.agents.filter(item=>item.enabled);
  const options=[...$('worker-agent').options];
  if(options.length!==agents.length||options.some((item,index)=>item.value!==agents[index]?.name)){
    $('worker-agent').replaceChildren(...agents.map(item=>new Option(`${item.name} · ${item.project}`,item.name)));
    if(agents.some(item=>item.name===selected))$('worker-agent').value=selected;
    else workerProviderForAgent();
  }
  $('worker-form').querySelector('button[type="submit"]').disabled=!agents.length;
  fillWorkerDependencies();
  $('automatic-workers').replaceChildren();
  for(const worker of snapshot.workers||[]){
    const row=element('div',undefined,'worker-row mb-3 p-3 border rounded');
    row.append(element('strong',`${worker.agent} · ${worker.provider} · ${worker.state}`),element('div',`${worker.processed}/${worker.maxJobs} tasks · ${worker.workspace||'Messages/evidence only'}`,'small text-secondary mt-1'));
    if(worker.error)row.append(element('p',worker.error,'small mt-2 mb-0'));
    if(worker.waitForAgent)row.append(element('div',`Waits for: ${worker.waitForAgent}`,'small text-secondary'));
    if(worker.state!=='stopped')row.append(action('Stop worker',async()=>{await api(`/api/workers/${worker.agent}/stop`,'POST');await refresh();}));
    $('automatic-workers').append(row);
  }
}
$('worker-agent').addEventListener('change',workerProviderForAgent);
$('worker-form').addEventListener('submit',event=>{
  event.preventDefault();const button=event.submitter;
  run(async()=>{button.disabled=true;try{
    await api('/api/workers','POST',{agent:$('worker-agent').value,provider:$('worker-provider').value,...($('worker-workspace').value.trim()?{workspace:$('worker-workspace').value.trim()}:{}),...($('worker-dependency').value?{waitForAgent:$('worker-dependency').value}:{}),maxJobs:Number($('worker-max-jobs').value)});
    await refresh();
  }finally{button.disabled=false;}});
});
async function openThread(id) {
  threadTrigger = document.activeElement;
  threadId = id; threadCursor = 0; $('thread').replaceChildren(); $('thread-more').hidden = true;
  const message = snapshot?.messages.find(item => item.conversation_id === id);
  $('thread-description').textContent = message ? `${message.sender} ↔ ${message.recipient} · ${message.project}` : 'Messages in this conversation';
  if (!$('thread-panel').open) $('thread-panel').showModal();
  document.body.classList.add('conversation-open');
  await moreThread();
}
function closeThread() {
  if (!$('thread-panel').open) return;
  const closedId = threadId;
  threadId = undefined; threadRequest++;
  $('thread-panel').close(); document.body.classList.remove('conversation-open');
  const trigger = threadTrigger?.isConnected ? threadTrigger : [...$('messages').querySelectorAll('[data-conversation]')].find(button => button.dataset.conversation === closedId);
  (trigger || $('refresh')).focus(); threadTrigger = undefined;
}
async function moreThread() {
  if (!threadId) return;
  const id = threadId, requestId = ++threadRequest;
  $('thread-more').disabled = true;
  $('thread-status').textContent = 'Loading conversation…'; $('thread-status').hidden = false;
  try {
    const data = await api(`/api/conversations/${id}?after=${threadCursor}&limit=50`);
    if (requestId !== threadRequest || threadId !== id) return;
    $('thread').append(...data.items.map(message => messageCard(message, true)));
    if (!data.items.length && !threadCursor) empty($('thread'), 'No messages in this conversation.');
    threadCursor = data.nextCursor; $('thread-more').hidden = data.items.length < 50;
    $('thread-more').textContent = 'Load more'; $('thread-status').hidden = true;
  } catch (failure) {
    if (requestId !== threadRequest || threadId !== id) return;
    $('thread-status').textContent = `Unable to load conversation: ${failure.message}`;
    $('thread-more').textContent = 'Retry'; $('thread-more').hidden = false;
  } finally { if (requestId === threadRequest) $('thread-more').disabled = false; }
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
  hideLocalToken();
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
$('close-thread').addEventListener('click', closeThread);
$('thread-panel').addEventListener('cancel', event => { event.preventDefault(); closeThread(); });
$('thread-panel').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...$('thread-panel').querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')].filter(node => node.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
$('thread-panel').addEventListener('click', event => {
  if (event.target !== $('thread-panel')) return;
  const bounds = $('thread-panel').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeThread();
});
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
function hideLocalToken() {
  localTokenRequest++;
  $('local-admin-token').value = ''; $('local-token-panel').hidden = true;
  $('show-admin-token').textContent = "Show this hub's admin token";
}
async function copySignInText(value, message) {
  try { await navigator.clipboard.writeText(value); $('sign-in-status').textContent = message; }
  catch { $('sign-in-status').textContent = 'Select the text and copy it manually; clipboard access is unavailable.'; }
}
$('copy-admin-command').addEventListener('click', () => copySignInText($('admin-token-command').textContent, 'Terminal command copied. Run it on this Mac and paste the returned token above.'));
$('copy-admin-token').addEventListener('click', () => copySignInText($('local-admin-token').value, 'Admin token copied.'));
$('use-admin-token').addEventListener('click', () => { $('token').value = $('local-admin-token').value; hideLocalToken(); $('token').focus(); $('sign-in-status').textContent = 'Token filled. Click Open dashboard to sign in.'; });
$('show-admin-token').addEventListener('click', async () => {
  if (!$('local-token-panel').hidden) { hideLocalToken(); $('sign-in-status').textContent = 'Token hidden.'; return; }
  $('show-admin-token').disabled = true;
  const requestId = ++localTokenRequest;
  try {
    const response = await fetch('/api/local-admin-token', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMH-Local-Access': 'show-token' }, body: JSON.stringify({ action: 'show' }), signal: AbortSignal.timeout(8000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to show this hub token');
    if (requestId !== localTokenRequest || $('login-panel').hidden) return;
    $('local-admin-token').value = result.adminToken; $('local-token-panel').hidden = false;
    $('show-admin-token').textContent = 'Hide admin token'; $('sign-in-status').textContent = 'Token shown for this hub only.';
  } catch (failure) { if (requestId === localTokenRequest) $('sign-in-status').textContent = failure.message; }
  finally { $('show-admin-token').disabled = false; }
});
async function loadSignInHelp() {
  try {
    const response = await fetch('/api/sign-in', {signal:AbortSignal.timeout(8000)});
    if (!response.ok) return;
    const help = await response.json();
    $('admin-token-command').textContent = help.adminTokenCommand;
    $('sign-in-hub').textContent = `Hub: ${help.hubUrl}`;
    $('show-admin-token').hidden = !help.localAdminAccess;
    $('sign-in-status').textContent = help.localAdminAccess ? 'Local token display is enabled for this hub.' : 'For local token display, start this hub with --local-admin-access.';
  } catch { $('sign-in-status').textContent = 'Use the Terminal command with this hub’s data directory to retrieve its token.'; }
}
void loadSignInHelp();
if (token) run(login);
