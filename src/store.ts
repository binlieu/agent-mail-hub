import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { HubError, requireAdmin, type Actor, type NewAgent, type NewMessage, type Page } from './contracts.js';
import { secret } from './config.js';

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
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
    if (version?.value !== '1') throw new HubError(500, 'Unsupported database schema version');
  }
  close(): void { this.db.close(); }
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
    return this.transaction(() => {
      if (this.db.prepare('SELECT name FROM agents WHERE name=?').get(input.name)) throw new HubError(409, 'Agent name already exists');
      const token = secret();
      this.db.prepare('INSERT INTO agents(name,project,provider,model,capabilities,token_hash,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(input.name, input.project, input.provider, input.model, JSON.stringify(input.capabilities), hash(token), now());
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
      return { ...row, enabled: Boolean(row.enabled), capabilities: JSON.parse(String(row.capabilities)), lastSeen: last?.last_seen ?? null,
        host: last?.host ?? null, connected: Boolean(Number(active?.count)) && Boolean(row.enabled), unread: Number(unread?.count), deliveryMode: 'poll' };
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
    return { ...row, status: replies ? 'answered' : row.acknowledged_at ? 'acknowledged' : row.delivered_at ? 'delivered' : 'queued' };
  }
  send(actor: Actor, input: NewMessage, humanProject?: string): Row {
    const sender = actor.role === 'admin' ? '@human' : actor.name;
    const project = actor.role === 'admin' ? humanProject : actor.project;
    if (!project) throw new HubError(400, 'Project is required');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM messages WHERE project=? AND sender=? AND idempotency_key=?').get(project, sender, input.idempotencyKey);
      if (previous) {
        if (previous.recipient !== input.to || previous.body !== input.body || previous.kind !== input.kind || previous.reply_to !== (input.replyTo ?? null)) {
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
      const id = randomUUID();
      this.db.prepare(`INSERT INTO messages(id,conversation_id,project,sender,recipient,body,kind,idempotency_key,reply_to,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, parent?.conversation_id ?? randomUUID(), project, sender, input.to, input.body, input.kind, input.idempotencyKey, input.replyTo ?? null, now());
      this.event(project, sender, 'queued', id);
      if (parent) {
        this.db.prepare('UPDATE messages SET acknowledged_at=COALESCE(acknowledged_at,?),delivered_at=COALESCE(delivered_at,?) WHERE id=?').run(now(), now(), parent.id);
        this.event(project, sender, 'answered', String(parent.id));
      }
      return this.present(this.accessibleMessage(actor, id));
    });
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
