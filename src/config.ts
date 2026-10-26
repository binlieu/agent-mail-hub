import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HubError, type AgentCredentials } from './contracts.js';

export const SERVICE = 'agent-mail-hub';
export const VERSION = '0.1.0';
export const DEFAULT_PORT = 47831;
export const configSchema = z.object({
  version: z.literal(1), instanceId: z.string().uuid(),
  port: z.number().int().min(1024).max(65535), adminToken: z.string().min(40)
}).strict();
export type HubConfig = z.infer<typeof configSchema>;
export function secret(): string { return randomBytes(32).toString('hex'); }

export function dataDirectory(explicit?: string): string {
  const directory = resolve(explicit ?? process.env.AMH_DATA_DIR ?? join(homedir(), '.agent-mail-hub'));
  // Never accept an existing A2A mailbox directory, even through a symlink.
  let ancestor = directory;
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, '..');
    if (parent === ancestor) break;
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
    ancestor = parent;
  }
  const existing = join(realpathSync(ancestor), ...suffix);
  const forbidden = /(^|[/\\])(\.a2a-talk|a2a-talk|chi-harness)([/\\]|$)/i;
  if (forbidden.test(directory) || forbidden.test(existing)) {
    throw new HubError(400, 'Choose a separate agent-mail-hub data directory, outside the existing A2A installation');
  }
  return directory;
}
export function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export function initialize(directory: string, port = DEFAULT_PORT): HubConfig {
  directory = dataDirectory(directory);
  const path = join(directory, 'config.json');
  if (existsSync(path)) {
    const config = loadConfig(directory);
    if (config.port !== port) throw new HubError(409, `Existing instance uses port ${config.port}; choose a new data directory for another instance`);
    mkdirSync(join(directory, 'credentials'), { mode: 0o700, recursive: true });
    return config;
  }
  const config = configSchema.parse({ version: 1, instanceId: randomUUID(), port, adminToken: secret() });
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new HubError(409, 'New data directory must be empty; existing files will not be adopted');
  }
  // Refuse unrelated files rather than changing permissions on an existing arbitrary folder.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivate(path, config);
  chmodSync(directory, 0o700);
  mkdirSync(join(directory, 'credentials'), { mode: 0o700, recursive: true });
  return config;
}
export function loadConfig(directory: string): HubConfig {
  const path = join(dataDirectory(directory), 'config.json');
  if (!existsSync(path)) throw new HubError(400, 'Hub is not initialized. Run setup first.');
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function hubUrl(config: HubConfig): string { return `http://127.0.0.1:${config.port}`; }
export function validateHubUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new HubError(400, 'This release only supports http://127.0.0.1:<port> hub URLs');
  }
  return url.origin;
}
export function loadCredentials(path: string): AgentCredentials {
  if (!isAbsolute(path)) throw new HubError(400, 'Use an absolute credential file path');
  const schema = z.object({ version: z.literal(1), instanceId: z.string().uuid(), url: z.string(), name: z.string(), project: z.string(), token: z.string().min(40) }).strict();
  const credentials = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  credentials.url = validateHubUrl(credentials.url);
  return credentials;
}
