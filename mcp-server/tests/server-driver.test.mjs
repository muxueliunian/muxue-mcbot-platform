import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs,bodySessionScope,runtimeFiles,startupPrompt,readSessionState,completeServerChat,captureBodyArtifacts,cleanupBodyArtifacts,taskAlreadyDelivered,isWakeEvent} from '../../scripts/companion.mjs';
import {createServerBodyControl} from '../../scripts/server-body-control.mjs';
import {CODEX_SERVER_TOOLS,codexThreadConfig} from '../../scripts/agents/codex-app-server.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'../..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const v=fn();if(v)return v;await sleep(30);}throw Error(`等待超时: ${label}`);}
const records=file=>{try{return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return[];}};
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'mcbot-server-driver-'));}
function cleanup(dir){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('mcbot-server-driver-'));fs.rmSync(dir,{recursive:true,force:true});}
async function mock(){
  const state={instanceId:'instance-a',sessionId:'session-a',worldId:'world-a',username:'ServerTest',seq:10,chat:[{seq:10,username:'tester',message:'停下'}],lease:null,revoked:null,claims:0,calls:[],revokeCount:0};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const p of req)raw+=p;const {method,params:p}=JSON.parse(raw);state.calls.push({method,leaseId:p.leaseId,...(p.leave!==undefined?{leave:p.leave}:{})});
    const ok=result=>res.end(JSON.stringify({ok:true,result}));const fail=code=>res.end(JSON.stringify({ok:false,error:{code,message:code}}));
    if(req.headers.authorization!=='Bearer test-only-token')return fail('FORBIDDEN');
    if(method==='hello')return ok({protocol:2,backend:'server',instanceId:state.instanceId,sessionId:state.sessionId,worldId:state.worldId,username:state.username,connected:true,capabilities:[]});
    // Like the server: a revoke may name the session the body already left (it is matched against the retired lease).
    if(p.instanceId!==state.instanceId||p.sessionId&&p.sessionId!==state.sessionId&&method!=='revoke')return fail('WRONG_INSTANCE');
    if(method==='claim'){
      if(state.lease)return fail('LEASE_BUSY');
      state.lease={leaseId:`lease-${++state.claims}`,stopToken:`stop-${state.claims}`,instanceId:state.instanceId,sessionId:state.sessionId,chatCursor:state.seq,ttlMs:10000,controlGeneration:1};
      return ok(state.lease);
    }
    const current=state.lease?.leaseId===p.leaseId;
    const old=state.revoked?.leaseId===p.leaseId&&state.revoked.stopToken===p.stopToken;
    if(method==='revoke'){
      if(current&&state.lease.stopToken===p.stopToken){state.revoked=state.lease;state.lease=null;state.revokeCount++;if(state.beforeRevokeReply)await state.beforeRevokeReply();return ok({stopped:true,revoked:true});}
      if(old)return ok({stopped:true,revoked:true});
      return fail('LEASE_LOST');
    }
    if(method==='watch'){
      const allowed=(current&&state.lease.stopToken===p.stopToken)||(!state.lease&&old);
      const snapshot={chat:[...state.chat],chatCursor:state.seq};
      if(state.beforeWatch)await state.beforeWatch();
      if(allowed)return ok(snapshot);
      return fail('LEASE_LOST');
    }
    if(method==='heartbeat')return current?ok({ttlMs:10000,controlGeneration:1}):fail('LEASE_LOST');
    return fail('UNSUPPORTED');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{state,endpoint:`http://127.0.0.1:${server.address().port}/v2`,add(username,message){state.chat.push({seq:++state.seq,username,message,timestamp:Date.now()});},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

test('ServerBody 参数、提示与工具不继承旧进服/记忆路径',()=>{
  for(const agent of ['claude','codex','dsh']){
    const args=parseArgs(['--agent',agent,'--body','server','--server-check-seconds','1']);assert.equal(args.serverCheckSeconds,0);
    assert.match(startupPrompt(args,true),/ServerBody/);assert.doesNotMatch(startupPrompt(args,true),/调用 memory-context 读记忆|会自动进服|会被自动下线/);
    assert.match(startupPrompt(args,true),/components/);assert.match(startupPrompt(args,true),/revision/);assert.match(startupPrompt(args,true),/不自动复活/);
    assert.match(startupPrompt(args,true),/discover-containers → fetch-and-give/);assert.match(startupPrompt(args,true),/wholeTree:true/);assert.match(startupPrompt(args,true),/details:true/);
    assert.doesNotMatch(startupPrompt(args,true),/每轮先查询当前状态|完整复制状态与 components/);
    assert.equal(bodySessionScope(args,['--world-id','a','--connection-file','x']).body,'server');
  }
  assert.throws(()=>parseArgs(['--agent','gemini','--body','server']),/仅接通 Claude、Codex、dsh/);
  assert.throws(()=>parseArgs(['--agent','dsh','--body','client']),/仅接通 Codex/);
  assert.deepEqual(codexThreadConfig({}, {command:'node',args:[]},ROOT,'server').mcp_servers.minecraft.enabled_tools,CODEX_SERVER_TOOLS);
  assert.equal(CODEX_SERVER_TOOLS.includes('dig-block'),true);
  assert.equal(CODEX_SERVER_TOOLS.includes('select-slot'),true);
  assert.equal(CODEX_SERVER_TOOLS.includes('drop-item'),true);
  assert.equal(CODEX_SERVER_TOOLS.includes('respawn'),false);
  for(const tool of ['discover-containers','container-list','container-withdraw','give-item','fetch-and-give']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['approach-container','approach-player']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['companion-mode','get-companion-mode']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['discover-resources','gather-resources','collect-items','look-around','pillar-up','pillar-down','sleep-in-bed','wake-up','craft-item','smelt-item','travel-to','remember-place','list-places','forget-place','go-to-place','workstation-options','produce-item','modify-item','tend-crops','breed-animals','use-bucket']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['get-survival-state','assess-tool','prepare-item','eat-food','set-reflexes','defend-self']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  assert.equal(CODEX_SERVER_TOOLS.includes('interact-block'),true);
  assert.equal(CODEX_SERVER_TOOLS.length,58);
});

test('持续陪伴只为受阻通知唤醒，普通状态变化不产生空闲回合',()=>{
  assert.equal(isWakeEvent({type:'companion',text:'跟随受阻，等待明确继续'}),true);
  assert.equal(isWakeEvent({type:'companion_state',text:'following -> waiting'}),false);
  const prompt=startupPrompt(parseArgs(['--agent','claude','--body','server']),false);
  assert.match(prompt,/不为聊天停止跟随/);
  assert.match(prompt,/不自动 resume/);
});

for(const agent of ['claude','codex','dsh'])test(`ServerBody 真驱动+${agent}：journal卡住仍叫停，缓存能力重接且无旧TCP/RCON`,async()=>{
  const dir=temp(),api=await mock();const runtime=path.join(dir,'runtime');fs.mkdirSync(runtime);
  const connectionFile=path.join(dir,'connection.json');fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:'world-a',username:'ServerTest'}));
  const configFile=path.join(dir,'mcp.json');const original=Buffer.from(JSON.stringify({mcpServers:{minecraft:{command:process.execPath,args:['not-executed.mjs','--body','server','--connection-file',connectionFile,'--world-id','world-a','--username','ServerTest']},unrelatedFiles:{command:'not-started-filesystem-server'}}}));fs.writeFileSync(configFile,original);
  const F=runtimeFiles(runtime,'ServerTest'),agentLog=path.join(dir,'agent.jsonl');
  let tcp=0;const canary=net.createServer(s=>{tcp++;s.destroy();});await new Promise(r=>canary.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(dir,'server.properties'),`rcon.port=${canary.address().port}\nrcon.password=unused-test-password\n`);
  let output='',driver,exit;
  try{
    driver=spawn(process.execPath,[path.join(ROOT,'scripts/companion.mjs'),'--agent',agent,'--body','server','--name','ServerTest','--nickname','小克','--mcp-config',configFile,'--headless','--mc-port',String(canary.address().port),'--server-check-seconds','0.05'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MC_SERVER_DIR:dir,COMPANION_RUNTIME_DIR:runtime,COMPANION_MEMORY_DIR:path.join(dir,'memory'),COMPANION_AGENT_CMD:JSON.stringify([process.execPath,path.join(HERE,'fixtures/fake-server-agent.mjs')]),FAKE_SERVER_AGENT:agent,FAKE_AGENT_LOG:agentLog,FAKE_AGENT_CLOSE_DELAY_MS:'1200',FAKE_AGENT_LEAVE_FILES:agent==='codex'?'1':''}});
    driver.stdout.on('data',d=>output+=d);driver.stderr.on('data',d=>output+=d);exit=new Promise(r=>driver.once('exit',r));
    await waitFor(()=>api.state.claims===1&&records(agentLog).some(r=>r.kind==='turn'),'startup');
    const hostedConfig=JSON.parse(fs.readFileSync(path.join(runtime,'mcp-hosted-ServerTest.json'),'utf8'));
    assert.deepEqual(Object.keys(hostedConfig.mcpServers),['minecraft'],'other MCP servers cannot enter game mode');
    if(agent==='claude'){
      const start=records(agentLog).find(r=>r.kind==='start'),argv=start.argv;
      assert.equal(argv[argv.indexOf('--permission-mode')+1],'dontAsk');
      assert.equal(argv[argv.indexOf('--tools')+1],'');
      assert.equal(argv[argv.indexOf('--permission-prompts')+1],'none');
      assert.ok(argv.includes('--restricted'));
      assert.equal(start.toolSearch,'false');
      assert.match(argv[argv.indexOf('--append-system-prompt')+1],/宿主只读加载/);
    }
    if(agent==='dsh'){
      const mcp=records(agentLog).find(r=>r.kind==='mcp');
      assert.equal(mcp.name,'minecraft');assert.ok(path.isAbsolute(mcp.command),'ACP 的 MCP 命令必须是绝对路径');assert.equal(path.resolve(mcp.cwd),ROOT);
      assert.deepEqual(records(agentLog).filter(r=>r.configId).map(r=>[r.configId,r.value]),[['reasoning_effort','low']],'默认思考档位 low，不改模型');
    }
    await waitFor(()=>api.state.calls.some(c=>c.method==='watch'),'independent watch');
    assert.equal(api.state.revokeCount,0,'claim之前历史stop跳过');
    const startupTurns=records(agentLog).filter(r=>r.kind==='turn').length;
    fs.appendFileSync(F.events,JSON.stringify({session:'attached',seq:1,timestamp:Date.now(),type:'spawn',text:'already attached'})+'\n');
    await sleep(1700);
    assert.equal(records(agentLog).filter(r=>r.kind==='turn').length,startupTurns,'ServerBody接管事件不额外唤醒空闲模型轮');
    const quickStart=Date.now();
    for(const [seq,text] of [[1,'tester: 小克查询位置'],[2,'tester: 小克查询背包']]) fs.appendFileSync(F.events,JSON.stringify({session:'quick',seq,timestamp:Date.now(),type:'chat',text})+'\n');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('小克查询位置')),'prompt fast chat');
    assert.ok(Date.now()-quickStart<1100,'明确空闲聊天不再固定等待1500ms');
    const quick=records(agentLog).find(r=>r.kind==='turn'&&r.text.includes('小克查询位置'));assert.match(quick.text,/小克查询背包/);
    const beforeTurns=records(agentLog).filter(r=>r.kind==='turn').length;
    api.add(null,'小克停下');api.add('ServerTest','停下');api.add('tester','普通聊天');await sleep(650);
    assert.equal(api.state.revokeCount,0);assert.equal(records(agentLog).filter(r=>r.kind==='turn').length,beforeTurns,'watch普通聊天不重复唤醒');
    fs.appendFileSync(F.events,JSON.stringify({session:'current',seq:1,timestamp:Date.now(),type:'chat',text:'tester: [error] 小克检查错误'})+'\n');
    await waitFor(()=>output.includes('fake turn error'),'error notification');assert.equal(tcp,0,'出错通知也不能调用旧RCON');
    fs.appendFileSync(F.events,JSON.stringify({session:'current',seq:2,timestamp:Date.now(),type:'chat',text:'tester: [hold] 小克跟着我'})+'\n');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('[hold]')),'busy turn');
    const journal=fs.readFileSync(F.events);api.add('tester','小克，停下');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='stdin_closing'),'teardown started');
    api.add('tester','小克，收尾期间查询位置');
    api.add('tester','小克，收尾期间再查询背包');
    await waitFor(()=>api.state.revokeCount===1&&records(agentLog).some(r=>r.kind==='stdin_closed'),'direct revoke and Agent ended');
    assert.deepEqual(fs.readFileSync(F.events),journal,'MCP journal没更新也已停止');
    const firstOwner=records(agentLog).find(r=>r.kind==='connected').controllerId;
    await waitFor(()=>api.state.claims===2&&records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('停止后的新指令')),'new explicit task reconnect');
    const resumed=records(agentLog).find(r=>r.kind==='turn'&&r.text.includes('停止后的新指令'));
    assert.match(resumed.text,/收尾期间查询位置/);assert.match(resumed.text,/收尾期间再查询背包/);
    await sleep(650);assert.equal(records(agentLog).filter(r=>r.kind==='turn'&&r.text.includes('收尾期间')).length,1,'收尾期间新消息仅投递一次');
    assert.doesNotMatch(resumed.text,/\[hold\]/);assert.equal(records(agentLog).filter(r=>r.kind==='connected').at(-1).controllerId,firstOwner);
    await waitFor(()=>api.state.calls.some(c=>c.method==='watch'&&c.leaseId==='lease-2'),'host cached replacement lease');
    await sleep(450);
    fs.appendFileSync(F.events,JSON.stringify({session:'second',seq:1,timestamp:Date.now(),type:'chat',text:'tester: [crash] 小克测试退出'})+'\n');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='crash')&&api.state.revokeCount===2,'Agent删除控制文件后退出仍用缓存revoke');
    await sleep(400);assert.equal(api.state.claims,2,'崩溃后不自动claim/恢复旧任务');
    api.add('tester','小克，重新查询状态');
    await waitFor(()=>api.state.claims===3,'crash后明确新任务');
    if(agent==='claude')for(const start of records(agentLog).filter(r=>r.kind==='start')){
      assert.equal(start.argv[start.argv.indexOf('--tools')+1],'','restarted Agent retains empty built-in tool set');
      assert.equal(start.argv[start.argv.indexOf('--permission-mode')+1],'dontAsk');
    }
    assert.equal(tcp,0);assert.deepEqual(fs.readFileSync(configFile),original);
    assert.doesNotMatch(output,/test-only-token|stop-1|stop-2|stop-3|RCON 发送失败/);
    fs.writeFileSync(F.stop,'');let exitTimer;try{assert.equal(await Promise.race([exit,new Promise(r=>{exitTimer=setTimeout(()=>r(-1),10000);})]),0,output);}finally{clearTimeout(exitTimer);}
    assert.equal(api.state.revokeCount,3,'shutdown先撤销当前控制');
    assert.equal(fs.existsSync(path.join(runtime,'server-control-ServerTest.json')),false,'宿主清理已退出Agent留下的自身控制文件');
    assert.equal(fs.existsSync(path.join(runtime,'client-body-ServerTest.lock')),false,'宿主清理同一已退出Body锁');
    const methods=new Set(api.state.calls.map(c=>c.method));assert.deepEqual([...methods].sort(),['claim','heartbeat','hello','revoke','watch']);
  }catch(error){
    fs.mkdirSync(path.join(ROOT,'output'),{recursive:true});
    fs.writeFileSync(path.join(ROOT,`output/server-driver-${agent}-failure.json`),JSON.stringify({message:error.message,output,agent:records(agentLog),calls:api.state.calls},null,2));
    throw error;
  }finally{
    if(driver&&driver.exitCode===null&&driver.signalCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else driver.kill();}
    if(exit)await exit;await api.close();await new Promise(r=>canary.close(r));cleanup(dir);
  }
});

