import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {initialize} from '../dist/config.js';
import {startHub} from '../dist/server.js';
import {ReadOnlyWorkspace} from '../dist/workspace.js';

const admin={role:'admin'};
const done={status:'done',reply:'Computed result: 417.',evidenceReviews:[]};
const wait=async check=>{for(let i=0;i<600;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Worker condition timed out');};
async function fixture(host){mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/workers-'));const config=initialize(dir);const hub=await startHub(dir,config,0,{workerHost:host});
 const a=hub.store.createAgent(admin,{name:'claude-worker',project:'demo',provider:'claude',model:'default',capabilities:[]});
 const b=hub.store.createAgent(admin,{name:'codex-worker',project:'demo',provider:'codex',model:'default',capabilities:[]});
 const api=async(path,body,token=config.adminToken)=>{const response=await fetch(hub.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};};
 return{dir,config,hub,a,b,api,send:to=>hub.store.send(admin,{to,body:'Compute the sample',kind:'question',idempotencyKey:crypto.randomUUID()},'demo')};}

test('automatic worker processes a queued human task exactly once and respects admin controls',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return done;});
 try{
  const message=f.send(f.a.name);
  assert.equal((await f.api('/api/workers',{agent:f.a.name,provider:'claude'},f.a.token)).status,403);
  assert.equal((await f.api('/api/workers',{agent:f.a.name,provider:'codex'})).status,400);
  assert.equal((await f.api('/api/workers',{agent:f.a.name,provider:'claude',workspace:f.dir})).status,400);
  assert.equal((await f.api('/api/workers',{agent:f.a.name,provider:'claude',maxJobs:1})).status,201);
  assert.equal((await f.api('/api/workers',{agent:f.a.name,provider:'claude'})).status,409);
  await wait(()=>f.hub.store.workerJob(message.id)?.state==='done');
  assert.equal(calls,1);assert.equal(f.hub.store.status(admin,message.id).status,'answered');
  const thread=f.hub.store.conversation(admin,message.conversation_id,{after:0,limit:50});
  assert.equal(thread.items.length,2);assert.equal(thread.items[1].sender,f.a.name);
  await wait(async()=> (await f.api('/api/workers')).data.items[0].state==='stopped');
  assert.equal((await f.api('/api/worker-jobs/'+message.id+'/retry',{})).status,409);
  await f.api('/api/workers',{agent:f.a.name,provider:'claude',maxJobs:1});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(calls,1);
 }finally{await f.hub.close();}
});

test('failures remain unacknowledged until an explicit retry; plain peer replies do not create loops',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;if(calls===1)throw new Error('simulated provider failure');return done;});
 try{
  const message=f.send(f.a.name);
  await f.api('/api/workers',{agent:f.a.name,provider:'claude',maxJobs:1});
  await wait(()=>f.hub.store.workerJob(message.id)?.state==='failed');
  assert.equal(f.hub.store.status(admin,message.id).acknowledged_at,null);
  await wait(async()=> (await f.api('/api/workers')).data.items[0].state==='stopped');
  await f.api('/api/worker-jobs/'+message.id+'/retry',{});
  await f.api('/api/workers',{agent:f.a.name,provider:'claude',maxJobs:1});
  await wait(()=>f.hub.store.workerJob(message.id)?.state==='done');assert.equal(calls,2);
  const peer=f.hub.store.send({role:'agent',name:f.b.name,project:'demo'},{to:f.a.name,body:'Thanks, received.',kind:'message',idempotencyKey:'plain-peer'});
  await wait(async()=> (await f.api('/api/workers')).data.items[0].state==='stopped');
  await f.api('/api/workers',{agent:f.a.name,provider:'claude',maxJobs:1});
  await wait(()=>f.hub.store.status(admin,peer.id).acknowledged_at);
  assert.equal(calls,2);assert.equal(f.hub.store.conversation(admin,peer.conversation_id,{after:0,limit:50}).items.length,1);
 }finally{await f.hub.close();}
});

test('pause prevents launch and stop cancels an active task without posting a false answer',async()=>{
 let calls=0;const f=await fixture(async input=>{calls++;await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return done;});
 try{
  const message=f.send(f.a.name);f.hub.store.setPaused(admin,true);
  await f.api('/api/workers',{agent:f.a.name,provider:'claude',intervalSeconds:3});
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(calls,0);
  f.hub.store.setPaused(admin,false);
  await wait(()=>calls===1);
  await f.api('/api/workers/'+f.a.name+'/stop',{});
  assert.equal(f.hub.store.workerJob(message.id).state,'interrupted');
  assert.equal(f.hub.store.status(admin,message.id).acknowledged_at,null);
  assert.equal(f.hub.store.conversation(admin,message.conversation_id,{after:0,limit:50}).items.length,1);
 }finally{await f.hub.close();}
});

