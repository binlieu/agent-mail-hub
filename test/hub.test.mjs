import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { initialize, loadConfig, dataDirectory, writePrivate } from '../dist/config.js';
import { startHub } from '../dist/server.js';
import { messageSchema } from '../dist/contracts.js';

const root = resolve('.test-data');
mkdirSync(root, { recursive: true });
function directory() { return mkdtempSync(join(root, 'hub-')); }
async function fixture() {
  const dir = directory();
  const config = initialize(dir);
  const hub = await startHub(dir, config, 0);
  const admin = { role: 'admin' };
  const create = (name, project = 'alpha') => hub.store.createAgent(admin, { name, project, provider: 'simulated', model: 'test', capabilities: [] });
  const a = create('alice'); const b = create('bob'); const c = create('carol'); const other = create('outsider', 'beta');
  async function api(token, path, method = 'GET', body, headers = {}) {
    const response = await fetch(hub.url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  return { dir, config, hub, a, b, c, other, api, admin };
}
function message(to, key = randomUUID(), body = 'Hello') { return { to, body, kind: 'question', idempotencyKey: key }; }

test('local sign-in token display is explicit, opt-in and limited to same-origin requests', async () => {
  const dir = directory(); const config = initialize(dir);
  let hub = await startHub(dir, config, 0);
  const show = (headers = {}) => fetch(hub.url + '/api/local-admin-token', { method:'POST', headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin','X-AMH-Local-Access':'show-token',...headers}, body:JSON.stringify({action:'show'}) });
  try {
    const help = await (await fetch(hub.url + '/api/sign-in')).json();
    assert.equal(help.localAdminAccess, false);
    assert.ok(help.adminTokenCommand.includes(dir));
    assert.ok(!JSON.stringify(help).includes(config.adminToken));
    assert.equal((await show()).status,403);
    await hub.close(); hub = await startHub(dir,config,0,{localAdminAccess:true});
    const response = await show();
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.json()).adminToken,config.adminToken);
    assert.equal((await show({'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await show({'X-AMH-Local-Access':'wrong'})).status,403);
    assert.equal((await show({Origin:'https://example.com'})).status,403);
    assert.equal((await fetch(hub.url+'/api/local-admin-token')).status,401);
    assert.ok(!(await (await fetch(hub.url)).text()).includes(config.adminToken));
    assert.equal((await fetch(hub.url+'/api/agents')).status,401);
  } finally { await hub.close(); }
});

test('requested model preferences validate supported effort and survive restart', async () => {
  const f = await fixture();
  let closed = false;
  try {
    assert.equal((await f.api('invalid', '/api/model-options')).status, 401);
    const catalog = await f.api(f.config.adminToken, '/api/model-options');
    assert.deepEqual(catalog.data.providers.map(item => item.id), ['claude', 'codex']);
    const register = (name, provider, model, reasoningEffort) => f.api(f.config.adminToken, '/api/agents', 'POST', { name, provider, model, reasoningEffort });
    assert.equal((await register('codex-high', 'codex', 'gpt-6-luna', 'high')).status, 201);
    assert.equal((await register('claude-high', 'claude', 'sonnet', 'high')).status, 201);
    assert.equal((await register('custom', 'claude', 'custom-model', 'default')).status, 201);
    assert.equal((await register('invalid-luna', 'codex', 'gpt-6-luna', 'ultra')).status, 400);
    assert.equal((await register('invalid-claude', 'claude', 'opus', 'ultra')).status, 400);
    assert.equal((await register('invalid-custom', 'claude', 'unknown', 'high')).status, 400);
    assert.equal((await register('invalid-provider', 'other', 'unknown', 'default')).status, 400);
    await f.hub.close(); closed = true;
    const restarted = await startHub(f.dir, loadConfig(f.dir), 0);
    try {
      const agents = restarted.store.listAgents(f.admin);
      assert.equal(agents.find(item => item.name === 'codex-high').reasoningEffort, 'high');
      assert.equal(agents.find(item => item.name === 'claude-high').configurationStatus, 'requested');
      assert.equal(agents.find(item => item.name === 'alice').reasoningEffort, 'default');
      assert.ok(!agents.some(item => item.name.startsWith('invalid-')));
    } finally { await restarted.close(); }
  } finally { if (!closed) await f.hub.close(); }
});

test('durable inbox, explicit acknowledgement, reply correlation, retries and restart', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const sent = await f.api(f.a.token, '/api/messages', 'POST', message('bob', 'stable-key'));
    assert.equal(sent.status, 201); assert.equal(sent.data.status, 'queued');
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => f.api(f.a.token, '/api/messages', 'POST', message('bob', 'stable-key'))));
    assert.ok(duplicates.every(result => result.data.id === sent.data.id));
    assert.equal(f.hub.store.dashboard(f.admin, { after: 0, limit: 50 }).totalMessages, 1);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', message('bob', 'stable-key', 'Different'))).status, 409);
    const inbox = await f.api(f.b.token, '/api/inbox?after=0&limit=1');
    assert.equal(inbox.data.items.length, 1); assert.equal(inbox.data.items[0].status, 'delivered');
    assert.equal(inbox.data.items[0].acknowledged_at, null);
    assert.equal((await f.api(f.b.token, `/api/inbox?after=${inbox.data.nextCursor}`)).data.items.length, 0);
    assert.equal((await f.api(f.a.token, `/api/messages/${sent.data.id}/ack`, 'POST')).status, 403);
    assert.equal((await f.api(f.b.token, `/api/messages/${sent.data.id}/ack`, 'POST')).data.status, 'acknowledged');
    const reply = await f.api(f.b.token, '/api/messages', 'POST', { ...message('alice'), kind: 'message', replyTo: sent.data.id });
    assert.equal(reply.status, 201); assert.equal(reply.data.conversation_id, sent.data.conversation_id);
    assert.equal((await f.api(f.a.token, `/api/messages/${sent.data.id}`)).data.status, 'answered');
    f.hub.store.setPaused(f.admin, true);
    await f.hub.close(); closed = true;
    const restarted = await startHub(f.dir, loadConfig(f.dir), 0);
    try {
      assert.equal(restarted.store.paused(), true);
      restarted.store.setPaused(f.admin, false);
      assert.equal(restarted.store.status({ role: 'agent', name: 'alice', project: 'alpha' }, sent.data.id).status, 'answered');
      assert.equal(restarted.store.inbox({ role: 'agent', name: 'alice', project: 'alpha' }, { after: 0, limit: 50 }).items[0].id, reply.data.id);
      assert.equal(restarted.store.dashboard(f.admin, { after: 0, limit: 50 }).totalMessages, 2);
    } finally { await restarted.close(); }
  } finally { if (!closed) await f.hub.close(); }
});

test('credentials bind identity; project and participant boundaries reject unauthorized access', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api('bad-token', '/api/agents')).status, 401);
    assert.equal((await f.api(f.a.token, '/api/agents', 'POST', { name: 'fake' })).status, 403);
    assert.equal((await f.api(f.a.token, '/api/dashboard')).status, 403);
    assert.equal((await f.api(f.a.token, '/api/pause', 'POST', { paused: true })).status, 403);
    const visible = await f.api(f.a.token, '/api/agents');
    assert.deepEqual(visible.data.items.map(a => a.name), ['alice', 'bob', 'carol']);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', { ...message('bob'), sender: 'carol' })).status, 400);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', message('outsider'))).status, 404);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', message('alice'))).status, 400);
    const sent = await f.api(f.a.token, '/api/messages', 'POST', message('bob'));
    assert.equal((await f.api(f.other.token, `/api/messages/${sent.data.id}`)).status, 404);
    assert.equal((await f.api(f.c.token, `/api/messages/${sent.data.id}`)).status, 404);
    assert.equal((await f.api(f.c.token, `/api/conversations/${sent.data.conversation_id}`)).data.items.length, 0);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', { ...message('bob'), replyTo: sent.data.id })).status, 403);
    const sessionId = randomUUID();
    assert.equal((await f.api(f.a.token, '/api/heartbeat', 'POST', { sessionId, host: 'test' })).status, 200);
    assert.equal((await f.api(f.b.token, '/api/heartbeat', 'POST', { sessionId, host: 'test' })).status, 409);
    const disabled = await f.api(f.config.adminToken, '/api/agents/alice', 'PATCH', { enabled: false });
    assert.equal(disabled.status, 200); assert.equal((await f.api(f.a.token, '/api/me')).status, 401);
    assert.equal((await f.api(f.b.token, '/api/messages', 'POST', message('alice'))).status, 404);
    assert.ok(f.hub.store.db.prepare('SELECT token_hash FROM agents').all().every(row => ![f.a.token, f.b.token].includes(row.token_hash)));
  } finally { await f.hub.close(); }
});

