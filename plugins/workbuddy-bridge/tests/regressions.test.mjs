import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fixture, user, assistant } from './fixtures.mjs'
import { stripContextPreamble, activeSessions, readTranscript } from '../lib/store.js'
import { createTicket, loadTicket, existingRequest, isBusy } from '../lib/dispatch.js'
import { adoptNewSession, recover, waitForRun, cancel, collect, resolveOptions } from '../lib/flow.js'
import { restartDecision } from '../lib/app.js'
import { createBridge } from '../index.js'
import { readIdentity } from '../lib/dom.js'

test('working and queued are recognized by both runtime and SQLite busy checks', async t => {
  const f = fixture(t)
  f.row('working', { status:'working' }); f.row('queued',{status:'queued'})
  assert.equal(isBusy('working'), true)
  assert.equal((await activeSessions({dbPath:f.dbPath})).rows.length,2)
})
test('authorized missing-port restart is the default, observation and opt-out remain distinct', () => {
  assert.equal(restartDecision({endpointReachable:false,running:true}),'force-restart')
  assert.equal(restartDecision({endpointReachable:true,running:true}),'reuse')
  assert.equal(restartDecision({endpointReachable:false,running:true,autoRestart:false}),'needs-restart')
  assert.equal(resolveOptions().autoRestart,true)
})
test('context wrapper stripping retains the actual user task', () => {
  assert.equal(stripContextPreamble('<system-reminder data-role="user-context">\n<user_info>os</user_info>\n</system-reminder>\nTASK'),'TASK')
  assert.equal(stripContextPreamble('ordinary <context>quoted</context> task'),'ordinary <context>quoted</context> task')
  assert.equal(stripContextPreamble('<system-reminder>os</system-reminder>\n<user_query>TASK</user_query>'),'TASK')
})
test('a pre-created session is recovered from its post-send wrapped user event', async t => {
  const f=fixture(t); f.row('reserved',{created_at:1000,status:'working'})
  f.log('reserved',[{...user('<system-reminder>os</system-reminder>\nTASK'),id:'msg1',timestamp:2100}])
  const ticket=createTicket(f.options,{task:'TASK',since:2000,beforeSessions:{reserved:{bytes:0}}})
  assert.equal((await adoptNewSession(f.options,ticket)).id,'reserved')
  const result=await recover(f.options,{dispatchId:ticket.dispatchId})
  assert.equal(result.sessionId,'reserved');assert.equal(result.evidence.dispatchId,ticket.dispatchId)
  assert.equal(loadTicket(f.options,ticket.dispatchId).userMessageId,'msg1')
})
test('recovery does not guess an unrelated existing session', async t => {
  const f=fixture(t);f.row('other',{created_at:1000});f.log('other',[{...user('other'),timestamp:2100}])
  const ticket=createTicket(f.options,{task:'TASK',since:2000,state:'pending-observation',beforeSessions:{other:{bytes:0}}})
  const result=await recover(f.options,{dispatchId:ticket.dispatchId})
  assert.equal(result.status,'pending-observation');assert.equal(result.submitted,true)
})
test('a session created during typing is adopted even if it predates the send click', async t => {
  const f=fixture(t);f.row('during-typing',{created_at:1800,status:'working'})
  f.log('during-typing',[{...user('<system-reminder>os</system-reminder><user_query>TASK</user_query>'),timestamp:2100}])
  const ticket=createTicket(f.options,{task:'TASK',preparedAt:1500,since:2000,beforeSessions:{}})
  assert.equal((await adoptNewSession(f.options,ticket)).id,'during-typing')
})
test('a bound historical session with a delayed new message stays recoverable', async t => {
  const f=fixture(t);f.row('a');const bytes=f.log('a',[user('old'),assistant('old answer')])
  const ticket=createTicket(f.options,{task:'TASK',since:2000,sessionId:'a',baselineBytes:bytes,state:'bound'})
  assert.equal((await recover(f.options,{dispatchId:ticket.dispatchId})).needsRecovery,true)
  f.log('a',[{...user('TASK'),timestamp:2100},assistant('new answer')],true)
  assert.equal((await recover(f.options,{dispatchId:ticket.dispatchId})).sessionId,'a')
})
test('an older ticket can be recovered but cannot interrupt a newer turn', async t => {
  const f=fixture(t);f.row('a',{status:'working'})
  f.log('a',[{...user('TASK'),timestamp:2100},assistant('old answer'),{...user('NEW'),timestamp:2200},assistant('new answer')])
  const ticket=createTicket(f.options,{task:'TASK',since:2000,sessionId:'a'})
  assert.equal((await recover(f.options,{dispatchId:ticket.dispatchId})).superseded,true)
  await assert.rejects(cancel(f.options,{dispatchId:ticket.dispatchId}),{code:'TURN_SUPERSEDED'})
  const result=await waitForRun(f.options,{dispatchId:ticket.dispatchId,timeoutSec:0.01})
  assert.equal(result.status,'superseded');assert.equal(result.turn.answer,'old answer')
})
test('legacy 2.0 evidence is bound only after matching a real message and time', async t => {
  const f=fixture(t);f.row('legacy');f.log('legacy',[{...user('TASK'),timestamp:2100},assistant('answer')])
  const result=await recover(f.options,{sessionId:'legacy',evidence:{task:'TASK',since:2000,baselineBytes:0}})
  assert.equal(result.sessionId,'legacy');assert.ok(result.dispatchId)
  await assert.rejects(recover(f.options,{sessionId:'legacy',evidence:{task:'wrong',since:2000,baselineBytes:0}}),{code:'RECOVERY_NOT_VERIFIED'})
})
test('requestId retries recover without calling any UI or sending again', async t => {
  const f=fixture(t);f.row('a');f.log('a',[{...user('TASK'),timestamp:2100},assistant('answer')])
  const ticket=createTicket(f.options,{task:'TASK',requestId:'retry-key',since:2000,sessionId:'a'})
  const bridge=createBridge({dbPath:f.dbPath,port:1,lockPath:f.lockPath,autoRestart:false})
  const result=await bridge.callTool('workbuddy_run',{task:'TASK',session:'new',requestId:'retry-key'})
  assert.equal(result.dispatchId,ticket.dispatchId)
  assert.equal(existingRequest(f.options,'retry-key').dispatchId,ticket.dispatchId)
  assert.equal((await bridge.callTool('workbuddy_run',{task:'different',requestId:'retry-key'})).code,'REQUEST_CONFLICT')
})
test('durable evidence survives a new bridge instance; model metadata drift does not abort', async t => {
  const f=fixture(t);f.row('a',{model:'hy4flash-free',updated_at:3000,last_activity_at:3000})
  f.log('a',[{...user('TASK'),timestamp:2100},assistant('answer')])
  const ticket=createTicket(f.options,{task:'TASK',since:2000,sessionId:'a',requestedSettings:{model:'Hy4'}})
  const result=await waitForRun(f.options,{dispatchId:ticket.dispatchId,timeoutSec:0.01})
  assert.equal(result.done,true)
  const observation=await recover(f.options,{dispatchId:ticket.dispatchId})
  assert.equal(observation.backendModel,'NOT_INDEPENDENTLY_OBSERVED')
  assert.equal(observation.observations.at(-1).model,'hy4flash-free')
  assert.equal(observation.usage,'NOT_MEASURED')
})
test('cancel is a no-op for a completed dispatch and never uses a restart', async t => {
  const f=fixture(t);f.row('a');f.log('a',[{...user('TASK'),timestamp:2100},assistant('answer')])
  const ticket=createTicket(f.options,{task:'TASK',since:2000,sessionId:'a'})
  const result=await cancel(f.options,{dispatchId:ticket.dispatchId})
  assert.equal(result.requested,false)
})
test('copy rejects missing source allowlist and only copies allowed workspace descendants', async t => {
  const f=fixture(t);f.row('a')
  const safe=path.join(f.cwd,'output');fs.mkdirSync(safe)
  const one=path.join(safe,'out.txt'), input=path.join(f.cwd,'input.txt')
  fs.writeFileSync(one,'out');fs.writeFileSync(input,'private input')
  f.log('a',[{type:'function_call',name:'Read',arguments:{path:input}},{type:'function_call',name:'Write',arguments:{path:one}},assistant('answer')])
  await assert.rejects(collect(f.options,{sessionId:'a',mode:'copy',outputDir:path.join(f.root,'copies')}),{code:'COPY_ROOTS_REQUIRED'})
  const result=await collect(f.options,{sessionId:'a',mode:'copy',outputDir:path.join(f.root,'copies'),allowedOutputDirs:[safe]})
  assert.deepEqual(result.originals,[one]);assert.equal(result.copies.length,1)
  assert.deepEqual(result.categories.independentlyAttributedOutputs,[])
})
test('visible composer identity wins over titles and hidden retained composers', async () => {
  const node=(id,shown)=>({getAttribute:()=>id,getBoundingClientRect:()=>({width:shown?100:0,height:20})})
  const nodes=[node('hidden-old',false),node('correct-id',true)]
  const connection={evaluate:code=>vm.runInNewContext(code,{document:{querySelectorAll:()=>nodes},getComputedStyle:()=>({visibility:'visible',display:'block',opacity:1})})}
  assert.equal((await readIdentity(connection)).sessionId,'correct-id')
})
