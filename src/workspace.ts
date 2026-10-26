import { realpathSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { HubError } from './contracts.js';
import { VERSION } from './config.js';

const blocked = (path: string) => path.split(/[\\/]/).some(part => part.startsWith('.') || /^(node_modules|credentials|chi-harness|a2a-talk)$/i.test(part) || /(^auth\.json$|^config\.json$|credentials|secret|\.pem$|\.key$)/i.test(part));
export class ReadOnlyWorkspace {
  readonly root: string;
  constructor(path: string) {
    this.root = realpathSync(resolve(path));
    if (!statSync(this.root).isDirectory() || this.root === sep || this.root === homedir() || /(^|[/\\])(\.a2a-talk|a2a-talk|chi-harness)([/\\]|$)/i.test(this.root)) throw new HubError(400, 'Choose a specific read-only project folder outside existing A2A');
  }
  private path(input: string): string {
    if (input !== '.' && blocked(input)) throw new HubError(403, 'Hidden, credential and infrastructure paths are excluded');
    const target = realpathSync(resolve(this.root, input));
    const rel = relative(this.root, target);
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || (rel && blocked(rel))) throw new HubError(403, 'Path is outside the configured read-only workspace or is excluded');
    return target;
  }
  list(path = '.') {
    return readdirSync(this.path(path), { withFileTypes: true }).filter(entry => !blocked(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)
      .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'link-or-other' }));
  }
  read(path: string) {
    const file = this.path(path), stat = statSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new HubError(400, 'Read a regular text file of at most 64 KiB');
    const bytes = readFileSync(file);
    if (bytes.includes(0)) throw new HubError(400, 'Binary files are not supported by the read-only worker');
    return bytes.toString('utf8');
  }
}

export function startWorkspaceMcp(path: string) {
  const workspace = new ReadOnlyWorkspace(path);
  return serveStdio(() => {
    const server = new McpServer({ name: 'agent-mail-workspace', version: VERSION }, { capabilities: { tools: {} } });
    const register = (name: string, description: string, handler: (path: string) => unknown) => server.registerTool(name, { description, inputSchema: z.object({ path: z.string().min(1).max(2000).default('.') }).strict() }, async ({path}) => {
      try { return { content: [{type:'text' as const,text:JSON.stringify(handler(path))}] }; }
      catch { return { isError:true, content:[{type:'text' as const,text:'Path is excluded, unavailable, outside the workspace, or too large. No content returned.'}] }; }
    });
    register('list_files', 'List up to 200 visible entries in the configured read-only workspace. Paths are relative; start with dot.', path => workspace.list(path));
    register('read_file', 'Read one text file up to 64 KiB inside the configured read-only workspace. No writes, commands, secrets or hidden paths.', path => workspace.read(path));
    return server;
  });
}
