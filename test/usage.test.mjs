import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUsage, presentUsage, readUsageFile, readCodexAccountLimits, codexLimits } from '../dist/usage.js';
import { initialize, writePrivate } from '../dist/config.js';
import { startHub } from '../dist/server.js';

const exec = promisify(execFile);
const at = new Date().toISOString();
const id = randomUUID();
const log = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const claude = (overrides = {}) => ({ session_id: id,
  context_window: { context_window_size: 200000, used_percentage: 25, current_usage: { input_tokens: 10000, cache_creation_input_tokens: 15000, cache_read_input_tokens: 25000, output_tokens: 999 }, total_input_tokens: 90000, total_output_tokens: 10000 },
  rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 3600 } }, ...overrides });
const tokenEvent = (overrides = {}) => ({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { model_context_window: 100000, last_token_usage: { total_tokens: 20000 }, total_token_usage: { total_tokens: 90000 } }, rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 } }, ...overrides } });

test('Claude context excludes output; missing/zero usage and allowance stay distinct', () => {
  const report = parseUsage('claude', JSON.stringify(claude()), id, at);
  assert.equal(report.context.usedTokens, 50000);
  assert.equal(report.context.usedPercent, 25);
  assert.equal(report.sessionTokens, 100000);
  assert.equal(presentUsage(report, at).limits[0].remainingPercent, 80);
  assert.equal(presentUsage(report, at).context.remainingTokens, 150000);
  const missing = parseUsage('claude', JSON.stringify(claude({ context_window: {}, rate_limits: {} })), id, at);
  assert.equal(missing.context, null); assert.deepEqual(missing.limits, []); assert.equal(missing.sessionTokens, null);
  const zero = parseUsage('claude', JSON.stringify(claude({ context_window: { used_percentage: 0 }, rate_limits: { five_hour: { used_percentage: 0 } } })), id, at);
  assert.equal(zero.context.usedPercent, 0); assert.equal(presentUsage(zero, at).limits[0].remainingPercent, 100);
  assert.throws(() => parseUsage('claude', JSON.stringify(claude()), randomUUID(), at), /session ID/);
  assert.ok(!JSON.stringify(report).includes('output_tokens'));
});

test('Codex uses latest context, never sums cumulative token_count records or borrows a foreign session', () => {
  const header = { type: 'session_meta', payload: { id } };
  const events = [header, tokenEvent(), tokenEvent({ info: { model_context_window: 100000, last_token_usage: { total_tokens: 10000 }, total_token_usage: { total_tokens: 100000 } } }), tokenEvent({ session_id: randomUUID() })];
  const report = parseUsage('codex', log(events) + '{"partial":', id, at);
  assert.equal(report.context.usedPercent, 10); assert.equal(report.sessionTokens, 100000);
  assert.equal(report.limits[0].usedPercent, 40);
  assert.throws(() => parseUsage('codex', log([{ type: 'session_meta', payload: { id: randomUUID() } }, header, tokenEvent()]), id, at), /another session/);
  const execReport = parseUsage('codex', log([{ type: 'thread.started', thread_id: id }, { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 10 } }]), id, at);
  assert.equal(execReport.context, null); assert.equal(execReport.sessionTokens, 60); assert.equal(execReport.source, 'codex-exec');
});

test('stale context and expired limits never become fresh merely by republishing a log', () => {
  const old = new Date(Date.now() - 600000).toISOString();
  const report = parseUsage('claude', JSON.stringify(claude({ rate_limits: { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) - 1 } } })), id, old);
  const display = presentUsage(report, at);
  assert.equal(display.stale, true); assert.equal(display.context.stale, true);
  assert.equal(display.limits[0].expired, true); assert.equal(display.limits[0].remainingPercent, 0);
});

test('large log polling is bounded and preserves the original owner', () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/usage-log-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, log([{ type: 'session_meta', payload: { id } }]) + (' '.repeat(1000) + '\n').repeat(4500) + log([tokenEvent()]));
  const input = readUsageFile(file);
  assert.ok(input.text.length < 4200000);
  assert.equal(parseUsage('codex', input.text, id, input.observedAt).context.usedPercent, 20);
});

