import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { HubError, identifier, usageSchema, type UsageReport } from './contracts.js';

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = (value: unknown): number | null => { const result = number(value); return result === null ? null : Math.min(100, result); };
const date = (value: unknown, fallback: string): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const epoch = (value: unknown): string | null => typeof value === 'number' && value > 0 && value < 253402300799 ? new Date(value * 1000).toISOString() : null;
type Native = Record<string, any>;

function context(usedTokens: number | null, windowTokens: number | null, usedPercent: number | null, observedAt: string): UsageReport['context'] {
  if (windowTokens === 0) windowTokens = null;
  if (usedPercent === null && usedTokens !== null && windowTokens !== null) usedPercent = Math.min(100, usedTokens / windowTokens * 100);
  return usedTokens === null && usedPercent === null ? null : { usedTokens, windowTokens, usedPercent, observedAt };
}
function claudeInput(usage: Native | undefined): number | null {
  if (!usage || number(usage.input_tokens) === null) return null;
  return usage.input_tokens + (number(usage.cache_creation_input_tokens) ?? 0) + (number(usage.cache_read_input_tokens) ?? 0);
}
export function codexLimits(raw: Native | undefined, observedAt: string): UsageReport['limits'] {
  if (!raw) return [];
  const buckets = raw.rateLimitsByLimitId || raw.rate_limits_by_limit_id;
  const single = raw.rateLimits || raw.rate_limits || raw;
  const entries: [string, Native][] = buckets && Object.keys(buckets).length ? Object.entries(buckets) : [[single.limit_id || single.limitId || 'codex', single]];
  const result: UsageReport['limits'] = [];
  for (const [id, bucket] of entries) for (const name of ['primary', 'secondary']) {
    const window = bucket?.[name];
    const used = number(window?.used_percent ?? window?.usedPercent);
    if (used === null) continue;
    const minutes = number(window.window_minutes ?? window.windowDurationMins);
    result.push({ id: `${id}:${name}`, label: `${id} ${name}`, usedPercent: used, windowMinutes: minutes && Number.isInteger(minutes) ? minutes : null,
      resetsAt: epoch(window.resets_at ?? window.resetsAt), observedAt });
  }
  return result;
}

// Only allowlisted numeric telemetry leaves this parser; prompts, paths and credentials never do.
export function parseUsage(source: string, text: string, expectedSession: string, observedAt: string): UsageReport {
  identifier.parse(expectedSession);
  let result: UsageReport = { provider: source === 'claude' ? 'claude' : 'codex', source: source === 'claude' ? 'claude-statusline' : 'codex-session', sessionId: expectedSession, observedAt, context: null, sessionTokens: null, sessionTokensObservedAt: null, limits: [] };
  if (source === 'claude') {
    let native: Native;
    try { native = JSON.parse(text); } catch { throw new HubError(400, 'Expected Claude status-line JSON'); }
    if (native.session_id !== expectedSession) throw new HubError(409, 'Claude session ID does not match the intended agent session');
    const ctx = native.context_window;
    result.context = context(claudeInput(ctx?.current_usage), number(ctx?.context_window_size), percent(ctx?.used_percentage), observedAt);
    if (number(ctx?.total_input_tokens) !== null && number(ctx?.total_output_tokens) !== null) result.sessionTokens = ctx.total_input_tokens + ctx.total_output_tokens;
    for (const [id, label, minutes] of [['five_hour', '5-hour', 300], ['seven_day', '7-day', 10080], ['spend_limit', 'Spend limit', null]] as const) {
      const window = native.rate_limits?.[id];
      const used = number(window?.used_percentage);
      if (used !== null) result.limits.push({ id, label, usedPercent: used, windowMinutes: minutes, resetsAt: epoch(window.resets_at), observedAt });
    }
  } else if (source === 'codex' || source === 'claude-stream') {
    let owner: string | undefined;
    let active: string | undefined;
    let modelWindow: number | null = null;
    let lastClaudeInput: number | null = null;
    let lastClaudeModel: string | undefined;
    let lastClaudeAt = observedAt;
    let execTokens: number | null = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: Native;
      try { event = JSON.parse(line); } catch { continue; } // Live JSONL may end in a partial record.
      const payload = event.payload;
      const session = event.type === 'session_meta' ? payload?.id : event.type === 'thread.started' ? event.thread_id : event.session_id;
      if (session) { owner ??= session; active = session; }
      if (active !== expectedSession || owner !== expectedSession || (payload?.session_id && payload.session_id !== expectedSession) || (payload?.thread_id && payload.thread_id !== expectedSession)) continue;
      const at = date(event.timestamp, observedAt);
      if (source === 'claude-stream') {
        result.provider = 'claude'; result.source = 'claude-stream';
        if (event.type === 'assistant' && event.message?.usage) { lastClaudeInput = claudeInput(event.message.usage); lastClaudeModel = event.message.model; lastClaudeAt = at; modelWindow = null; }
        if (event.type === 'result') {
          const models = Object.values(event.modelUsage || {}) as Native[];
          // Match the last assistant's actual model; never borrow another model's capacity.
          modelWindow = lastClaudeModel ? number(event.modelUsage?.[lastClaudeModel]?.contextWindow) : models.length === 1 ? number(models[0]?.contextWindow) : null;
          const usage = event.usage;
          if (claudeInput(usage) !== null && number(usage?.output_tokens) !== null) { result.sessionTokens = claudeInput(usage)! + usage.output_tokens; result.sessionTokensObservedAt = at; }
        }
      } else if (event.type === 'event_msg' && payload?.type === 'token_count') {
        const info = payload.info;
        if (info) {
          result.context = context(number(info.last_token_usage?.total_tokens), number(info.model_context_window), null, at);
          result.sessionTokens = number(info.total_token_usage?.total_tokens);
          result.sessionTokensObservedAt = at;
        }
        if (payload.rate_limits) result.limits = codexLimits(payload.rate_limits, at);
      } else if (event.type === 'turn.completed' && event.usage) {
        result.source = 'codex-exec';
        const input = number(event.usage.input_tokens), output = number(event.usage.output_tokens);
        if (input !== null && output !== null) { execTokens = (execTokens ?? 0) + input + output; result.sessionTokensObservedAt = at; }
      }
    }
    if (owner !== expectedSession) throw new HubError(409, 'Usage log belongs to another session or has no session identity');
    if (source === 'claude-stream') result.context = context(lastClaudeInput, modelWindow, null, lastClaudeAt);
    if (execTokens !== null) result.sessionTokens = execTokens;
  } else throw new HubError(400, 'Usage source must be claude, claude-stream or codex');
  if (result.sessionTokens !== null && result.sessionTokensObservedAt === null) result.sessionTokensObservedAt = observedAt;
  return usageSchema.parse(result);
}