test('human sends and replies; pause persists and does not lose messages', async () => {
  const f = await fixture();
  try {
    const human = await f.api(f.config.adminToken, '/api/messages', 'POST', { ...message('alice'), project: 'alpha' });
    assert.equal(human.data.sender, '@human');
    const reply = await f.api(f.a.token, '/api/messages', 'POST', { ...message('@human'), replyTo: human.data.id });
    assert.equal(reply.status, 201);
    assert.equal((await f.api(f.config.adminToken, `/api/messages/${reply.data.id}/ack`, 'POST')).status, 200);
    const response = await f.api(f.config.adminToken, '/api/messages', 'POST', { ...message('alice'), project: 'alpha', replyTo: reply.data.id });
    assert.equal(response.status, 201); assert.equal(response.data.conversation_id, human.data.conversation_id);
    assert.equal((await f.api(f.config.adminToken, '/api/pause', 'POST', { paused: true })).status, 200);
    assert.equal((await f.api(f.a.token, '/api/inbox')).status, 503);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', message('bob'))).status, 503);
    // A completed idempotent retry remains resolvable while paused.
    const repeated = await f.api(f.config.adminToken, '/api/messages', 'POST', { ...message('alice', human.data.idempotency_key), project: 'alpha' });
    assert.equal(repeated.data.id, human.data.id);
    assert.equal(f.hub.store.paused(), true);
    await f.api(f.config.adminToken, '/api/pause', 'POST', { paused: false });
    assert.equal((await f.api(f.a.token, '/api/inbox')).data.items.length, 2);
  } finally { await f.hub.close(); }
});