test('handoff worker checks input bytes, records reviews, and attaches its own new result evidence',async()=>{
 const f=await fixture(async input=>{const data=JSON.parse(input.prompt.split('TASK DATA:\n')[1]);return{...done,evidenceReviews:data.evidence.map(item=>({evidenceId:item.evidenceId,note:'Read the supplied values and independently checked the sum.'}))};});
 try{
  const sender={role:'agent',name:f.a.name,project:'demo'};
  const evidence=f.hub.store.uploadEvidence(sender,{filename:'fixture.json',mediaType:'application/json',encoding:'utf8',content:'{"values":[230,87,100]}',sourceRef:'sample://source',idempotencyKey:'fixture'});
  const handoff=f.hub.store.createHandoff(sender,{to:f.b.name,objective:'Check total',context:'Only arithmetic',completed:[],remaining:['Sum values'],nextSteps:['Return result'],workspaceRef:'sample://worker',evidenceIds:[evidence.id],idempotencyKey:'handoff'});
  await f.api('/api/workers',{agent:f.b.name,provider:'codex',maxJobs:1});
  await wait(()=>f.hub.store.workerJob(handoff.message_id)?.state==='done');
  const completed=f.hub.store.getHandoff(admin,handoff.id);
  assert.equal(completed.state,'completed');assert.equal(completed.completionEvidence.length,1);
  assert.notEqual(completed.completionEvidence[0].id,evidence.id);assert.equal(completed.completionEvidence[0].owner,f.b.name);
 }finally{await f.hub.close();}
});

test('workspace tools cannot write, follow escaping links, read hidden secrets or read oversized files',()=>{
 mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/worker-files-')),root=join(dir,'workspace');mkdirSync(root);
 writeFileSync(join(root,'note.txt'),'read-only sample');writeFileSync(join(root,'.env'),'PRIVATE_SENTINEL');writeFileSync(join(dir,'outside.txt'),'OUTSIDE_SENTINEL');writeFileSync(join(root,'huge.txt'),'x'.repeat(65537));symlinkSync(join(dir,'outside.txt'),join(root,'escape.txt'));
 const workspace=new ReadOnlyWorkspace(root);assert.equal(workspace.read('note.txt'),'read-only sample');assert.ok(!workspace.list().some(item=>item.name==='.env'));
 assert.throws(()=>workspace.read('escape.txt'));assert.throws(()=>workspace.read('../outside.txt'));assert.throws(()=>workspace.read('.env'));assert.throws(()=>workspace.read('huge.txt'));
 assert.equal(readFileSync(join(root,'note.txt'),'utf8'),'read-only sample');assert.equal(typeof workspace.write,'undefined');
});

test('reviewer waits for its prerequisite and receives explicitly shared result evidence within the project',async()=>{
 let calls=0,reviewSawResult=false;
 const f=await fixture(async input=>{calls++;const data=JSON.parse(input.prompt.split('TASK DATA:\n')[1]);if(input.provider==='claude')return{...done,reply:'Research source result'};reviewSawResult=data.evidence.some(item=>item.text.includes('Research source result'));return{...done,evidenceReviews:data.evidence.map(item=>({evidenceId:item.evidenceId,note:'Reviewed the explicitly shared research result.'}))};});
 try{
  const source=f.send(f.a.name),review=f.send(f.b.name);
  await f.api('/api/workers',{agent:f.b.name,provider:'codex',waitForAgent:f.a.name,intervalSeconds:3,maxJobs:1});
  await wait(async()=>(await f.api('/api/workers')).data.items[0].state==='waiting-dependency');
  assert.equal(calls,0);
  assert.equal((await f.api('/api/workers',{agent:f.a.name,provider:'claude',waitForAgent:f.b.name})).status,400);
  await f.api('/api/workers',{agent:f.a.name,provider:'claude',maxJobs:1});
  await wait(()=>f.hub.store.workerJob(source.id)?.state==='done');
  await wait(()=>f.hub.store.workerJob(review.id)?.state==='done');
  assert.equal(calls,2);assert.equal(reviewSawResult,true);
  const copies=f.hub.store.inbox({role:'agent',name:f.b.name,project:'demo'},{after:0,limit:50}).items.filter(item=>item.idempotency_key.startsWith('worker-share:'));
  assert.equal(copies.length,1);assert.equal(copies[0].evidence[0].owner,f.a.name);
 }finally{await f.hub.close();}
});
