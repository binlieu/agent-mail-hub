import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialize, writePrivate } from '../dist/config.js';
import { startHub } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function fixture() {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/collaboration-'));
  const config = initialize(dir); const hub = await startHub(dir, config, 0);
  const agents = {};
  for (const [name, project] of [['sender', 'alpha'], ['receiver', 'alpha'], ['bystander', 'alpha'], ['outsider', 'beta']]) {
    agents[name] = hub.store.createAgent({ role: 'admin' }, { name, project, model: 'test', provider: 'simulated', capabilities: ['handoff', 'evidence'] });
  }
  async function api(name, path, method = 'GET', input) {
    const response = await fetch(hub.url + path, { method, headers: { Authorization: `Bearer ${name === 'admin' ? config.adminToken : agents[name].token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, body: input ? JSON.stringify(input) : undefined });
    return { status: response.status, data: await response.json() };
  }
  return { dir, config, hub, agents, api };
}
const evidence = (key = 'proof-1') => ({ filename: 'checks.json', content: '{"checks":[3,5,8],"total":16}', encoding: 'utf8', mediaType: 'application/json', sourceRef: 'scratch://sender/checks.json', idempotencyKey: key });
const packet = (evidenceId, key = 'handoff-1') => ({ to: 'receiver', objective: 'Independently verify the arithmetic', context: 'Source data is included as immutable evidence. No filesystem access is required.', completed: ['Prepared sample input'], remaining: ['Verify the total'], nextSteps: ['Read the evidence, verify it, then report findings'], workspaceRef: 'scratch://isolated-test', evidenceIds: [evidenceId], idempotencyKey: key });

test('evidence transfer is immutable, scoped, bounded, checksummed and retry-safe', async () => {
  const f = await fixture();
  try {
    const upload = await f.api('sender', '/api/evidence', 'POST', evidence());
    assert.equal(upload.status, 201);
    const id = upload.data.id;
    const expected = createHash('sha256').update(evidence().content).digest('hex');
    assert.equal(upload.data.sha256, expected);
    assert.equal((await f.api('sender', '/api/evidence', 'POST', evidence())).data.id, id);
    assert.equal((await f.api('sender', '/api/evidence', 'POST', { ...evidence(), content: 'changed' })).status, 409);
    assert.equal((await f.api('receiver', `/api/evidence/${id}?content=true`)).status, 404);
    assert.equal((await f.api('outsider', `/api/evidence/${id}`)).status, 404);
    const message = await f.api('sender', '/api/messages', 'POST', { to: 'receiver', body: 'Please review this evidence', evidenceIds: [id], idempotencyKey: 'share-1' });
    assert.equal(message.status, 201); assert.equal(message.data.evidence[0].sha256, expected);
    const copy = await f.api('receiver', `/api/evidence/${id}?content=true`);
    assert.equal(copy.status, 200); assert.equal(copy.data.checksumVerified, true);
    assert.equal(Buffer.from(copy.data.content, 'base64').toString('utf8'), evidence().content);
    assert.equal(copy.data.source_ref, evidence().sourceRef);
    assert.equal((await f.api('bystander', `/api/evidence/${id}`)).status, 404);
    assert.equal((await f.api('receiver', `/api/evidence/${id}/review`, 'POST', { state: 'reviewed', observedSha256: '0'.repeat(64), note: 'Wrong digest' })).status, 409);
    const review = await f.api('receiver', `/api/evidence/${id}/review`, 'POST', { state: 'reviewed', observedSha256: expected, note: 'Parsed the JSON and verified the arithmetic independently.' });
    assert.equal(review.data.reviews[0].reviewer, 'receiver');
    const binary = Buffer.from([0, 255, 1, 128]);
    const binaryUpload = await f.api('sender', '/api/evidence', 'POST', { ...evidence('binary'), filename: 'sample.bin', encoding: 'base64', mediaType: 'application/octet-stream', content: binary.toString('base64') });
    assert.equal(binaryUpload.status, 201);
    const binaryCopy = await f.api('sender', `/api/evidence/${binaryUpload.data.id}?content=true`);
    assert.deepEqual(Buffer.from(binaryCopy.data.content, 'base64'), binary);
    assert.equal((await f.api('sender', '/api/evidence', 'POST', { ...evidence('too-big'), content: 'x'.repeat(65537) })).status, 413);
    assert.equal((await f.api('sender', '/api/evidence', 'POST', { ...evidence('bad64'), encoding: 'base64', content: '%%%bad' })).status, 400);
    assert.equal((await f.api('sender', '/api/evidence', 'POST', { ...evidence('unsafe-name'), filename: '../secret' })).status, 400);
    assert.equal((await f.api('outsider', '/api/messages', 'POST', { to: 'outsider', body: 'Leak', evidenceIds: [id], idempotencyKey: 'leak' })).status, 400);
    const before = f.hub.store.db.prepare('SELECT count(*) AS n FROM messages').get().n;
    assert.equal((await f.api('bystander', '/api/messages', 'POST', { to: 'receiver', body: 'Stolen evidence', evidenceIds: [id], idempotencyKey: 'leak-2' })).status, 404);
    assert.equal(f.hub.store.db.prepare('SELECT count(*) AS n FROM messages').get().n, before);
  } finally { await f.hub.close(); }
});

test('handoff requires recipient evidence review and distinct completion evidence', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const e = (await f.api('sender', '/api/evidence', 'POST', evidence())).data;
    const offered = await f.api('sender', '/api/handoffs', 'POST', packet(e.id));
    assert.equal(offered.status, 201); assert.equal(offered.data.state, 'offered');
    const id = offered.data.id;
    assert.equal((await f.api('sender', '/api/handoffs', 'POST', packet(e.id))).data.id, id);
    assert.equal((await f.api('sender', '/api/handoffs', 'POST', { ...packet(e.id), context: 'Changed' })).status, 409);
    assert.equal((await f.api('bystander', `/api/handoffs/${id}`)).status, 404);
    assert.equal((await f.api('outsider', '/api/handoffs')).data.items.length, 0);
    assert.equal((await f.api('receiver', '/api/inbox')).data.items[0].handoff.id, id);
    const accept = { state: 'accepted', note: 'I take responsibility for the next step only.', idempotencyKey: 'accept-1' };
    assert.equal((await f.api('sender', `/api/handoffs/${id}`, 'POST', accept)).status, 403);
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', accept)).status, 409);
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', { state: 'completed', note: 'Too early', idempotencyKey: 'premature' })).status, 409);
    await f.api('receiver', `/api/evidence/${e.id}/review`, 'POST', { observedSha256: e.sha256, state: 'rejected', note: 'Need to inspect it first' });
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', accept)).status, 409);
    await f.api('receiver', `/api/evidence/${e.id}/review`, 'POST', { observedSha256: e.sha256, state: 'reviewed', note: 'Downloaded exact bytes and independently reviewed the sample.' });
    const accepted = await f.api('receiver', `/api/handoffs/${id}`, 'POST', accept);
    assert.equal(accepted.data.state, 'accepted');
    const count = f.hub.store.db.prepare('SELECT count(*) AS n FROM messages').get().n;
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', accept)).data.state, 'accepted');
    assert.equal(f.hub.store.db.prepare('SELECT count(*) AS n FROM messages').get().n, count);
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', { state: 'completed', note: 'No new proof', idempotencyKey: 'complete-bad' })).status, 400);
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', { state: 'completed', note: 'Reusing original', evidenceIds: [e.id], idempotencyKey: 'complete-bad2' })).status, 400);
    const result = (await f.api('receiver', '/api/evidence', 'POST', { ...evidence('result'), filename: 'result.txt', content: 'Verified: 3 + 5 + 8 = 16', mediaType: 'text/plain', sourceRef: 'scratch://receiver/result.txt' })).data;
    assert.equal((await f.api('sender', `/api/evidence/${result.id}`)).status, 404);
    const completed = await f.api('receiver', `/api/handoffs/${id}`, 'POST', { state: 'completed', note: 'Verified arithmetic; no code changes, commits or deployments.', evidenceIds: [result.id], idempotencyKey: 'complete-1' });
    assert.equal(completed.data.state, 'completed');
    assert.equal((await f.api('sender', `/api/evidence/${result.id}?content=true`)).status, 200);
    assert.equal(completed.data.completionEvidence[0].id, result.id);
    assert.equal(completed.data.updates.length, 2);
    assert.equal((await f.api('receiver', `/api/handoffs/${id}`, 'POST', { state: 'declined', note: 'Invalid regression', idempotencyKey: 'decline-late' })).status, 409);
    await f.hub.close(); closed = true;
    const restarted = await startHub(f.dir, f.config, 0);
    try {
      const actor = { role: 'agent', name: 'sender', project: 'alpha' };
      const saved = restarted.store.getHandoff(actor, id);
      assert.equal(saved.state, 'completed'); assert.equal(saved.completionEvidence.length, 1);
      assert.equal(saved.packet.workspaceRef, packet(e.id).workspaceRef);
      assert.equal(Buffer.from(restarted.store.getEvidence(actor, result.id).content, 'base64').toString(), 'Verified: 3 + 5 + 8 = 16');
    } finally { await restarted.close(); }
  } finally { if (!closed) await f.hub.close(); }
});

test('decline and failed handoff creation do not lose or partially transfer data', async () => {
  const f = await fixture();
  try {
    const e = (await f.api('sender', '/api/evidence', 'POST', evidence())).data;
    const invalid = await f.api('sender', '/api/handoffs', 'POST', { ...packet(e.id), evidenceIds: [e.id, randomUUID()] });
    assert.equal(invalid.status, 404);
    assert.equal(f.hub.store.db.prepare('SELECT count(*) AS n FROM handoffs').get().n, 0);
    assert.equal(f.hub.store.db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
    const handoff = (await f.api('sender', '/api/handoffs', 'POST', packet(e.id))).data;
    const declined = await f.api('receiver', `/api/handoffs/${handoff.id}`, 'POST', { state: 'declined', note: 'Not available for this assignment', idempotencyKey: 'decline-1' });
    assert.equal(declined.data.state, 'declined');
    await f.api('admin', '/api/pause', 'POST', { paused: true });
    assert.equal((await f.api('sender', '/api/handoffs', 'POST', packet(e.id, 'new-paused'))).status, 503);
    assert.equal((await f.api('sender', '/api/evidence', 'POST', evidence('new-paused'))).status, 503);
    // Stored evidence corruption fails closed rather than issuing a verified receipt.
    f.hub.store.db.prepare('UPDATE evidence SET content=? WHERE id=?').run(Buffer.from('corrupted'), e.id);
    const corrupt = await f.api('receiver', `/api/evidence/${e.id}?content=true`);
    assert.equal(corrupt.status, 500); assert.match(corrupt.data.error, /checksum mismatch/);
  } finally { await f.hub.close(); }
});

test('separate MCP adapters can transfer evidence and complete a resumable handoff', async () => {
  const f = await fixture(); const clients = []; const transports = [];
  try {
    for (const name of ['sender', 'receiver']) {
      const file = join(f.dir, 'credentials', name + '.json');
      writePrivate(file, { version: 1, instanceId: f.config.instanceId, url: f.hub.url, name, project: 'alpha', token: f.agents[name].token });
      const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp', '--credentials', file], stderr: 'pipe' }); transports.push(transport);
      const client = new Client({ name: 'handoff-test-' + name, version: '1.0.0' }); clients.push(client); await client.connect(transport);
    }
    const call = async (index, name, args) => { const result = await clients[index].callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
    const uploaded = await call(0, 'upload_evidence', evidence());
    const handoff = await call(0, 'create_handoff', packet(uploaded.id));
    const listed = await call(1, 'list_handoffs', {}); assert.equal(listed.items[0].id, handoff.id);
    const transferred = await call(1, 'get_evidence', { evidenceId: uploaded.id });
    const sha = createHash('sha256').update(Buffer.from(transferred.content, 'base64')).digest('hex'); assert.equal(sha, uploaded.sha256);
    await call(1, 'review_evidence', { evidenceId: uploaded.id, observedSha256: sha, state: 'reviewed', note: 'Read and checked the sample data.' });
    await call(1, 'update_handoff', { handoffId: handoff.id, state: 'accepted', note: 'Resuming from the provided context.', idempotencyKey: 'accepted' });
    const result = await call(1, 'upload_evidence', { ...evidence('mcp-result'), filename: 'verified.txt', content: 'Verified total: 16', mediaType: 'text/plain', sourceRef: 'scratch://receiver/verified.txt' });
    await call(1, 'update_handoff', { handoffId: handoff.id, state: 'completed', note: 'Finished the stated verification only.', evidenceIds: [result.id], idempotencyKey: 'completed' });
    const final = await call(0, 'get_handoff', { handoffId: handoff.id }); assert.equal(final.state, 'completed');
    assert.equal(Buffer.from((await call(0, 'get_evidence', { evidenceId: result.id })).content, 'base64').toString(), 'Verified total: 16');
  } finally { await Promise.allSettled(clients.map(c => c.close())); await Promise.allSettled(transports.map(t => t.close())); await f.hub.close(); }
});