test('ServerBody快路径仅完整明确聊天，半句话留给补充或澄清',()=>{
  const args={name:'ServerTest',nickname:'小克'};
  for(const text of ['tester: 小克，查询现在的位置','tester: 小克把旁边箱子里的3个原木给我','tester: 小克，你好吗？']) assert.equal(completeServerChat({type:'chat',text},args),true,text);
  for(const text of ['tester: 小克','tester: 小克帮我','tester: 小克把箱子里的','tester: 小克帮我拿箱子里的','tester: 小克我想让你','tester: 小克拿','tester: 小克，给我原木，然后','tester: 随便聊聊']) assert.equal(completeServerChat({type:'chat',text},args),false,text);
});

test('宿主只清理已退出的自身Body快照，不删除替换的控制文件或锁',()=>{
  const dir=temp(),controlFile=path.join(dir,'server-control-ServerTest.json'),lockFile=path.join(dir,'client-body-ServerTest.lock');
  const owner={controllerId:'mine',instanceId:'instance',sessionId:'session',leaseId:'lease',connectionFile:'connection',username:'ServerTest',worldId:'world'};
  const original=JSON.stringify(owner),originalLock=JSON.stringify({pid:1234567,id:'old-lock'});
  const reset=()=>{fs.writeFileSync(controlFile,original);fs.writeFileSync(lockFile,originalLock);};
  try{
    reset();assert.equal(captureBodyArtifacts(dir,'ServerTest',{...owner,controllerId:'other'}),null);
    const snapshot=captureBodyArtifacts(dir,'ServerTest',owner);
    assert.equal(cleanupBodyArtifacts(snapshot,()=>true),false);assert.equal(fs.existsSync(lockFile),true);
    fs.writeFileSync(controlFile,JSON.stringify({...owner,leaseId:'new-lease'}));assert.equal(cleanupBodyArtifacts(snapshot,()=>false),false);assert.equal(fs.existsSync(lockFile),true);
    reset();fs.writeFileSync(lockFile,JSON.stringify({pid:1234567,id:'replacement-lock'}));assert.equal(cleanupBodyArtifacts(snapshot,()=>false),false);assert.equal(fs.readFileSync(controlFile,'utf8'),original);
    reset();assert.equal(cleanupBodyArtifacts(snapshot,()=>false),true);assert.equal(fs.existsSync(controlFile),false);assert.equal(fs.existsSync(lockFile),false);
  }finally{cleanup(dir);}
});