test('HTTP rejects cross-origin access, unsafe host, oversized payloads and invalid input', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api(f.a.token, '/api/me', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
    const unsafeHost = await new Promise((resolve, reject) => {
      const req = httpRequest(f.hub.url + '/api/me', { headers: { Host: 'evil.example', Authorization: `Bearer ${f.a.token}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(unsafeHost, 403);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', { ...message('bob'), body: 'x'.repeat(150000) })).status, 413);
    assert.equal((await f.api(f.a.token, '/api/messages', 'POST', { ...message('bob'), body: '' })).status, 400);
    assert.equal((await f.api(f.a.token, '/api/inbox?limit=999')).status, 400);
    assert.equal((await f.api(f.a.token, '/api/inbox?after=-1')).status, 400);
    const malformed = await fetch(f.hub.url + '/api/messages', { method: 'POST', headers: { Authorization: `Bearer ${f.a.token}`, 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(malformed.status, 400);
    const asset = await fetch(f.hub.url + '/');
    assert.equal(asset.status, 200); assert.match(asset.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(asset.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(f.hub.url + '/vendor/bootstrap.min.css')).status, 200);
    assert.equal((await fetch(f.hub.url + '/config.json')).status, 404);
    assert.equal((await fetch(f.hub.url + '/%2e%2e/src/config.ts')).status, 404);
  } finally { await f.hub.close(); }
});

test('setup isolation, permissions, namespace protection and occupied port', async () => {
  const dir = directory(); const config = initialize(dir);
  assert.equal(initialize(dir).instanceId, config.instanceId);
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.throws(() => dataDirectory('/tmp/.a2a-talk/new'), /separate/);
  assert.throws(() => dataDirectory('/tmp/chi-harness/new'), /separate/);
  const unrelated = directory(); writeFileSync(join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => initialize(unrelated), /empty/);
  assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  const legacy = join(directory(), '.a2a-talk'); mkdirSync(legacy);
  const alias = join(directory(), 'alias'); symlinkSync(legacy, alias);
  assert.throws(() => dataDirectory(join(alias, 'child')), /separate/);
  const occupied = createServer((_req, res) => res.end('existing service'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(startHub(dir, config, occupied.address().port), { code: 'EADDRINUSE' });
    assert.equal(await (await fetch(`http://127.0.0.1:${occupied.address().port}`)).text(), 'existing service');
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('bounded inbox and dashboard pagination remain complete', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 105; i++) f.hub.store.send({ role: 'agent', name: 'alice', project: 'alpha' }, messageSchema.parse(message('bob', `page-${i}`)));
    let after = 0; const ids = new Set();
    while (true) {
      const result = await f.api(f.b.token, `/api/inbox?after=${after}&limit=40`);
      result.data.items.forEach(item => ids.add(item.id));
      after = result.data.nextCursor;
      if (result.data.items.length < 40) break;
    }
    assert.equal(ids.size, 105);
    const first = await f.api(f.config.adminToken, '/api/dashboard?limit=60');
    const second = await f.api(f.config.adminToken, `/api/dashboard?limit=60&before=${first.data.nextBefore}`);
    assert.equal(first.data.messages.length, 60); assert.equal(second.data.messages.length, 45);
    assert.equal(new Set([...first.data.messages, ...second.data.messages].map(m => m.id)).size, 105);
    assert.equal((await f.api(f.config.adminToken, '/api/dashboard?project=beta')).data.messages.length, 0);
  } finally { await f.hub.close(); }
});

test('two real MCP stdio clients exchange a question and reply with fourteen tools', async () => {
  const f = await fixture();
  const clients = []; const transports = [];
  try {
    for (const agent of [f.a, f.b]) {
      const file = join(f.dir, 'credentials', agent.name + '.json');
      writePrivate(file, { version: 1, instanceId: f.config.instanceId, url: f.hub.url, name: agent.name, project: agent.project, token: agent.token });
      const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp', '--credentials', file], stderr: 'pipe' });
      transports.push(transport);
      const client = new Client({ name: `test-${agent.name}`, version: '1.0.0' }); clients.push(client);
      await client.connect(transport);
    }
    const tools = await clients[0].listTools(); assert.equal(tools.tools.length, 14);
    const call = async (index, name, args) => {
      const result = await clients[index].callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const visible = await call(0, 'list_agents', {}); assert.equal(visible.items.find(a => a.name === 'alice').connected, true);
    const sent = await call(0, 'send_message', message('bob'));
    assert.equal((await call(1, 'read_inbox', {})).items[0].id, sent.id);
    await call(1, 'ack_message', { messageId: sent.id });
    const reply = await call(1, 'reply_message', { messageId: sent.id, body: 'It works.', idempotencyKey: 'mcp-reply' });
    assert.equal((await call(0, 'read_inbox', {})).items[0].id, reply.id);
    await call(0, 'ack_message', { messageId: reply.id });
    assert.equal((await call(0, 'get_message_status', { messageId: sent.id })).status, 'answered');
    assert.equal((await call(0, 'get_conversation', { conversationId: sent.conversation_id })).items.length, 2);
    const denied = await clients[0].callTool({ name: 'send_message', arguments: message('outsider') }); assert.equal(denied.isError, true);
    await Promise.all(clients.map(c => c.close()));
    assert.equal(f.hub.store.listAgents(f.admin).find(a => a.name === 'alice').connected, false);
  } finally {
    await Promise.allSettled(clients.map(c => c.close()));
    await Promise.allSettled(transports.map(t => t.close()));
    await f.hub.close();
  }
});

test('legacy 2025 MCP handshake works without protocol noise on stdout', async () => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const f = await fixture();
  const file = join(f.dir, 'credentials', 'legacy.json');
  writePrivate(file, { version: 1, instanceId: f.config.instanceId, url: f.hub.url, name: f.a.name, project: f.a.project, token: f.a.token });
  const child = spawn(process.execPath, [resolve('dist/cli.js'), 'mcp', '--credentials', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  const malformed = [];
  lines.on('line', line => {
    try { const message = JSON.parse(line); pending.get(message.id)?.(message); }
    catch { malformed.push(line); }
  });
  let requestId = 0;
  function rpc(method, params) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Legacy MCP request timed out')); }, 5000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const opening = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } });
    assert.equal(opening.result.protocolVersion, '2025-11-25');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await rpc('tools/list', {}); assert.equal(tools.result.tools.length, 14);
    const result = await rpc('tools/call', { name: 'list_agents', arguments: {} });
    assert.equal(JSON.parse(result.result.content[0].text).items.length, 3);
    assert.deepEqual(malformed, []);
  } finally {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
    lines.close(); await f.hub.close();
  }
});

test('wrong hub instance never receives a credential', async () => {
  const { verifyHub } = await import('../dist/http-client.js');
  const authorization = [];
  const server = createServer((req, res) => { authorization.push(req.headers.authorization); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'unrelated', instanceId: randomUUID() })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(verifyHub(`http://127.0.0.1:${server.address().port}`, randomUUID()), /not your configured/);
    assert.deepEqual(authorization, [undefined]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
