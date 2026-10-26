import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { HubError } from './contracts.js';

export const workerResultSchema = z.object({
  status:z.enum(['done','blocked']), reply:z.string().min(1).max(12000),
  evidenceReviews:z.array(z.object({evidenceId:z.string().uuid(),note:z.string().min(1).max(2000)}).strict()).max(10)
}).strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;
export type HostInput = { provider:'claude'|'codex'; model:string; effort:string; runtime:string; workspace?:string; prompt:string; signal:AbortSignal; timeoutMs?:number };
export type HostRunner = (input:HostInput) => Promise<WorkerResult>;

export const runWorkerHost: HostRunner = async input => {
  mkdirSync(input.runtime,{recursive:true,mode:0o700});
  const cli = fileURLToPath(new URL('./cli.js',import.meta.url));
  const schema = z.toJSONSchema(workerResultSchema,{target:'draft-7'});
  delete schema.$schema; // CLI validators accept different JSON Schema dialect declarations.
  const tools = ['list_files','read_file'];
  const mcp = input.workspace ? { 'agent-mail-workspace': {command:process.execPath,args:[cli,'workspace-mcp','--workspace',input.workspace]} } : {};
  const config = join(input.runtime,'mcp.json'), settings = join(input.runtime,'settings.json'), outputSchema = join(input.runtime,'result-schema.json');
  writeFileSync(config,JSON.stringify({mcpServers:mcp}),{mode:0o600});
  writeFileSync(settings,JSON.stringify({disableAllHooks:true,enabledPlugins:{},permissions:{allow:tools.map(name=>`mcp__agent-mail-workspace__${name}`),deny:['Bash','Read','Write','Edit','WebFetch','WebSearch','Agent']}}),{mode:0o600});
  writeFileSync(outputSchema,JSON.stringify(schema),{mode:0o600});
  let args: string[];
  if(input.provider==='claude') {
    args=['--print','--restricted','--strict-mcp-config','--mcp-config',config,'--settings',settings,'--setting-sources','','--tools','','--permission-mode','dontAsk','--permission-prompts','none','--disable-slash-commands','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(schema),'--no-chrome'];
    if(input.workspace) args.push('--allowedTools',...tools.map(name=>`mcp__agent-mail-workspace__${name}`));
    if(input.model!=='default') args.push('--model',input.model);
    if(input.effort!=='default') args.push('--effort',input.effort);
  } else {
    args=['--no-daemon','-a','never','exec','--ignore-user-config','--ignore-rules','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','-C',input.runtime,
      '-c','features.shell_tool=false','-c','features.shell_snapshot=false','-c','features.hooks=false','-c','features.apps=false','-c','features.multi_agent=false','-c','features.memories=false','-c','web_search="disabled"','--output-schema',outputSchema];
    if(input.workspace) {
      args.push('-c',`mcp_servers.agent-mail-workspace={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(mcp['agent-mail-workspace']!.args)},enabled_tools=${JSON.stringify(tools)},required=true}`);
      for(const name of tools) args.push('-c',`mcp_servers.agent-mail-workspace.tools.${name}.approval_mode="approve"`);
    }
    if(input.model!=='default') args.push('--model',input.model);
    if(input.effort!=='default') args.push('-c',`model_reasoning_effort=${JSON.stringify(input.effort)}`);
    args.push('-');
  }
  // Inherit the CLI's own login, not this chat's A2A/session/hook routing.
  const env={...process.env};
  for(const key of Object.keys(env)) if(/^(A2A_|CC_AGENT$|CHI_|CLAUDECODE$|CLAUDE_CODE_|CODEX_APP_|CODEX_THREAD_|CODEX_INTERNAL_|CODEX_ORCHESTRATOR|CODEX_SESSION)/.test(key)) delete env[key];
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY='1';
  return new Promise((resolve,reject)=>{
    if(input.signal.aborted) return reject(new HubError(409,'Worker stopped'));
    const child=spawn(input.provider,args,{cwd:input.runtime,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    let output=''; let bytes=0; let settled=false; let terminating=false; let termination:ReturnType<typeof setTimeout>|undefined;
    const kill=()=>{ try { if(process.platform!=='win32'&&child.pid) process.kill(-child.pid,'SIGTERM'); else child.kill('SIGTERM'); } catch {} };
    const finish=(error?:Error,result?:WorkerResult)=>{
      if(settled)return;settled=true;clearTimeout(timeout);if(termination)clearTimeout(termination);input.signal.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(result!);
    };
    const abort=()=>{if(terminating)return;terminating=true;kill();termination=setTimeout(()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},1500);};
    const timeout=setTimeout(abort,input.timeoutMs??180000);
    input.signal.addEventListener('abort',abort,{once:true});
    child.on('error',()=>finish(new HubError(503,'AI CLI could not start. Check its installation and account login.')));
    child.stdin.on('error',()=>{});
    child.stderr.on('data',()=>{}); // Never log task content or provider credentials.
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4194304){abort();return;}output+=chunk.toString('utf8');});
    child.on('close',code=>{
      if(input.signal.aborted)return finish(new HubError(409,'Worker stopped; task not acknowledged'));
      if(terminating)return finish(new HubError(503,'AI exceeded its time/output limit; task not acknowledged'));
      if(code!==0)return finish(new HubError(503,'AI CLI failed or exceeded its time/output limit. No automatic retry was made.'));
      try {
        let result:unknown;
        if(input.provider==='claude') { const record=JSON.parse(output); if(record.is_error)throw new Error(); result=record.structured_output??JSON.parse(record.result); }
        else for(const line of output.split('\n')) { try { const event=JSON.parse(line); if(event.type==='item.completed'&&event.item?.type==='agent_message')result=JSON.parse(event.item.text); }catch{} }
        finish(undefined,workerResultSchema.parse(result));
      }catch {finish(new HubError(503,'AI returned no valid task result. Task remains unacknowledged; inspect its worker status.'));}
    });
    child.stdin.end(input.prompt);
  });
};