test('任务交付回执只过滤同会话同operation的终态事件，不吞聊天或无ID旧事件',()=>{
  const receipt={session:'current',operationIds:['op-1']};
  assert.equal(taskAlreadyDelivered({type:'task',session:'current',operationId:'op-1'},receipt),true);
  assert.equal(taskAlreadyDelivered({type:'companion',session:'current',operationId:'op-1'},receipt),true);
  assert.equal(taskAlreadyDelivered({type:'companion',session:'current',operationId:'op-2'},receipt),false);
  assert.equal(taskAlreadyDelivered({type:'companion',session:'old',operationId:'op-1'},receipt),false);
  for(const e of [{type:'chat',session:'current',operationId:'op-1'},{type:'task',session:'old',operationId:'op-1'},{type:'task',session:'current'},{type:'task',session:'current',operationId:'op-2'}]) assert.equal(taskAlreadyDelivered(e,receipt),false);
});

test('延迟watch的旧停止消息不会撤销已经替换的新lease',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const old={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  const next={...old,leaseId:'next',stopToken:'next-stop',chatCursor:11};
  const file=path.join(dir,'server-control-ServerTest.json');fs.writeFileSync(file,JSON.stringify(old));api.state.lease=old;api.add('tester','停下');
  let stopCallbacks=0;
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>true,isNewTask:()=>false,onStop:()=>{stopCallbacks++;},onNewTask:()=>{}});
  try{
    api.state.beforeWatch=async()=>{fs.writeFileSync(file,JSON.stringify(next));api.state.lease=next;};
    await control.poll();assert.equal(api.state.revokeCount,0);assert.equal(stopCallbacks,0);assert.equal(api.state.lease.leaseId,'next');
    assert.equal(api.state.calls.some(c=>c.method==='revoke'),false);
  }finally{control.close();await api.close();cleanup(dir);}
});