export function readUsageFile(path: string): { text: string; observedAt: string } {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HubError(400, 'Usage input must be a regular file');
    const size = stat.size;
    const limit = 4 * 1024 * 1024;
    const tail = Buffer.alloc(Math.min(size, limit));
    readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    if (size <= limit) return { text: tail.toString('utf8'), observedAt: stat.mtime.toISOString() };
    const head = Buffer.alloc(Math.min(size, 65536));
    readSync(fd, head, 0, head.length, 0);
    const firstLine = head.toString('utf8').split('\n')[0]!;
    try { JSON.parse(firstLine); } catch { throw new HubError(400, 'Usage log header is incomplete or too large to identify safely'); }
    // Keep the original owner identity, skip a truncated tail line, and bound every poll.
    return { text: firstLine + '\n' + tail.toString('utf8').split('\n').slice(1).join('\n'), observedAt: stat.mtime.toISOString() };
  } finally { closeSync(fd); }
}

export function presentUsage(report: UsageReport, reportedAt: string, at = Date.now()) {
  const stale = (observedAt: string) => at - Date.parse(observedAt) > 300000;
  return { ...report, reportedAt, stale: stale(report.observedAt), tokensStale: report.sessionTokensObservedAt !== null && stale(report.sessionTokensObservedAt),
    context: report.context ? { ...report.context, stale: stale(report.context.observedAt),
      remainingPercent: report.context.usedPercent === null ? null : 100 - report.context.usedPercent,
      remainingTokens: report.context.usedTokens !== null && report.context.windowTokens !== null ? Math.max(0, report.context.windowTokens - report.context.usedTokens) : null } : null,
    limits: report.limits.map(window => ({ ...window, remainingPercent: Math.max(0, 100 - window.usedPercent),
      stale: stale(window.observedAt), expired: window.resetsAt !== null && Date.parse(window.resetsAt) <= at })) };
}

// Dedicated read-only RPC client. It never resumes a thread, sends a prompt or buys reset credits.
export async function readCodexAccountLimits(executable = 'codex'): Promise<UsageReport['limits']> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--no-daemon', 'app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = ''; let length = 0; let settled = false;
    const finish = (error?: Error, result?: UsageReport['limits']) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill('SIGTERM');
      if (error) reject(error); else resolve(result ?? []);
    };
    const timer = setTimeout(() => finish(new HubError(503, 'Codex account limits unavailable; last observation retained')), 12000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new HubError(503, 'Codex CLI unavailable for account-limit reporting')));
    child.stdin.on('error', () => finish(new HubError(503, 'Codex account-limit connection closed')));
    child.on('exit', () => { if (!settled) finish(new HubError(503, 'Codex account-limit reader exited')); });
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 1048576) return finish(new HubError(503, 'Codex account-limit response too large'));
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n'); buffer = lines.pop()!;
      for (const line of lines) {
        let message: Native;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new HubError(503, 'Codex account-limit initialization unavailable'));
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (message.id === 2) {
          if (message.error) return finish(new HubError(503, 'Codex account limits unavailable for this account'));
          try { finish(undefined, codexLimits(message.result, new Date().toISOString())); }
          catch { finish(new HubError(503, 'Unsupported Codex account-limit response')); }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_mail_hub_usage', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}
