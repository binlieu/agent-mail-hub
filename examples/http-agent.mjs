#!/usr/bin/env node
// Dependency-free sample: inspect one agent inbox; no AI calls or automatic replies.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const file = process.argv[2];
if (!file || !isAbsolute(file)) throw new Error('Usage: node examples/http-agent.mjs /absolute/credentials.json [after=0]');
const credentials = JSON.parse(readFileSync(file, 'utf8'));
const base = new URL(credentials.url);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw new Error('Only a local loopback hub is supported');
const after = Number(process.argv[3] ?? 0);
if (!Number.isSafeInteger(after) || after < 0) throw new Error('Cursor must be a nonnegative integer');
async function get(path, authenticated = true) {
  const response = await fetch(base.origin + path, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: authenticated ? { Authorization: `Bearer ${credentials.token}` } : {} });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
const health = await get('/health', false);
if (health.service !== 'agent-mail-hub' || health.instanceId !== credentials.instanceId) throw new Error('Hub instance mismatch; credentials were not sent');
const me = await get('/api/me');
if (me.role !== 'agent' || me.name !== credentials.name || me.project !== credentials.project) throw new Error('Agent identity mismatch');
const inbox = await get(`/api/inbox?after=${after}&limit=50`);
console.log(JSON.stringify(inbox, null, 2));
console.error('Inbox retrieval records delivery only. Acknowledge after durable handling; save nextCursor after processing.');
