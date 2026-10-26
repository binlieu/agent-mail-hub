import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initialize, writePrivate } from './config.js';
import { startHub } from './server.js';
import { handleShutdown } from './shutdown.js';
import type { AgentCredentials } from './contracts.js';

export async function runDemo(parent: string, port: number, serve: boolean): Promise<void> {
  // Unique demo directory. Never reuse a person's mailbox or contact registered agents.
  const directory = join(parent, `demo-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = initialize(directory, port);
  const hub = await startHub(directory, config);
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  try {
    for (const name of ['demo-planner', 'demo-builder']) {
      const agent = hub.store.createAgent({ role: 'admin' }, { name, project: 'demo', provider: 'simulated', model: 'deterministic-demo', capabilities: ['messaging'] });
      const file = join(directory, 'credentials', name + '.json');
      const credentials: AgentCredentials = { version: 1, instanceId: config.instanceId, url: hub.url, name, project: 'demo', token: agent.token };
      writePrivate(file, credentials);
      const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp', '--credentials', file], stderr: 'pipe' });
      transports.push(transport);
      const client = new Client({ name, version: '0.1.0' });
      clients.push(client);
      await client.connect(transport);
    }
    async function call(index: number, name: string, args: Record<string, unknown>) {
      const result = await clients[index]!.callTool({ name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0]!.text);
    }
    console.log('1. Started an isolated hub and two simulated agents through real stdio MCP clients.');
    const question = await call(0, 'send_message', { to: 'demo-builder', body: 'Can you confirm durable cross-agent messaging works?', kind: 'question', idempotencyKey: 'demo-question-1' });
    console.log(`2. Planner sent question ${question.id}.`);
    const inbox = await call(1, 'read_inbox', { after: 0, limit: 50 });
    if (!inbox.items.some((item: any) => item.id === question.id)) throw new Error('Question missing from builder inbox');
    await call(1, 'ack_message', { messageId: question.id });
    console.log('3. Builder read and acknowledged the question.');
    const reply = await call(1, 'reply_message', { messageId: question.id, body: 'Confirmed: I received your question through MCP and replied in the same conversation.', idempotencyKey: 'demo-reply-1' });
    const replies = await call(0, 'read_inbox', { after: 0, limit: 50 });
    if (!replies.items.some((item: any) => item.id === reply.id)) throw new Error('Reply missing from planner inbox');
    await call(0, 'ack_message', { messageId: reply.id });
    const status = await call(0, 'get_message_status', { messageId: question.id });
    const duplicate = await call(0, 'send_message', { to: 'demo-builder', body: question.body, kind: 'question', idempotencyKey: 'demo-question-1' });
    if (status.status !== 'answered' || duplicate.id !== question.id) throw new Error('Reply status or deduplication failed');
    console.log('4. Planner received the reply. Retrying the original send returned the same message.');
    const proof = { verifiedAt: new Date().toISOString(), transport: 'real stdio MCP', agents: 'two deterministic simulated agents; no model API calls', questionId: question.id, replyId: reply.id, conversationId: question.conversation_id, questionStatus: status.status, duplicateSuppressed: true, dashboardUrl: hub.url, directory };
    writeFileSync(join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`5. PASS. Proof: ${join(directory, 'proof.json')}\nData retained: ${directory}`);
    if (serve) {
      console.log(`Dashboard: ${hub.url}\nSign in using: node ${JSON.stringify(fileURLToPath(new URL('./cli.js', import.meta.url)))} admin-token --data-dir ${JSON.stringify(directory)}\nDemo agents disconnect after the exchange; their messages remain visible. Press Ctrl+C to stop this demo hub.`);
    }
  } catch (error) {
    await hub.close(); throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await Promise.allSettled(transports.map(transport => transport.close()));
  }
  if (serve) handleShutdown(hub.close);
  else await hub.close();
}
