#!/usr/bin/env node
// Explicit real-account acceptance run, isolated from existing agents and A2A.
import {parseArgs} from 'node:util';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomInt,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {initialize} from '../dist/config.js';
import {startHub} from '../dist/server.js';
const {values}=parseArgs({options:{serve:{type:'boolean'},port:{type:'string'}}});
mkdirSync('.local-run',{recursive:true});const dir=mkdtempSync(resolve('.local-run/automatic-workers-'));
const workspace=join(dir,'workspace');mkdirSync(workspace,{mode:0o700});
const numbers=[randomInt(30,90),randomInt(100,180),randomInt(200,300)],sum=numbers.reduce((a,b)=>a+b,0);
writeFileSync(join(workspace,'fixture.json'),JSON.stringify({values:numbers,declaredTotal:sum+1}),{mode:0o600});
const protectedPaths=['.codex/config.toml','.claude/settings.json','.claude/hooks.json'];
const fingerprint=()=>Object.fromEntries(protectedPaths.map(path=>{const full=join(homedir(),path);return[path,existsSync(full)?createHash('sha256').update(readFileSync(full)).digest('hex'):null];}));
const before=fingerprint();
const config=initialize(join(dir,'hub'),Number(values.port||47942));
const hub=await startHub(join(dir,'hub'),config);
const api=async(path,body)=>{const res=await fetch(hub.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.adminToken}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();if(!res.ok)throw new Error(data.error);return data;};
const wait=async(check,label)=>{for(let i=0;i<150;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2000));}throw new Error('Timed out: '+label);};
let passed=false;
try{
  for(const provider of ['claude','codex'])await api('/api/agents',{name:`automatic-${provider}`,project:'automatic-proof',provider,model:'default'});
  const messages=[];
  for(const provider of ['claude','codex']){
    messages.push(await api('/api/messages',{project:'automatic-proof',to:`automatic-${provider}`,kind:'question',body:'Read fixture.json using the configured read-only workspace tools. Independently sum its values and compare declaredTotal. Reply with calculatedTotal, declaredTotal and matches, citing the file you actually read. Do not claim to run tests or change files.',idempotencyKey:`automatic-${provider}-question`}));
    await api('/api/workers',{agent:`automatic-${provider}`,provider,workspace,maxJobs:provider==='codex'?2:1,intervalSeconds:3});
  }
  console.log(`Isolated automatic workers running: ${hub.url}\nPrivate proof directory: ${dir}`);
  for(const message of messages){
    await wait(async()=>{
      const status=await api(`/api/messages/${message.id}`);
      if(status.worker?.state==='failed')throw new Error(status.worker.error);
      return status.worker?.state==='done';
    },message.recipient);
    const thread=await api(`/api/conversations/${message.conversation_id}`);
    const reply=thread.items.find(item=>item.reply_to===message.id);
    assert.ok(reply);assert.ok(reply.body.includes(String(sum)));assert.match(reply.body,/false|mismatch|does not match|not match/i);
    console.log(`PASS: real ${message.recipient} independently read the workspace fixture and automatically replied.`);
  }
  const sender={role:'agent',name:'automatic-claude',project:'automatic-proof'};
  const evidence=hub.store.uploadEvidence(sender,{filename:'handoff.json',mediaType:'application/json',encoding:'utf8',content:JSON.stringify({values:numbers,declaredTotal:sum+1}),sourceRef:'sample://automatic-worker/input',idempotencyKey:'auto-handoff-source'});
  const handoff=hub.store.createHandoff(sender,{to:'automatic-codex',objective:'Independently verify the attached total and return a new result',context:'Arithmetic only; do not modify files or claim tests.',completed:['Prepared source'],remaining:['Verify total'],nextSteps:['Read input and return calculation with matches comparison'],workspaceRef:'sample://automatic-worker',evidenceIds:[evidence.id],idempotencyKey:'auto-handoff'});
  await wait(async()=>{const status=hub.store.workerJob(handoff.message_id);if(status?.state==='failed')throw new Error(status.error);return status?.state==='done';},'automatic evidence handoff');
  const completed=hub.store.getHandoff({role:'admin'},handoff.id);
  assert.equal(completed.state,'completed');assert.equal(completed.completionEvidence.length,1);assert.equal(completed.completionEvidence[0].owner,'automatic-codex');
  assert.deepEqual(fingerprint(),before);assert.equal(JSON.parse(readFileSync(join(workspace,'fixture.json'),'utf8')).declaredTotal,sum+1);
  passed=true;
  writeFileSync(join(dir,'proof.json'),JSON.stringify({passed,simulated:false,url:hub.url,messages:messages.map(item=>item.id),handoffId:handoff.id,inputEvidence:evidence.id,resultEvidence:completed.completionEvidence[0].id,protectedSettingsUnchanged:true,sourceUnchanged:true},null,2),{mode:0o600});
  console.log('PASS: automatic Codex handoff produced new result evidence. Source and protected settings unchanged. No commits.');
}finally{if(!values.serve||!passed)await hub.close();}
