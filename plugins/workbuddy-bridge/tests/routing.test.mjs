import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {fixture,user,assistant} from './fixtures.mjs'
import {createTicket} from '../lib/dispatch.js'
import {callerContext,projectLabel,readBinding,writeBinding,chooseSession,scopeForCall,executionDefaults,rememberCall,taskKeywords,scopeRequest} from '../lib/routing.js'
import {listProjects,ensureProject} from '../lib/projects.js'
import {typeTask} from '../lib/dom.js'
import {createBridge} from '../index.js'

const caller=(id='a',project='project-one')=>callerContext({callerConversationId:id,callerProjectKey:project,callerProjectName:'项目名称'}, {}, {})
test('caller project takes precedence, with conversation fallback and no shared cwd identity',()=>{
  assert.equal(caller('a').baseScope,caller('b').baseScope)
  assert.notEqual(callerContext({callerConversationId:'a'},{},{}).baseScope,callerContext({callerConversationId:'b'},{},{}).baseScope)
  assert.throws(()=>callerContext({}, {cwd:'C:/plugin'}, {}),{code:'CALLER_CONTEXT_REQUIRED'})
})
test('MCP requires per-call identity instead of inheriting a shared server start thread',()=>{
  assert.throws(()=>callerContext({}, {callerContextSource:'mcp'}, {CODEX_THREAD_ID:'stale-thread'}),{code:'CALLER_CONTEXT_REQUIRED'})
  assert.equal(callerContext({callerConversationId:'correct'}, {callerContextSource:'mcp'}, {CODEX_THREAD_ID:'stale'}).conversationId,'correct')
  assert.equal(callerContext({}, {}, {CODEX_THREAD_ID:'cli-thread'}).conversationId,'cli-thread')
})
test('equivalent Windows caller project paths use one mapping',()=>{
  assert.equal(caller('a','C:\\Study\\ERP\\').baseScope,caller('b','c:/study/erp').baseScope)
})
test('managed names stay within native limits while retaining stable collision suffixes',()=>{
  const c={...caller(),label:'这是非常长的中文项目标题以及副标题'}
  const name=projectLabel(c)
  assert.ok([...name].reduce((n,ch)=>n+(ch.charCodeAt(0)>127?2:1),0)<=20)
  assert.match(name,/-[a-f0-9]{6}$/)
  assert.notEqual(name,projectLabel(c,'other-scope'))
})
test('Hy4, high and 300K are real defaults; code tasks select 吴八哥 and explicit arguments win',()=>{
  assert.deepEqual(executionDefaults({task:'写一段Python代码'}),{task:'写一段Python代码',taskKind:'code',model:'Hy4',effort:'高',contextK:300,expert:'吴八哥'})
  const custom=executionDefaults({task:'修改源码',model:'Custom',effort:'低',contextK:600,expert:'Other',taskKind:'general'})
  assert.equal(custom.model,'Custom');assert.equal(custom.effort,'低');assert.equal(custom.contextK,600);assert.equal(custom.expert,'Other')
  assert.equal(executionDefaults({task:'规划明天的行程'}).expert,undefined)
  assert.equal(executionDefaults({task:'为插件增加项目映射'}).expert,'吴八哥')
})
test('same conversation resumes its task; another conversation in that project starts separately',t=>{
  const f=fixture(t),a=caller('a'),b=caller('b'),binding=readBinding(f.options,a.baseScope)
  binding.project={id:'native-one',name:'managed'}
  const args=executionDefaults({task:'请研究Python插件的数据接口实现'})
  rememberCall(f.options,a,a.baseScope,binding,{...args,resolvedSession:'new'},{sessionId:'wb-a',dispatchId:'d-a'})
  const persisted=readBinding(f.options,a.baseScope)
  assert.equal(chooseSession(persisted,a,{...args,relationship:'related'}).session,'wb-a')
  assert.equal(chooseSession(persisted,b,args).session,'new')
  assert.equal(persisted.project.id,'native-one')
})
test('short continuations prefer reuse; explicit or clearly disjoint topics start a fresh task',()=>{
  const a=caller(),binding={threads:{a:{lastSessionId:'last',taskKeywords:taskKeywords('Python数据库接口调用缓存数据迁移升级'),expert:'吴八哥'}}}
  assert.equal(chooseSession(binding,a,{task:'继续',expert:'吴八哥'}).session,'last')
  assert.equal(chooseSession(binding,a,{task:'请修改这里',relationship:'related',expert:'吴八哥'}).session,'last')
  assert.equal(chooseSession(binding,a,{task:'意大利米兰威尼斯罗马佛罗伦萨旅行景点美食酒店',expert:'吴八哥'}).session,'new')
  assert.equal(chooseSession(binding,a,{task:'同项目',relationship:'unrelated'}).session,'new')
  assert.equal(chooseSession(binding,a,{task:'相似任务',session:'new'}).session,'new')
})
test('expert changes start a new task because experts cannot be silently swapped in history',()=>{
  assert.equal(chooseSession({threads:{a:{lastSessionId:'last',expert:undefined}}},caller(),{task:'修改Python代码',expert:'吴八哥'}).reason,'expert-requires-new-task')
})
test('different-project branches persist for the calling conversation; same-project returns to its base',t=>{
  const f=fixture(t),a=caller()
  const branch=scopeForCall(f.options,a,{relationship:'different-project',topicKey:'travel'})
  assert.notEqual(branch.key,a.baseScope)
  rememberCall(f.options,a,branch.key,branch.binding,{task:'旅行',taskKind:'general',resolvedSession:'new'},{sessionId:'branch-session'})
  assert.equal(scopeForCall(f.options,a,{}).key,branch.key)
  assert.equal(scopeForCall(f.options,a,{relationship:'same-project'}).key,a.baseScope)
})
test('requestId deduplication is scoped to caller and mapped project',async t=>{
  const f=fixture(t)
  const a=scopeRequest({callerConversationId:'a',callerProjectKey:'p',requestId:'first'},f.options)
  const b=scopeRequest({callerConversationId:'b',callerProjectKey:'p',requestId:'first'},f.options)
  assert.notEqual(a.requestId,b.requestId)
  assert.equal(scopeRequest(a,f.options).requestId,a.requestId)
  assert.equal(scopeRequest({routing:'manual',requestId:'legacy'},f.options).requestId,'legacy')
  const bridge=createBridge({dbPath:f.dbPath,port:1,lockPath:f.lockPath,callerContextSource:'mcp'})
  for(const [id,scoped]of [['a',a],['b',b]]) {
    f.row(id);f.log(id,[{...user(`TASK-${id}`),timestamp:2100},assistant(`answer-${id}`)])
    createTicket(f.options,{task:`TASK-${id}`,requestId:scoped.requestId,since:2000,sessionId:id})
  }
  const ra=await bridge.callTool('workbuddy_send',{callerConversationId:'a',callerProjectKey:'p',requestId:'first',task:'TASK-a'})
  const rb=await bridge.callTool('workbuddy_run',{callerConversationId:'b',callerProjectKey:'p',requestId:'first',task:'TASK-b'})
  assert.equal(ra.sessionId,'a');assert.equal(rb.sessionId,'b');assert.notEqual(ra.dispatchId,rb.dispatchId)
})
test('routing persists hashed keywords instead of the complete prompt',t=>{
  const f=fixture(t),a=caller(),binding=readBinding(f.options,a.baseScope),task='DoNotPersistThisWholePrompt 需要修改接口源码'
  rememberCall(f.options,a,a.baseScope,binding,{task,resolvedSession:'new'},{sessionId:'last'})
  const raw=fs.readFileSync(path.join(path.dirname(f.dbPath),'bridge-routing',fs.readdirSync(path.join(path.dirname(f.dbPath),'bridge-routing'))[0]),'utf8')
  assert.ok(!raw.includes('DoNotPersistThisWholePrompt'))
  assert.ok(readBinding(f.options,a.baseScope).threads.a.taskKeywords.every(k=>/^[a-f0-9]{16}$/.test(k)))
})
test('native space sentinel -1 is active and existing mapping is verified without any UI',async t=>{
  const f=fixture(t)
  f.db.exec('create table spaces(id text,name text,status text,primary_folder_path text,deleted_at integer)')
  f.db.prepare('insert into spaces values(?,?,?,?,?)').run('native','name','active',null,-1)
  f.db.prepare('insert into spaces values(?,?,?,?,?)').run('deleted','old','active',null,999)
  assert.equal((await listProjects(f.options)).length,1)
  const binding={scopeKey:caller().baseScope,threads:{},project:{id:'native',name:'stale-name'}}
  assert.equal((await ensureProject(f.options,caller(),binding)).name,'name')
})
test('MCP per-call metadata supplies the caller context to project inspection',t=>{
  const f=fixture(t),config=path.join(f.root,'config.json')
  fs.writeFileSync(config,JSON.stringify({dbPath:f.dbPath,lockPath:f.lockPath}))
  const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'workbuddy_project',arguments:{action:'get'},_meta:{callerConversationId:'metadata-a',callerProjectKey:'metadata-project'}}}
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/mcp.mjs',import.meta.url))],{input:JSON.stringify(request)+'\n',encoding:'utf8',windowsHide:true,timeout:5000,env:{...process.env,WORKBUDDY_BRIDGE_CONFIG:config}})
  assert.equal(child.status,0,child.stderr)
  const result=JSON.parse(child.stdout).result.structuredContent
  assert.equal(result.caller.conversationId,'metadata-a');assert.equal(result.caller.projectKey,'metadata-project');assert.equal(result.exists,false)
})
test('expert prefilled sample is removed and the full submitted task is verified',async()=>{
  const editor={textContent:'专家预填示例：请帮我开发一个应用',scrollIntoView(){},getBoundingClientRect:()=>({x:0,y:0,width:100,height:30})}
  const button={className:'cr-send-button',hasAttribute:()=>false,getBoundingClientRect:()=>({x:110,y:0,width:30,height:30})}
  const document={querySelectorAll:selector=>selector.includes('contenteditable')||selector==='._editable_1cxd2_1'?[editor]:selector==='.cr-send-button'?[button]:[]}
  const connection={evaluate:code=>vm.runInNewContext(code,{document,getComputedStyle:()=>({visibility:'visible',display:'block',opacity:1})}),click:async()=>{},selectAll:async()=>{},key:async keys=>{if(keys[0]==='Backspace')editor.textContent=''},insertText:async text=>{editor.textContent+=text}}
  const result=await typeTask(connection,'THIS IS THE REAL TASK')
  assert.equal(editor.textContent,'THIS IS THE REAL TASK')
  assert.equal(result.prefillRemoved,true);assert.equal(result.exactMatchVerified,true);assert.equal(result.clearedBeforeInsert,true)
})