test('watch拒收的新任务保留重试，后来的stop优先且旧聊天不重放',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));api.state.lease=owner;
  let accept=false,stops=0;const attempts=[],delivered=[];
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:e=>e.message==='停下',isNewTask:e=>e.message.startsWith('小克'),
    onStop:()=>{stops++;},onNewTask:e=>{attempts.push(e.message);if(!accept)return false;delivered.push(e.message);return true;}});
  try{
    api.add('tester','停下');await control.poll();
    api.add('tester','小克查询位置');await control.poll();assert.equal(attempts.length,1);
    await control.poll();assert.equal(attempts.length,2,'拒收后下一次watch必须重试');
    api.add('tester','停下');api.add('tester','小克查询背包');accept=true;
    await control.poll();await control.poll();
    assert.equal(stops,2,'待发任务不能挡住后面的stop');
    assert.deepEqual(delivered,['小克查询背包'],'stop之前未执行的旧任务取消，之后任务仅投递一次');
  }finally{control.close();await api.close();cleanup(dir);}
});

test('crash后撤销回执在途时的新明确聊天保留，到撤销确认后只投递一次',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));api.state.lease=owner;
  let release;api.state.beforeRevokeReply=()=>new Promise(resolve=>{release=resolve;});
  const delivered=[];
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:e=>e.message.startsWith('小克'),onStop:()=>{},onNewTask:e=>{delivered.push(e.message);return true;}});
  try{
    control.capture();const stopping=control.revoke();
    await waitFor(()=>release,'held revoke response');
    api.add('tester','小克，崩溃后查询状态');await control.poll();
    assert.deepEqual(delivered,[],'撤销尚未确认不启动新任务');
    release();await stopping;await control.poll();await control.poll();
    assert.deepEqual(delivered,['小克，崩溃后查询状态'],'不能因为stopped标记尚未更新而吞掉新消息');
  }finally{release?.();control.close();await api.close();cleanup(dir);}
});

