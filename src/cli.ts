#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataDirectory, DEFAULT_PORT, hubUrl, initialize, loadConfig, loadCredentials, SERVICE, VERSION, writePrivate } from './config.js';
import { agentSchema, HubError, type AgentCredentials } from './contracts.js';
import { handleShutdown } from './shutdown.js';
import { request, verifyHub } from './http-client.js';

const help = `Agent Mail Hub ${VERSION} — isolated local agent messaging

  setup                         Initialize private data, print next steps
  start [--local-admin-access]   Start hub; optionally show its token on sign-in
  add-agent --name NAME          Create agent credentials on the running hub
    [--project default] [--provider unspecified] [--model unspecified]
  config --credentials FILE     Print a generic MCP configuration snippet
  mcp --credentials FILE        Run this agent's MCP adapter on stdio
  doctor [--credentials FILE]   Verify instance, authentication and connectivity
  usage --credentials FILE --source claude|codex|claude-stream
    --input FILE|- --session-id UUID [--watch] [--account-limits (Codex)]
                                Report numeric host usage for this agent only
  admin-token                   Print the dashboard token (explicit secret access)
  send --credentials FILE --to NAME --body TEXT --key UNIQUE
  inbox --credentials FILE [--after 0]
  reply --credentials FILE --message UUID --body TEXT --key UNIQUE
  status --credentials FILE --message UUID
  workspace-mcp --workspace DIR Run the worker's scoped read-only file tools
  demo [--serve]                Run two simulated agents through real MCP clients

Options: --data-dir ABS_PATH (or AMH_DATA_DIR), --port NUMBER (setup/demo)
         --credentials ABS_PATH (or AMH_CREDENTIALS_FILE)
Default: ~/.agent-mail-hub, http://127.0.0.1:${DEFAULT_PORT}
No existing A2A data, terminal sessions, or AI configuration is modified.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    'data-dir': { type: 'string' }, port: { type: 'string' }, credentials: { type: 'string' }, workspace: { type: 'string' },
    name: { type: 'string' }, project: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    to: { type: 'string' }, body: { type: 'string' }, key: { type: 'string' }, message: { type: 'string' },
    after: { type: 'string' }, serve: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    source: { type: 'string' }, input: { type: 'string' }, 'session-id': { type: 'string' }, watch: { type: 'boolean' }, 'account-limits': { type: 'boolean' }, 'local-admin-access': { type: 'boolean' }
  }});
  const command = positionals[0];
  if (!command || values.help || command === 'help') { console.log(help); return; }
  if (positionals.length > 1) throw new HubError(400, 'Unexpected positional arguments');
  const known = ['setup','start','add-agent','config','mcp','doctor','admin-token','send','inbox','reply','status','demo','usage','workspace-mcp'];
  if (!known.includes(command)) throw new HubError(400, `Unknown command: ${command}. Run --help.`);
  const directory = dataDirectory(values['data-dir']);
  if(command==='workspace-mcp') {
    if(!values.workspace)throw new HubError(400,'--workspace is required');
    const {startWorkspaceMcp}=await import('./workspace.js');startWorkspaceMcp(values.workspace);return;
  }
  const credentialPath = values.credentials ?? process.env.AMH_CREDENTIALS_FILE;
  const credentials = () => {
    if (!credentialPath) throw new HubError(400, 'Specify --credentials /absolute/path.json or AMH_CREDENTIALS_FILE');
    return loadCredentials(credentialPath);
  };
  const suppliedPort = values.port === undefined ? undefined : Number(values.port);
  if (suppliedPort !== undefined && (!Number.isInteger(suppliedPort) || suppliedPort < 1024 || suppliedPort > 65535)) throw new HubError(400, 'Port must be an integer between 1024 and 65535');
  if (command === 'setup') {
    const existing = existsSync(join(directory, 'config.json')) ? loadConfig(directory) : undefined;
    const config = initialize(directory, suppliedPort ?? existing?.port ?? DEFAULT_PORT);
    const { Store } = await import('./store.js');
    const store = new Store(join(directory, 'hub.sqlite')); store.close();
    console.log(`Ready: ${directory}\nDashboard: ${hubUrl(config)}\nNext: start --data-dir ${JSON.stringify(directory)}\nThen: add-agent --name planner --data-dir ${JSON.stringify(directory)}\nUse admin-token with this data directory to sign into the dashboard.\nSetup did not modify any AI or existing A2A configuration.`);
    return;
  }
  if (command === 'config') {
    credentials();
    console.log(JSON.stringify({ mcpServers: { 'agent-mail-hub': {
      command: process.execPath, args: [resolve(process.argv[1]!), 'mcp'],
      env: { AMH_CREDENTIALS_FILE: resolve(credentialPath!) }
    } } }, null, 2));
    return;
  }
  if (command === 'mcp') {
    const { startMcp } = await import('./mcp.js'); await startMcp(credentials()); return;
  }
  if (command === 'usage') {
    const { parseUsage, readUsageFile, readCodexAccountLimits } = await import('./usage.js');
    const agent = credentials();
    if (!values.input || !values.source || !values['session-id']) throw new HubError(400, 'Usage requires --source, --input and --session-id');
    if (values.watch && values.input === '-') throw new HubError(400, '--watch requires a regular file');
    if (values['account-limits'] && values.source !== 'codex') throw new HubError(400, '--account-limits requires --source codex');
    let stdin: string | undefined;
    if (values.input === '-') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 262144) throw new HubError(413, 'Usage stdin exceeds 256 KiB');
        chunks.push(Buffer.from(chunk));
      }
      stdin = Buffer.concat(chunks).toString('utf8');
    }
    let previous: string | undefined;
    let running = false;
    let accountLimits: Awaited<ReturnType<typeof readCodexAccountLimits>> | undefined;
    let accountAttempt = 0;
    const publish = async () => {
      if (running) return;
      running = true;
      try {
        const input = stdin === undefined ? readUsageFile(resolve(values.input!)) : { text: stdin, observedAt: new Date().toISOString() };
        const report = parseUsage(values.source!, input.text, values['session-id']!, input.observedAt);
        if (values['account-limits']) {
          if (Date.now() - accountAttempt >= 60000) {
            accountAttempt = Date.now();
            try { accountLimits = await readCodexAccountLimits(); }
            catch { console.error('Codex account limits unavailable; existing allowance observations retain their original age.'); }
          }
          if (accountLimits?.length) {
            report.limits = accountLimits;
            report.observedAt = [report.observedAt, ...accountLimits.map(item => item.observedAt)].sort().at(-1)!;
          }
        }
        const fingerprint = JSON.stringify(report);
        if (fingerprint === previous) return;
        await verifyHub(agent.url, agent.instanceId);
        await request(agent.url, agent.token, '/api/usage', 'POST', report);
        previous = fingerprint;
        console.log(`${agent.name}: context ${report.context?.usedPercent === null || !report.context ? 'unavailable' : report.context.usedPercent.toFixed(1) + '% used'}; ${report.limits.length} shared allowance window(s).`);
      } finally { running = false; }
    };
    await publish();
    if (values.watch) {
      const interval = setInterval(() => { void publish().catch(() => console.error('Usage update failed; previous observation retained. Check the input session and hub.')); }, 20000);
      handleShutdown(async () => { clearInterval(interval); });
    }
    return;
  }
  if (command === 'demo') {
    const { runDemo } = await import('./demo.js');
    await runDemo(directory, suppliedPort ?? 47832, Boolean(values.serve)); return;
  }
  if (['send','inbox','reply','status'].includes(command)) {
    const agent = credentials();
    await verifyHub(agent.url, agent.instanceId);
    let result: unknown;
    if (command === 'inbox') result = await request(agent.url, agent.token, `/api/inbox?after=${encodeURIComponent(values.after ?? '0')}`);
    if (command === 'send') result = await request(agent.url, agent.token, '/api/messages', 'POST', { to: values.to, body: values.body, idempotencyKey: values.key });
    if (command === 'status' || command === 'reply') {
      const id = (await import('./contracts.js')).identifier.parse(values.message);
      const original = await request(agent.url, agent.token, `/api/messages/${id}`);
      result = command === 'status' ? original : await request(agent.url, agent.token, '/api/messages', 'POST', {
        to: original.sender, body: values.body, idempotencyKey: values.key, replyTo: id
      });
    }
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'doctor' && credentialPath) {
    const agent = credentials(); await verifyHub(agent.url, agent.instanceId);
    const me = await request(agent.url, agent.token, '/api/me');
    if (me.role !== 'agent' || me.name !== agent.name || me.project !== agent.project) throw new HubError(409, 'Credential identity mismatch');
    const agents = await request(agent.url, agent.token, '/api/agents');
    console.log(JSON.stringify({ ok: true, service: SERVICE, url: agent.url, identity: me, visibleAgents: agents.items.length, deliveryMode: 'poll', note: 'Connectivity verified; run demo for an end-to-end exchange. AI execution is not tested by doctor.' }, null, 2));
    return;
  }
  const config = loadConfig(directory);
  const url = hubUrl(config);
  if (suppliedPort !== undefined && suppliedPort !== config.port) throw new HubError(409, 'Port differs from saved configuration; use another data directory');
  if (command === 'admin-token') { console.log(config.adminToken); return; }
  if (command === 'start') {
    const { startHub } = await import('./server.js');
    const hub = await startHub(directory, config, config.port, { localAdminAccess: Boolean(values['local-admin-access']) });
    console.log(`Agent Mail Hub ${VERSION}\nDashboard: ${hub.url}\nData: ${directory}\nUse admin-token to sign in. Press Ctrl+C to stop this hub.`);
    handleShutdown(hub.close);
    return;
  }
  await verifyHub(url, config.instanceId);
  if (command === 'doctor') {
    const dashboard = await request(url, config.adminToken, '/api/dashboard?limit=1');
    console.log(JSON.stringify({ ok: true, service: SERVICE, url, dataDirectory: directory, agents: dashboard.agents.length, messages: dashboard.totalMessages, paused: dashboard.paused,
      note: 'Hub and authentication verified. Adapter heartbeat does not prove model activity.' }, null, 2)); return;
  }
  if (command === 'add-agent') {
    const input = agentSchema.parse({ name: values.name, project: values.project, provider: values.provider, model: values.model });
    const file = join(directory, 'credentials', input.name + '.json');
    if (existsSync(file)) throw new HubError(409, 'Credential file already exists; choose a new agent name');
    const result = await request(url, config.adminToken, '/api/agents', 'POST', input);
    const agent: AgentCredentials = { version: 1, instanceId: config.instanceId, url, name: result.name, project: result.project, token: result.token };
    writePrivate(file, agent);
    console.log(`Created ${agent.name} in project ${agent.project}\nPrivate credentials: ${file}\nNext: config --credentials ${JSON.stringify(file)}\nCredentials were not installed into any AI client.`);
  }
}
void main().catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error('Port already occupied. Nothing was stopped. Set up another data directory with a different --port.');
  else if (error instanceof Error) console.error(error.message);
  else console.error('Command failed');
  process.exitCode = 1;
});