test('read-only account reader requests no resets or turns and prefers multiple limit buckets', async () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/usage-rpc-'));
  const file = join(dir, 'fake-codex.mjs'), calls = join(dir, 'calls.jsonl');
  writeFileSync(file, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message)+'\\n');
 if(message.id===1) console.log(JSON.stringify({id:1,result:{}}));
 if(message.id===2) console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:2000000000}},other:{secondary:{usedPercent:15,windowDurationMins:10080}}},rateLimitResetCredits:{secret:'DO_NOT_FORWARD'}}}));
}
`, {mode:0o700}); chmodSync(file,0o700);
  const windows = await readCodexAccountLimits(file);
  assert.equal(windows.length, 2); assert.equal(windows[0].usedPercent, 0); assert.equal(windows[1].usedPercent, 15);
  assert.ok(!JSON.stringify(windows).includes('DO_NOT_FORWARD'));
  const messages = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(messages.map(item => item.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(messages[2].params, { excludeResetCreditDetails: true });
  assert.equal(codexLimits({rateLimitsByLimitId:{},rateLimits:{primary:{usedPercent:25}}}, at)[0].usedPercent,25);
});

test('Claude stream context capacity follows the actual last model, not a different model in the run', () => {
  const events = [{type:'system',session_id:id}, {type:'assistant',session_id:id,message:{model:'coding',usage:{input_tokens:1000,cache_read_input_tokens:9000,output_tokens:999}}}, {type:'result',session_id:id,modelUsage:{other:{contextWindow:1000000},coding:{contextWindow:100000}},usage:{input_tokens:1000,output_tokens:500}}];
  const report = parseUsage('claude-stream',log(events),id,at);
  assert.equal(report.context.usedTokens,10000); assert.equal(report.context.usedPercent,10);
});

test('usage CLI to HTTP to durable directory is identity-bound, private and survives restart', async () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/usage-hub-'));
  const config = initialize(dir); let hub = await startHub(dir, config, 0);
  try {
    const admin = { role: 'admin' };
    const create = (name, project) => hub.store.createAgent(admin, { name, project, provider: 'claude', model: 'default', capabilities: [] });
    const a = create('usage-agent', 'alpha'), b = create('other-agent', 'beta');
    const credentials = { version: 1, instanceId: config.instanceId, url: hub.url, name: a.name, project: a.project, token: a.token };
    const credentialFile = join(dir, 'credentials.json'); writePrivate(credentialFile, credentials);
    const file = join(dir, 'status.json');
    writeFileSync(file, JSON.stringify(claude({ prompt: 'PRIVATE_PROMPT_SENTINEL', api_key: 'PRIVATE_SECRET_SENTINEL' })));
    const cli = ['dist/cli.js', 'usage', '--credentials', credentialFile, '--source', 'claude', '--input', file, '--session-id', id];
    // A session must be explicitly linked; the agent credential controls the destination.
    await exec(process.execPath, cli);
    const own = hub.store.listAgents({ role: 'agent', name: a.name, project: a.project });
    assert.equal(own[0].usage.context.usedPercent, 25);
    assert.ok(!JSON.stringify(own).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(own).includes(file));
    assert.equal(hub.store.listAgents({ role: 'agent', name: b.name, project: b.project })[0].usage, null);
    const post = (token, body) => fetch(hub.url + '/api/usage', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const report = parseUsage('claude', JSON.stringify(claude()), id, at);
    assert.equal((await post(config.adminToken, report)).status, 403);
    assert.equal((await post(a.token, { ...report, agent: b.name })).status, 400);
    assert.equal((await post(a.token, { ...report, observedAt: new Date(Date.now() + 3600000).toISOString() })).status, 400);
    assert.equal((await post(a.token, { ...report, observedAt: '2020-01-01T00:00:00.000Z' })).status, 409);
    assert.equal((await post(a.token, { ...report, context: { ...report.context, usedPercent: -1 } })).status, 400);
    assert.equal((await post(a.token, { ...report, provider: 'codex', source: 'codex-session' })).status, 409);
    const dbText = JSON.stringify(hub.store.db.prepare("SELECT value FROM meta WHERE key LIKE 'agent_usage:%'").all());
    assert.ok(!dbText.includes('PRIVATE_')); assert.ok(!dbText.includes(a.token));
    const result = await exec(process.execPath, [...cli.slice(0, -1), randomUUID()]).catch(error => error);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /session ID/);
    assert.ok(!result.stdout.includes('PRIVATE_'));
    assert.ok(readFileSync(file, 'utf8').includes('PRIVATE_PROMPT_SENTINEL'), 'Source file stays unchanged');
    await hub.close(); hub = await startHub(dir, config, 0);
    assert.equal(hub.store.listAgents(admin).find(item => item.name === a.name).usage.context.remainingPercent, 75);
  } finally { await hub.close(); }
});