test('start-server-play PrepareOnly读取v2身份和显式Node路径但不运行Agent且不写token',()=>{
  const dir=temp();const connectionFile=path.join(dir,'connection.json');
  const unique=`Prep${process.pid}`;
  fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:'http://127.0.0.1:8766/v2',token:'prepare-test-secret',worldId:'prepare-world',username:unique}));
  const generated=path.join(ROOT,'runtime/server-play',unique);
  try{
    const result=spawnSync('pwsh',['-NoProfile','-File',path.join(ROOT,'start-server-play.ps1'),'-ConnectionFile',connectionFile,'-NodePath',process.execPath,'-PrepareOnly'],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/prepare-test-secret/);
    const text=fs.readFileSync(path.join(generated,'mcp.json'),'utf8');assert.doesNotMatch(text,/prepare-test-secret/);
    const configured=JSON.parse(text).mcpServers.minecraft;assert.equal(path.resolve(configured.command),path.resolve(process.execPath));
    const args=configured.args;assert.equal(args[args.indexOf('--body')+1],'server');assert.equal(args[args.indexOf('--username')+1],unique);assert.equal(args[args.indexOf('--world-id')+1],'prepare-world');
  }finally{
    assert.equal(path.dirname(path.resolve(generated)),path.resolve(ROOT,'runtime/server-play'));assert.equal(path.basename(generated),unique);fs.rmSync(generated,{recursive:true,force:true});cleanup(dir);
  }
});

