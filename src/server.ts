import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { modelOptions } from './model-options.js';
import { Workers, workerStartSchema } from './workers.js';
import type { HostRunner } from './worker-host.js';
import { usageSchema, evidenceSchema, evidenceReviewSchema, handoffSchema, handoffUpdateSchema, agentSchema, heartbeatSchema, humanMessageSchema, identifier, messageSchema, pageSchema, slug, HubError, requireAdmin, type Actor } from './contracts.js';
import { SERVICE, VERSION, type HubConfig } from './config.js';
import { join, resolve } from 'node:path';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/vendor/marked.js': ['vendor/marked.js', 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': ['vendor/purify.js', 'text/javascript; charset=utf-8'],
  '/examples.html': ['examples.html', 'text/html; charset=utf-8'],
  '/examples.js': ['examples.js', 'text/javascript; charset=utf-8'],
  '/vendor/bootstrap.min.css': ['vendor/bootstrap.min.css', 'text/css; charset=utf-8']
};
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HubError(415, 'Content-Type must be application/json');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 131072) throw new HubError(413, 'Request body exceeds 128 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HubError(400, 'Invalid JSON'); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function startHub(directory: string, config: HubConfig, port = config.port, options: { localAdminAccess?: boolean; workerHost?:HostRunner } = {}) {
  const store = new Store(join(directory, 'hub.sqlite'));
  const workers=new Workers(store,directory,options.workerHost);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const adminTokenCommand = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./cli.js', import.meta.url)))} admin-token --data-dir ${quote(resolve(directory))}`;
  let listeningPort = port;
  let authFailures = 0;
  let authWindow = Date.now();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const hosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
      if (!hosts.includes(req.headers.host ?? '')) throw new HubError(403, 'Invalid Host');
      if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) throw new HubError(403, 'Cross-origin requests are not allowed');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${listeningPort}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { service: SERVICE, version: VERSION, instanceId: config.instanceId });
      if (path === '/favicon.ico' && req.method === 'GET') { res.writeHead(204); return res.end(); }
      const asset = assets[path];
      if (asset && req.method === 'GET') {
        const content = readFileSync(join(publicRoot, asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      if (!path.startsWith('/api/')) throw new HubError(404, 'Not found');
      if (path === '/api/sign-in' && req.method === 'GET') return json(res, 200, { localAdminAccess: Boolean(options.localAdminAccess), adminTokenCommand, hubUrl: `http://127.0.0.1:${listeningPort}` });
      if (path === '/api/local-admin-token' && req.method === 'POST') {
        if (!options.localAdminAccess) throw new HubError(403, 'Local token display is disabled. Start this hub with --local-admin-access to enable it.');
        if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['x-amh-local-access'] !== 'show-token') throw new HubError(403, 'Use the local sign-in page to show this token');
        z.object({ action: z.literal('show') }).strict().parse(await body(req));
        return json(res, 200, { adminToken: config.adminToken });
      }
      if (Date.now() - authWindow > 60000) { authWindow = Date.now(); authFailures = 0; }
      if (authFailures >= 100) throw new HubError(429, 'Too many failed authentication attempts; retry in one minute');
      const authorization = req.headers.authorization;
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      const actor: Actor | null = token && timingSafeEqual(digest(token), digest(config.adminToken)) ? { role: 'admin' } : store.authenticate(token);
      if (!actor) { authFailures++; throw new HubError(401, 'Valid bearer credentials required'); }
      if (path === '/api/model-options' && req.method === 'GET') return json(res, 200, modelOptions);
      if(path==='/api/workers'&&req.method==='GET'){requireAdmin(actor);return json(res,200,{items:workers.list()});}
      if(path==='/api/workers'&&req.method==='POST'){requireAdmin(actor);return json(res,201,workers.start(workerStartSchema.parse(await body(req))));}
      const workerStop=path.match(/^\/api\/workers\/([^/]+)\/stop$/);
      if(workerStop&&req.method==='POST'){requireAdmin(actor);return json(res,200,await workers.stop(slug.parse(workerStop[1])));}
      const workerRetry=path.match(/^\/api\/worker-jobs\/([^/]+)\/retry$/);
      if(workerRetry&&req.method==='POST'){requireAdmin(actor);return json(res,200,workers.retry(identifier.parse(workerRetry[1])));}
      if (path === '/api/usage' && req.method === 'POST') return json(res, 200, store.reportUsage(actor, usageSchema.parse(await body(req))));
      const page = () => pageSchema.parse(Object.fromEntries(url.searchParams));
      if (path === '/api/me' && req.method === 'GET') return json(res, 200, { ...actor, instanceId: config.instanceId, paused: store.paused() });
      if (path === '/api/agents' && req.method === 'GET') return json(res, 200, { items: store.listAgents(actor) });
      if (path === '/api/agents' && req.method === 'POST') {
        requireAdmin(actor);
        return json(res, 201, store.createAgent(actor, agentSchema.parse(await body(req))));
      }
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === 'PATCH') {
        requireAdmin(actor);
        const input = z.object({ enabled: z.boolean() }).strict().parse(await body(req));
        store.setAgentEnabled(actor, slug.parse(agentMatch[1]), input.enabled);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/pause' && req.method === 'POST') {
        requireAdmin(actor);
        const input = z.object({ paused: z.boolean() }).strict().parse(await body(req));
        store.setPaused(actor, input.paused);
        return json(res, 200, { paused: input.paused });
      }
      if (path === '/api/heartbeat' && req.method === 'POST') {
        const input = heartbeatSchema.parse(await body(req));
        store.heartbeat(actor, input.sessionId, input.host, input.connected);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/evidence' && req.method === 'POST') return json(res, 201, store.uploadEvidence(actor, evidenceSchema.parse(await body(req))));
      const evidenceMatch = path.match(/^\/api\/evidence\/([^/]+)(\/review)?$/);
      if (evidenceMatch) {
        const id = identifier.parse(evidenceMatch[1]);
        if (req.method === 'GET' && !evidenceMatch[2]) return json(res, 200, store.getEvidence(actor, id, url.searchParams.get('content') === 'true'));
        if (req.method === 'POST' && evidenceMatch[2]) return json(res, 200, store.reviewEvidence(actor, id, evidenceReviewSchema.parse(await body(req))));
      }
      if (path === '/api/handoffs' && req.method === 'POST') return json(res, 201, store.createHandoff(actor, handoffSchema.parse(await body(req))));
      if (path === '/api/handoffs' && req.method === 'GET') return json(res, 200, store.listHandoffs(actor, page()));
      const handoffMatch = path.match(/^\/api\/handoffs\/([^/]+)$/);
      if (handoffMatch) {
        const id = identifier.parse(handoffMatch[1]);
        if (req.method === 'GET') return json(res, 200, store.getHandoff(actor, id));
        if (req.method === 'POST') return json(res, 200, store.updateHandoff(actor, id, handoffUpdateSchema.parse(await body(req))));
      }
      if (path === '/api/inbox' && req.method === 'GET') return json(res, 200, store.inbox(actor, page()));
      if (path === '/api/messages' && req.method === 'POST') {
        const raw = await body(req);
        const input = actor.role === 'admin' ? humanMessageSchema.parse(raw) : messageSchema.parse(raw);
        return json(res, 201, store.send(actor, input, 'project' in input ? String(input.project) : undefined));
      }
      const messageMatch = path.match(/^\/api\/messages\/([^/]+)(\/ack)?$/);
      if (messageMatch) {
        const id = identifier.parse(messageMatch[1]);
        if (req.method === 'GET' && !messageMatch[2]) return json(res, 200, store.status(actor, id));
        if (req.method === 'POST' && messageMatch[2]) return json(res, 200, store.acknowledge(actor, id));
      }
      const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
      if (conversationMatch && req.method === 'GET') return json(res, 200, store.conversation(actor, identifier.parse(conversationMatch[1]), page()));
      if (path === '/api/dashboard' && req.method === 'GET') {
        requireAdmin(actor);
        const project = url.searchParams.has('project') ? slug.parse(url.searchParams.get('project')) : undefined;
        return json(res, 200, {...store.dashboard(actor, page(), project, z.coerce.number().int().min(1).parse(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)),workers:workers.list()});
      }
      throw new HubError(404, 'Route not found');
    } catch (error) {
      const status = error instanceof HubError ? error.status : error instanceof z.ZodError ? 400 : 500;
      // Never log bodies, credentials, or provider secrets.
      if (status === 500) console.error('Hub request failed:', error instanceof Error ? error.name : 'Unknown error');
      if (!res.headersSent) json(res, status, { error: error instanceof HubError ? error.message : error instanceof z.ZodError ? 'Invalid input: ' + error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : 'Internal server error' });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 2000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { store.close(); throw error; }
  const address = server.address();
  if (address && typeof address !== 'string') listeningPort = address.port;
  store.interruptWorkerJobs();
  return {
    url: `http://127.0.0.1:${listeningPort}`, store, server,
    close: async () => {
      await workers.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      store.close();
    }
  };
}
