import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { HubError, requireAdmin, usageSchema, type UsageReport, type Actor, type NewAgent, type NewMessage, type Page, type NewEvidence, type EvidenceReview, type NewHandoff, type HandoffUpdate } from './contracts.js';
import { secret } from './config.js';
import { validateModelPreference } from './model-options.js';
import { presentUsage } from './usage.js';

type Row = Record<string, any>;
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const now = (): string => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const hasMeta = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (hasMeta && this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value !== '1') {
      this.db.close();
      throw new HubError(500, 'Unsupported database schema version; no migrations were applied');
    }
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('schema_version','1'), ('paused','false');
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY, project TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        capabilities TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_project ON agents(project, name);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(name), host TEXT NOT NULL,
        connected INTEGER NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent, last_seen);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
        project TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        body TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, reply_to TEXT REFERENCES messages(id),
        created_at TEXT NOT NULL, delivered_at TEXT, acknowledged_at TEXT,
        UNIQUE(project, sender, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(project, recipient, seq);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
      CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_to);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT REFERENCES messages(id), project TEXT NOT NULL,
        actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_project ON events(project, seq);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL, filename TEXT NOT NULL,
        media_type TEXT NOT NULL, source_ref TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        content BLOB NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project, owner, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS message_evidence (
        message_id TEXT NOT NULL REFERENCES messages(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
        PRIMARY KEY(message_id, evidence_id)
      );
      CREATE INDEX IF NOT EXISTS message_evidence_lookup ON message_evidence(evidence_id, message_id);
      CREATE TABLE IF NOT EXISTS evidence_reviews (
        evidence_id TEXT NOT NULL REFERENCES evidence(id), reviewer TEXT NOT NULL, state TEXT NOT NULL,
        observed_sha256 TEXT NOT NULL, note TEXT NOT NULL, reviewed_at TEXT NOT NULL,
        PRIMARY KEY(evidence_id, reviewer)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        project TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, packet TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'offered', idempotency_key TEXT NOT NULL, updated_at TEXT NOT NULL,
        completion_message_id TEXT REFERENCES messages(id), UNIQUE(project, sender, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS handoffs_participants ON handoffs(project, recipient, seq);
      CREATE TABLE IF NOT EXISTS handoff_updates (
        handoff_id TEXT NOT NULL REFERENCES handoffs(id), idempotency_key TEXT NOT NULL, request TEXT NOT NULL,
        PRIMARY KEY(handoff_id, idempotency_key)
      );
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
    if (version?.value !== '1') throw new HubError(500, 'Unsupported database schema version');
  }
  close(): void { this.db.close(); }
  workerAgent(name: string): Row {
    const row = this.db.prepare('SELECT name,project,provider,model,enabled FROM agents WHERE name=?').get(name);
    if (!row || !row.enabled) throw new HubError(404, 'Enabled agent not found');
    return { ...row, reasoningEffort:this.db.prepare('SELECT value FROM meta WHERE key=?').get(`agent_effort:${name}`)?.value ?? 'default' };
  }
  workerJob(id: string): Row | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(`worker_job:${id}`);
    return row ? JSON.parse(String(row.value)) : null;
  }
  workerDependency(name: string): {pending:number;results:Row[]} {
    this.workerAgent(name);
    const pending=Number(this.db.prepare("SELECT count(*) AS count FROM messages WHERE recipient=? AND acknowledged_at IS NULL AND (sender='@human' OR kind='question')").get(name)?.count);
    const results=this.db.prepare("SELECT reply.id,reply.body,reply.reply_to FROM messages reply JOIN messages original ON reply.reply_to=original.id WHERE reply.sender=? AND original.recipient=? AND reply.idempotency_key LIKE 'worker-reply:%' ORDER BY reply.seq DESC LIMIT 5").all(name,name)
      .filter(row=>this.workerJob(String(row.reply_to))?.state==='done');
    return{pending,results};
  }
  claimWorkerJob(actor: Actor, id: string, workerId: string): boolean {
    return this.transaction(() => {
      const message = this.accessibleMessage(actor,id), previous = this.workerJob(id);
      if(actor.role!=='agent'||message.recipient!==actor.name)throw new HubError(403,'Recipient worker required');
      if((message.acknowledged_at && previous?.state!=='retry') || (previous && previous.state!=='retry'))return false;
      this.setWorkerJob(id,{state:'running',agent:actor.name,workerId,updatedAt:now()});
      this.event(actor.project,actor.name,'worker_started',id); return true;
    });
  }
  setWorkerJob(id: string, job: Row): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`worker_job:${id}`,JSON.stringify({...job,updatedAt:now()}));
  }
  interruptWorkerJobs(): void {
    for(const row of this.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'worker_job:%'").all()) {
      const job=JSON.parse(String(row.value)); if(job.state==='running')this.setWorkerJob(String(row.key).slice('worker_job:'.length),{...job,state:'interrupted',error:'Hub restarted. Explicit retry required.'});
    }
  }
  retryWorkerJob(id: string): void {
    const job=this.workerJob(id);
    if(!job || !['failed','blocked','interrupted'].includes(job.state))throw new HubError(409,'Only failed, blocked or interrupted tasks can be retried');
    this.setWorkerJob(id,{...job,state:'retry',error:null});
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  authenticate(token: string): Actor | null {
    const agent = this.db.prepare('SELECT name, project FROM agents WHERE token_hash=? AND enabled=1').get(hash(token));
    return agent ? { role: 'agent', name: String(agent.name), project: String(agent.project) } : null;
  }
  private event(project: string, actor: string, action: string, messageId: string | null = null): void {
    this.db.prepare('INSERT INTO events(message_id,project,actor,action,created_at) VALUES (?,?,?,?,?)').run(messageId, project, actor, action, now());
  }
  createAgent(actor: Actor, input: NewAgent): Row {
    requireAdmin(actor);
    validateModelPreference(input.provider, input.model, input.reasoningEffort);
    return this.transaction(() => {
      if (this.db.prepare('SELECT name FROM agents WHERE name=?').get(input.name)) throw new HubError(409, 'Agent name already exists');
      const token = secret();
      this.db.prepare('INSERT INTO agents(name,project,provider,model,capabilities,token_hash,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(input.name, input.project, input.provider, input.model, JSON.stringify(input.capabilities), hash(token), now());
      if (input.reasoningEffort !== undefined) this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`agent_effort:${input.name}`, input.reasoningEffort);
      this.event(input.project, 'human', `agent_created:${input.name}`);
      return { ...input, token };
    });
  }
  setAgentEnabled(actor: Actor, name: string, enabled: boolean): void {
    requireAdmin(actor);
    this.transaction(() => {
      const agent = this.db.prepare('SELECT project FROM agents WHERE name=?').get(name);
      if (!agent) throw new HubError(404, 'Agent not found');
      this.db.prepare('UPDATE agents SET enabled=? WHERE name=?').run(Number(enabled), name);
      if (!enabled) this.db.prepare('UPDATE sessions SET connected=0 WHERE agent=?').run(name);
      this.event(String(agent.project), 'human', `agent_${enabled ? 'enabled' : 'disabled'}:${name}`);
    });
  }
  paused(): boolean { return this.db.prepare("SELECT value FROM meta WHERE key='paused'").get()?.value === 'true'; }
  setPaused(actor: Actor, paused: boolean): void {
    requireAdmin(actor);
    this.transaction(() => {
      this.db.prepare("UPDATE meta SET value=? WHERE key='paused'").run(String(paused));
      this.event('*', 'human', paused ? 'delivery_paused' : 'delivery_resumed');
    });
  }
  listAgents(actor: Actor): Row[] {
    const rows = actor.role === 'admin'
      ? this.db.prepare('SELECT name,project,provider,model,capabilities,enabled,created_at FROM agents ORDER BY project,name LIMIT 500').all()
      : this.db.prepare('SELECT name,project,provider,model,capabilities,enabled,created_at FROM agents WHERE project=? ORDER BY name LIMIT 500').all(actor.project);
    return rows.map(row => {
      const last = this.db.prepare('SELECT host,last_seen,connected FROM sessions WHERE agent=? ORDER BY last_seen DESC LIMIT 1').get(row.name!);
      const active = this.db.prepare('SELECT count(*) AS count FROM sessions WHERE agent=? AND connected=1 AND last_seen>?').get(row.name!, new Date(Date.now() - 60000).toISOString());
      const unread = this.db.prepare('SELECT count(*) AS count FROM messages WHERE recipient=? AND acknowledged_at IS NULL').get(row.name!);
      const savedUsage = this.db.prepare('SELECT value FROM meta WHERE key=?').get(`agent_usage:${row.name}`);
      const usage = savedUsage ? JSON.parse(String(savedUsage.value)) : null;
      return { ...row, usage: usage ? presentUsage(usage.report, usage.reportedAt) : null, reasoningEffort: this.db.prepare('SELECT value FROM meta WHERE key=?').get(`agent_effort:${row.name}`)?.value ?? 'default', configurationStatus: 'requested', enabled: Boolean(row.enabled), capabilities: JSON.parse(String(row.capabilities)), lastSeen: last?.last_seen ?? null,
        host: last?.host ?? null, connected: Boolean(Number(active?.count)) && Boolean(row.enabled), unread: Number(unread?.count), deliveryMode: 'poll' };
    });
  }
  reportUsage(actor: Actor, input: UsageReport): { ok: boolean } {
    if (actor.role !== 'agent') throw new HubError(403, 'Use the intended agent credential to report usage');
    const report = usageSchema.parse(input);
    const agent = this.db.prepare('SELECT provider FROM agents WHERE name=?').get(actor.name);
    if (agent && ['claude', 'codex'].includes(String(agent.provider)) && agent.provider !== report.provider) throw new HubError(409, 'Usage provider does not match the registered AI client');
    const timestamps = [report.observedAt, report.context?.observedAt, report.sessionTokensObservedAt, ...report.limits.map(item => item.observedAt)].filter(Boolean) as string[];
    if (timestamps.some(value => Date.parse(value) > Date.now() + 60000)) throw new HubError(400, 'Usage observations cannot be in the future');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get(`agent_usage:${actor.name}`);
      const previous = existing ? JSON.parse(String(existing.value)) : null;
      if (previous && Date.parse(previous.report.observedAt) > Date.parse(report.observedAt)) throw new HubError(409, 'Older usage cannot replace a newer observation');
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`agent_usage:${actor.name}`, JSON.stringify({ report, reportedAt: now() }));
      return { ok: true };
    });
  }
  heartbeat(actor: Actor, sessionId: string, host: string, connected: boolean): void {
    if (actor.role !== 'agent') throw new HubError(403, 'Agent credentials required');
    const existing = this.db.prepare('SELECT agent FROM sessions WHERE id=?').get(sessionId);
    if (existing && existing.agent !== actor.name) throw new HubError(409, 'Session ID belongs to another agent');
    this.db.prepare(`INSERT INTO sessions(id,agent,host,connected,last_seen) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET host=excluded.host,connected=excluded.connected,last_seen=excluded.last_seen`)
      .run(sessionId, actor.name, host, Number(connected), now());
  }
  private accessibleMessage(actor: Actor, id: string): Row {
    const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!message || (actor.role === 'agent' && (message.project !== actor.project || (message.sender !== actor.name && message.recipient !== actor.name)))) {
      throw new HubError(404, 'Message not found');
    }
    return message;
  }
  private present(row: Row): Row {
    const replies = Number(this.db.prepare('SELECT count(*) AS count FROM messages WHERE reply_to=?').get(row.id)?.count);
    const evidence = this.db.prepare('SELECT e.id,e.filename,e.media_type,e.source_ref,e.sha256,e.size,e.owner FROM evidence e JOIN message_evidence me ON me.evidence_id=e.id WHERE me.message_id=? ORDER BY e.id').all(row.id);
    const handoff = this.db.prepare('SELECT id,state FROM handoffs WHERE message_id=?').get(row.id) ?? null;
    return { ...row, evidence, handoff, worker:this.workerJob(String(row.id)), status: replies ? 'answered' : row.acknowledged_at ? 'acknowledged' : row.delivered_at ? 'delivered' : 'queued' };
  }
  send(actor: Actor, input: NewMessage, humanProject?: string): Row {
    const project = actor.role === 'admin' ? humanProject : actor.project;
    if (!project) throw new HubError(400, 'Project is required');
    return this.transaction(() => this.createMessage(actor, input, project));
  }
  private createMessage(actor: Actor, input: NewMessage, project: string): Row {
    const sender = actor.role === 'admin' ? '@human' : actor.name;

    const previous = this.db.prepare('SELECT * FROM messages WHERE project=? AND sender=? AND idempotency_key=?').get(project, sender, input.idempotencyKey);
    if (previous) {
      if (previous.recipient !== input.to || previous.body !== input.body || previous.kind !== input.kind || previous.reply_to !== (input.replyTo ?? null) || JSON.stringify(this.attachedIds(String(previous.id))) !== JSON.stringify([...(input.evidenceIds ?? [])].sort())) {
        throw new HubError(409, 'Idempotency key already used for different content');
      }
      return this.present(previous);
    }
    if (this.paused()) throw new HubError(503, 'Delivery paused by administrator; retry later with the same idempotency key');
    let parent: Row | undefined;
    if (input.replyTo) {
      parent = this.accessibleMessage(actor, input.replyTo);
      if (parent.project !== project || parent.recipient !== sender || parent.sender !== input.to) throw new HubError(403, 'Only the recipient can reply to the original sender');
    }
    if (input.to === sender) throw new HubError(400, 'Self-messaging is disabled to prevent accidental loops');
    if (input.to === '@human') {
      if (!parent || parent.sender !== '@human') throw new HubError(400, 'Human messages must be replies');
    } else {
      const recipient = this.db.prepare('SELECT name FROM agents WHERE name=? AND project=? AND enabled=1').get(input.to, project);
      if (!recipient) throw new HubError(404, 'Recipient not found in your project or disabled');
    }
    for (const evidenceId of input.evidenceIds ?? []) this.evidenceForProject(actor, evidenceId, project);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO messages(id,conversation_id,project,sender,recipient,body,kind,idempotency_key,reply_to,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, parent?.conversation_id ?? randomUUID(), project, sender, input.to, input.body, input.kind, input.idempotencyKey, input.replyTo ?? null, now());
    for (const evidenceId of input.evidenceIds ?? []) this.db.prepare('INSERT INTO message_evidence VALUES(?,?)').run(id, evidenceId);
    this.event(project, sender, 'queued', id);
    if (parent) {
      this.db.prepare('UPDATE messages SET acknowledged_at=COALESCE(acknowledged_at,?),delivered_at=COALESCE(delivered_at,?) WHERE id=?').run(now(), now(), parent.id);
      this.event(project, sender, 'answered', String(parent.id));
    }
    return this.present(this.accessibleMessage(actor, id));
  }

  inbox(actor: Actor, page: Page): Row {
    if (actor.role !== 'agent') throw new HubError(403, 'Agent credentials required');
    if (this.paused()) throw new HubError(503, 'Delivery paused by administrator');
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM messages WHERE project=? AND recipient=? AND seq>? ORDER BY seq LIMIT ?').all(actor.project, actor.name, page.after, page.limit);
      for (const row of rows) {
        if (!row.delivered_at) {
          row.delivered_at = now();
          this.db.prepare('UPDATE messages SET delivered_at=? WHERE id=?').run(row.delivered_at, row.id!);
          this.event(actor.project, actor.name, 'delivered', String(row.id));
        }
      }
      return { items: rows.map(row => this.present(row)), nextCursor: rows.at(-1)?.seq ?? page.after };
    });
  }
  acknowledge(actor: Actor, id: string): Row {
    return this.transaction(() => {
      const row = this.accessibleMessage(actor, id);
      const name = actor.role === 'admin' ? '@human' : actor.name;
      if (row.recipient !== name) throw new HubError(403, 'Only the recipient can acknowledge this message');
      if (!row.acknowledged_at) {
        this.db.prepare('UPDATE messages SET acknowledged_at=?,delivered_at=COALESCE(delivered_at,?) WHERE id=?').run(now(), now(), id);
        this.event(String(row.project), name, 'acknowledged', id);
      }
      return this.present(this.accessibleMessage(actor, id));
    });
  }
  status(actor: Actor, id: string): Row { return this.present(this.accessibleMessage(actor, id)); }
  conversation(actor: Actor, id: string, page: Page): Row {
    // A conversation is two-party. Filter every row so later extensions cannot leak other participants.
    const rows = actor.role === 'admin'
      ? this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, page.after, page.limit)
      : this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND project=? AND (sender=? OR recipient=?) AND seq>? ORDER BY seq LIMIT ?')
        .all(id, actor.project, actor.name, actor.name, page.after, page.limit);
    return { items: rows.map(row => this.present(row)), nextCursor: rows.at(-1)?.seq ?? page.after };
  }
  private attachedIds(messageId: string): string[] {
    return this.db.prepare('SELECT evidence_id FROM message_evidence WHERE message_id=? ORDER BY evidence_id').all(messageId).map(row => String(row.evidence_id));
  }
  private evidenceForProject(actor: Actor, id: string, project: string): Row {
    const row = this.accessibleEvidence(actor, id);
    if (row.project !== project) throw new HubError(404, 'Evidence not found in this project');
    return row;
  }
  private accessibleEvidence(actor: Actor, id: string): Row {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id);
    if (!row) throw new HubError(404, 'Evidence not found');
    if (actor.role === 'agent') {
      const shared = this.db.prepare(`SELECT 1 FROM message_evidence me JOIN messages m ON m.id=me.message_id
        WHERE me.evidence_id=? AND m.project=? AND (m.sender=? OR m.recipient=?) LIMIT 1`).get(id, actor.project, actor.name, actor.name);
      if (row.project !== actor.project || (row.owner !== actor.name && !shared)) throw new HubError(404, 'Evidence not found');
    }
    return row;
  }
  private evidenceMetadata(row: Row): Row {
    const { content, idempotency_key, ...metadata } = row;
    return { ...metadata, reviews: this.db.prepare('SELECT reviewer,state,observed_sha256,note,reviewed_at FROM evidence_reviews WHERE evidence_id=? ORDER BY reviewer').all(row.id) };
  }
  uploadEvidence(actor: Actor, input: NewEvidence): Row {
    if (actor.role !== 'agent') throw new HubError(403, 'Agent credentials required');
    if (input.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) throw new HubError(400, 'Invalid base64 content');
    const content = Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
    if (!content.length || content.length > 65536) throw new HubError(413, 'Evidence must contain 1 to 65536 bytes');
    const sha256 = createHash('sha256').update(content).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM evidence WHERE project=? AND owner=? AND idempotency_key=?').get(actor.project, actor.name, input.idempotencyKey);
      if (previous) {
        if (previous.sha256 !== sha256 || previous.filename !== input.filename || previous.source_ref !== input.sourceRef || previous.media_type !== input.mediaType) throw new HubError(409, 'Evidence key already used for different content or provenance');
        return this.evidenceMetadata(previous);
      }
      if (this.paused()) throw new HubError(503, 'Delivery paused by administrator');
      const id = randomUUID();
      this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, actor.project, actor.name, input.filename, input.mediaType, input.sourceRef, sha256, content.length, content, input.idempotencyKey, now());
      this.event(actor.project, actor.name, `evidence_uploaded:${id}`);
      return this.evidenceMetadata(this.accessibleEvidence(actor, id));
    });
  }
  getEvidence(actor: Actor, id: string, includeContent = true): Row {
    const row = this.accessibleEvidence(actor, id);
    const content = Buffer.from(row.content);
    if (createHash('sha256').update(content).digest('hex') !== row.sha256) throw new HubError(500, 'Stored evidence checksum mismatch');
    return { ...this.evidenceMetadata(row), checksumVerified: true, ...(includeContent ? { encoding: 'base64', content: content.toString('base64'), ...(['text/plain', 'text/markdown', 'application/json'].includes(row.media_type) ? { textContent: content.toString('utf8') } : {}) } : {}) };
  }
  reviewEvidence(actor: Actor, id: string, input: EvidenceReview): Row {
    if (actor.role !== 'agent') throw new HubError(403, 'Agent credentials required');
    return this.transaction(() => {
      const row = this.getEvidence(actor, id, false);
      if (input.observedSha256 !== row.sha256) throw new HubError(409, 'Observed evidence checksum does not match the stored copy');
      const previous = this.db.prepare('SELECT * FROM evidence_reviews WHERE evidence_id=? AND reviewer=?').get(id, actor.name);
      if (previous?.state === input.state && previous.note === input.note) return row;
      this.db.prepare(`INSERT INTO evidence_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(evidence_id,reviewer)
        DO UPDATE SET state=excluded.state,observed_sha256=excluded.observed_sha256,note=excluded.note,reviewed_at=excluded.reviewed_at`)
        .run(id, actor.name, input.state, input.observedSha256, input.note, now());
      this.event(actor.project, actor.name, `evidence_${input.state}:${id}`);
      return this.getEvidence(actor, id, false);
    });
  }
  createHandoff(actor: Actor, input: NewHandoff): Row {
    if (actor.role !== 'agent') throw new HubError(403, 'Agent credentials required');
    return this.transaction(() => {
      const packet = JSON.stringify(input);
      const previous = this.db.prepare('SELECT * FROM handoffs WHERE project=? AND sender=? AND idempotency_key=?').get(actor.project, actor.name, input.idempotencyKey);
      if (previous) {
        if (previous.packet !== packet) throw new HubError(409, 'Handoff key already used for different context');
        return this.getHandoff(actor, String(previous.id));
      }
      // Evidence, original context, notification and audit entry commit together.
      const message = this.createMessage(actor, { to: input.to, body: `Handoff offered: ${input.objective}`, kind: 'message', idempotencyKey: `handoff:${input.idempotencyKey}`, evidenceIds: input.evidenceIds }, actor.project);
      const id = randomUUID();
      this.db.prepare('INSERT INTO handoffs(id,message_id,project,sender,recipient,packet,idempotency_key,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, message.id, actor.project, actor.name, input.to, packet, input.idempotencyKey, now());
      this.event(actor.project, actor.name, `handoff_offered:${id}`, String(message.id));
      return this.getHandoff(actor, id);
    });
  }
  getHandoff(actor: Actor, id: string): Row {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id);
    if (!row || (actor.role === 'agent' && (row.project !== actor.project || (row.sender !== actor.name && row.recipient !== actor.name)))) throw new HubError(404, 'Handoff not found');
    const packet = JSON.parse(String(row.packet));
    const evidence = this.attachedIds(String(row.message_id)).map(evidenceId => this.getEvidence(actor, evidenceId, false));
    const updates = this.db.prepare('SELECT request FROM handoff_updates WHERE handoff_id=? ORDER BY rowid').all(id).map(item => JSON.parse(String(item.request)));
    const completionEvidence = row.completion_message_id ? this.attachedIds(String(row.completion_message_id)).map(evidenceId => this.getEvidence(actor, evidenceId, false)) : [];
    return { ...row, packet, evidence, updates, completionEvidence };
  }
  listHandoffs(actor: Actor, page: Page): Row {
    const rows = actor.role === 'admin'
      ? this.db.prepare('SELECT id,seq FROM handoffs WHERE seq>? ORDER BY seq LIMIT ?').all(page.after, page.limit)
      : this.db.prepare('SELECT id,seq FROM handoffs WHERE project=? AND (sender=? OR recipient=?) AND seq>? ORDER BY seq LIMIT ?').all(actor.project, actor.name, actor.name, page.after, page.limit);
    return { items: rows.map(row => this.getHandoff(actor, String(row.id))), nextCursor: rows.at(-1)?.seq ?? page.after };
  }
  updateHandoff(actor: Actor, id: string, input: HandoffUpdate): Row {
    if (actor.role !== 'agent') throw new HubError(403, 'Agent credentials required');
    return this.transaction(() => {
      const handoff = this.getHandoff(actor, id);
      if (handoff.recipient !== actor.name) throw new HubError(403, 'Only the receiving agent can accept, decline or complete this handoff');
      const previous = this.db.prepare('SELECT request FROM handoff_updates WHERE handoff_id=? AND idempotency_key=?').get(id, input.idempotencyKey);
      if (previous) {
        if (previous.request !== JSON.stringify(input)) throw new HubError(409, 'Update key already used for a different decision');
        return handoff;
      }
      if (this.paused()) throw new HubError(503, 'Delivery paused by administrator');
      if ((input.state === 'accepted' || input.state === 'declined') && handoff.state !== 'offered') throw new HubError(409, 'Only an offered handoff can be accepted or declined');
      if (input.state === 'completed' && handoff.state !== 'accepted') throw new HubError(409, 'Accept the handoff before reporting completion');
      if (input.state !== 'declined') {
        for (const evidence of handoff.evidence) {
          const receipt = this.db.prepare('SELECT state FROM evidence_reviews WHERE evidence_id=? AND reviewer=?').get(evidence.id, actor.name);
          if (receipt?.state !== 'reviewed') throw new HubError(409, 'Review every transferred evidence item before accepting or completing');
        }
      }
      if (input.state === 'completed' && !input.evidenceIds.length) throw new HubError(400, 'Completion requires new result evidence');
      if (input.state !== 'completed' && input.evidenceIds.length) throw new HubError(400, 'Attach result evidence when completing the handoff');
      if (input.state === 'completed') for (const evidenceId of input.evidenceIds) {
        const evidence = this.evidenceForProject(actor, evidenceId, actor.project);
        if (evidence.owner !== actor.name || handoff.packet.evidenceIds.includes(evidenceId)) throw new HubError(400, 'Completion evidence must be a result uploaded by the receiving agent');
      }
      const message = this.createMessage(actor, { to: handoff.sender, body: `Handoff ${input.state}: ${input.note}`, kind: 'message', replyTo: handoff.message_id, idempotencyKey: `handoff-update:${id}:${input.idempotencyKey}`, evidenceIds: input.evidenceIds }, actor.project);
      this.db.prepare('INSERT INTO handoff_updates VALUES(?,?,?)').run(id, input.idempotencyKey, JSON.stringify(input));
      this.db.prepare('UPDATE handoffs SET state=?,updated_at=?,completion_message_id=COALESCE(?,completion_message_id) WHERE id=?')
        .run(input.state, now(), input.state === 'completed' ? message.id : null, id);
      this.event(actor.project, actor.name, `handoff_${input.state}:${id}`, String(message.id));
      return this.getHandoff(actor, id);
    });
  }

  dashboard(actor: Actor, page: Page, project?: string, before = Number.MAX_SAFE_INTEGER): Row {
    requireAdmin(actor);
    const rows = project
      ? this.db.prepare('SELECT * FROM messages WHERE project=? AND seq>? AND seq<? ORDER BY seq DESC LIMIT ?').all(project, page.after, before, page.limit)
      : this.db.prepare('SELECT * FROM messages WHERE seq>? AND seq<? ORDER BY seq DESC LIMIT ?').all(page.after, before, page.limit);
    const events = this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 50').all();
    return { agents: this.listAgents(actor), messages: rows.map(row => this.present(row)), events, paused: this.paused(),
      nextBefore: rows.at(-1)?.seq ?? null, totalMessages: Number(this.db.prepare('SELECT count(*) AS count FROM messages').get()?.count) };
  }
}