test('宿主只接自身controller，旧capability不撤销新lease或新instance',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const old={protocol:2,backend:'server',...scope,controllerId:'owner-a',instanceId:'instance-a',sessionId:'session-a',leaseId:'lease-old',stopToken:'stop-old',chatCursor:10};
  const file=path.join(dir,'server-control-ServerTest.json');fs.writeFileSync(file,JSON.stringify({...old,controllerId:'other'}));
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner-a',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    for(const mismatch of [{controllerId:'other'},{worldId:'other-world'},{username:'OtherBot'},{connectionFile:path.join(dir,'other.json')}]){
      fs.writeFileSync(file,JSON.stringify({...old,...mismatch}));
      assert.deepEqual(await control.revoke(),{stopped:false,reason:'NO_OWN_CONTROL'});assert.equal(api.state.calls.length,0);
    }
    fs.writeFileSync(file,JSON.stringify(old));control.capture();fs.rmSync(file);
    api.state.revoked=old;api.state.lease={...old,leaseId:'lease-new',stopToken:'stop-new'};
    assert.equal((await control.revoke()).revoked,true);assert.equal(api.state.lease.leaseId,'lease-new');assert.equal(api.state.revokeCount,0);
    api.state.instanceId='instance-b';await assert.rejects(control.revoke(),/CONTROL_IDENTITY_CHANGED/);assert.equal(api.state.lease.leaseId,'lease-new');
    assert.equal(api.state.calls.filter(c=>c.method==='revoke').length,1);
  }finally{control.close();await api.close();cleanup(dir);}
});

test('宿主退出时撤销带 leave，让角色下线；普通叫停不带',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'lease-1',stopToken:'stop-1',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));
  api.state.lease={...owner};
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    await control.revoke();
    await control.revoke(undefined,{leave:true});
    const revokes=api.state.calls.filter(c=>c.method==='revoke');
    assert.equal(revokes.length,2);assert.equal(revokes[0].leave,undefined);assert.equal(revokes[1].leave,true);
  }finally{control.close();await api.close();cleanup(dir);}
});

test('角色死后重生换了会话，宿主退出时照样能撤销并让角色下线',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'lease-1',stopToken:'stop-1',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));
  // The body died: the server retired the lease and rotated the session.
  api.state.revoked={...owner};api.state.lease=null;api.state.sessionId='session-b';
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    assert.equal((await control.revoke(undefined,{leave:true})).revoked,true);
    const revokes=api.state.calls.filter(c=>c.method==='revoke');assert.equal(revokes.length,1);assert.equal(revokes[0].leave,true);
    await control.poll();assert.equal(api.state.calls.filter(c=>c.method==='watch').length,0,'普通的监听仍然要求会话一致');
  }finally{control.close();await api.close();cleanup(dir);}
});