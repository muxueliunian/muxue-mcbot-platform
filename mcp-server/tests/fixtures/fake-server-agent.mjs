// Offline Claude/Codex protocol peer with a simulated MCP lease owner; no model or game.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const kind = process.env.FAKE_SERVER_AGENT;
const record = (value) => fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ pid: process.pid, ...value })+'\n');
const emit = (value) => process.stdout.write(JSON.stringify(value)+'\n');
const arg = (args, key) => args[args.indexOf(key)+1];
let owner, connection, controlFile, lockFile, lockContent, heartbeat, threadId, turnId, turn = 0;
const rpc = async (method, params) => {
  const response = await fetch(connection.endpoint, {method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({method,params})});
  const value = await response.json();
  if (!value.ok) throw new Error(value.error.code);
  return value.result;
};
async function connect(server) {
  const a = server.args;
  const connectionFile = arg(a,'--connection-file');
  connection = JSON.parse(fs.readFileSync(connectionFile,'utf8'));
  const hello = await rpc('hello',{});
  const controllerId = arg(a,'--controller-id');
  const lease = await rpc('claim',{instanceId:hello.instanceId,worldId:connection.worldId,username:connection.username,controllerId});
  owner = {protocol:2,backend:'server',connectionFile,worldId:connection.worldId,username:connection.username,controllerId,...lease};
  const runtime = arg(a,'--runtime-dir');
  controlFile=path.join(runtime,`server-control-${connection.username}.json`);
  lockFile=path.join(runtime,`client-body-${connection.username}.lock`);
  lockContent=JSON.stringify({pid:process.pid,id:`fake-lock-${process.pid}`});
  fs.writeFileSync(lockFile,lockContent,{flag:'wx'});
  fs.writeFileSync(controlFile,JSON.stringify(owner));
  // Deliberately never append chat: the host must watch independently.
  fs.writeFileSync(path.join(runtime,`events-${connection.username}.jsonl`),'');
  record({kind:'connected',controllerId});
  heartbeat=setInterval(()=>{rpc('heartbeat',owner).catch(()=>{});},300);
}
function cleanup() {
  clearInterval(heartbeat);
  try { if(JSON.parse(fs.readFileSync(controlFile,'utf8')).leaseId===owner?.leaseId) fs.rmSync(controlFile); } catch{}
  try { if(fs.readFileSync(lockFile,'utf8')===lockContent) fs.rmSync(lockFile); } catch{}
}
function finish(text) {
  record({kind:'turn',text});
  if(text.includes('[crash]')) {cleanup(); record({kind:'crash'}); process.exit(17);}
  if(text.includes('[hold]')) return;
  if(text.includes('[error]')) {
    if(kind==='claude') emit({type:'result',is_error:true,result:'fake turn error'});
    else emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',items:[],error:{message:'fake turn error'}}}});
    return;
  }
  if(kind==='claude') {
    emit({type:'assistant',message:{usage:{input_tokens:10},content:[{type:'text',text:'收到'}]}});
    emit({type:'result',is_error:false});
  } else emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[],error:null}}});
}
record({kind:'start',argv:process.argv.slice(2),toolSearch:process.env.ENABLE_TOOL_SEARCH});
if(kind==='claude') {
  const file=arg(process.argv,'--mcp-config');
  await connect(JSON.parse(fs.readFileSync(file,'utf8')).mcpServers.minecraft);
  emit({type:'system',subtype:'init',session_id:`server-fake-${process.pid}`});
}
const rl=readline.createInterface({input:process.stdin});
rl.on('line',async line=>{
  const msg=JSON.parse(line);
  if(kind==='claude') {finish(msg.message.content);return;}
  const {id,method,params={}}=msg;
  record({kind:'request',method});
  const reply=(result)=>emit({id,result});
  if(method==='initialize') return reply({userAgent:'fake',platformFamily:'windows',platformOs:'windows'});
  if(method==='initialized') return;
  if(method==='account/read') return reply({account:{type:'chatgpt',planType:'pro'},requiresOpenaiAuth:false});
  if(method==='config/read') return reply({config:{mcp_servers:{}}});
  if(method==='thread/start'||method==='thread/resume') {
    await connect(params.config.mcp_servers.minecraft);
    threadId=`server-fake-${process.pid}`;
    return reply({thread:{id:threadId,turns:[]},model:'fake',modelProvider:'openai',reasoningEffort:'low'});
  }
  if(method==='turn/start') {
    turnId=`turn-${++turn}`;
    reply({turn:{id:turnId,status:'inProgress',items:[]}});
    finish(params.input.map(x=>x.text||'').join('\n'));
    return;
  }
  if(method==='turn/interrupt') {
    reply({});
    emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[],error:null}}});
    return;
  }
  if(id!==undefined) emit({id,error:{code:-32601,message:'unsupported fake method'}});
});
rl.on('close',()=>{record({kind:'stdin_closing'});setTimeout(()=>{if(!process.env.FAKE_AGENT_LEAVE_FILES)cleanup();record({kind:'stdin_closed'});process.exit(0);},Number(process.env.FAKE_AGENT_CLOSE_DELAY_MS)||0);});
