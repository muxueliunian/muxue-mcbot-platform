#!/usr/bin/env node
// B4 death persistence: root owns server shutdown/restart between prepare and verify.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ServerBody,readServerConnection} from '../client-runtime/dist/server-body.js';
import {rcon,readServerProps} from './rcon.mjs';

const options={};
for(let i=2;i<process.argv.length;i++) {
  const key=process.argv[i];
  if(key==='--help') {
    console.log('node scripts/server-body-dead-save-smoke.mjs --phase prepare|verify|verify-direct|kick --allow-fixture [--checkpoint file] [--output file]\nprepare intentionally leaves the isolated test NPC dead and saves it; root then stops/restarts the server. verify checks dead save rejection then explicit CLI respawn. kick checks death -> kick -> explicit respawn in one service. No models/server launch; all phases restrict identity/world/ports and refuse other players.');
    process.exit(0);
  }
  if(key==='--allow-fixture') options.allow=true;
  else if(['--phase','--checkpoint','--output'].includes(key)&&process.argv[i+1]) options[key.slice(2)]=process.argv[++i];
  else throw Error(`Unknown or missing argument: ${key}`);
}
assert(options.allow&&['prepare','verify','verify-direct','kick'].includes(options.phase),'Require --allow-fixture and --phase prepare|verify|verify-direct|kick');
const root=path.resolve('.'),serverDir=path.join(root,'runtime/serverbody-validation');
const checkpointFile=path.resolve(options.checkpoint||'output/serverbody-dead-save-checkpoint.json');
const output=path.resolve(options.output||`output/serverbody-dead-save-${options.phase}.json`);
const evidence={started:new Date().toISOString(),phase:options.phase,checks:[],fixtures:[],cleanup:[],scope:'Only isolated ServerBot; explicit real Node --respawn-only through method-recording loopback relay; no model/server lifecycle action or hashes'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let connection,body,lease,checkpoint,mutated=false,leaveDead=false;

function check(name,passed,detail) {
  evidence.checks.push({name,passed:!!passed,...(detail===undefined?{}:{detail})});
  assert(passed,name);console.log(`PASS ${name}`);
}
async function command(text) {
  const [reply]=await rcon([text],{serverDir});evidence.fixtures.push({command:text,reply});return reply;
}
async function alone() {
  const reply=(await command('list')).trim();
  const match=reply.match(/:\s*([^\r\n]*)$/);assert(match,'Cannot parse list; refuse mutations');
  const names=match[1].split(',').map(name=>name.trim()).filter(Boolean);
  assert(names.every(name=>name==='ServerBot'),'Other player present; refuse mutations');return names;
}
async function fixture(text) {await alone();mutated=true;const reply=await command(text);if(/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply))throw Error(`Fixture rejected: ${text}: ${reply.trim()}`);return reply;}
async function wire(method,params={}) {
  const response=await fetch(connection.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{'content-type':'application/json',authorization:`Bearer ${connection.token}`},body:JSON.stringify({method,params})});
  return response.json();
}
async function rpc(method,params={}) {
  const value=await wire(method,params);if(!value.ok)throw Object.assign(Error(`${method}: ${value.error?.code}`),{code:value.error?.code});return value.result;
}
async function until(label,read) {
  const end=Date.now()+12000;while(Date.now()<end){const value=await read();if(value)return value;await delay(100);}throw Error(`Timeout: ${label}`);
}
async function connect() {
  body=await ServerBody.connect({connection,worldId:connection.worldId,username:connection.username,claimWaitMs:0,onLease(value){lease=value;}});
}
async function fixtureState() {
  const reply=await command('mcbot-respawn-fixture status'),prefix='MCBOT_RESPAWN_FIXTURE ',index=reply.indexOf(prefix);
  assert(index>=0,'Respawn test fixture not available');return JSON.parse(reply.slice(index+prefix.length).trim());
}
async function saveJson(file,value) {await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');}
const auth=owner=>({instanceId:owner.instanceId,sessionId:owner.sessionId,leaseId:owner.leaseId});

async function prepareDeath() {
  await connect();const initial=await body.observe(),hello=await rpc('hello'),spawn=await fixtureState();
  check('fixture enabled and unique native body',spawn.enabled&&spawn.bodyClass==='BodyPlayer'&&spawn.registered===1);
  const keepText=(await command('gamerule keepInventory')).trim(),keepMatch=keepText.match(/\b(true|false)\b$/);assert(keepMatch,'Cannot read keepInventory');
  checkpoint={version:1,username:'ServerBot',worldId:'serverbody-validation',oldInstanceId:hello.instanceId,
    originalKeepInventory:keepMatch[1]==='true',originalSpawn:spawn,uuid:spawn.uuid,initialPosition:initial.position};
  await body.stop();
  await fixture('tp ServerBot 514.5 201 512.5');
  await delay(250);
  check('existing bounded fixture floor',(await command('execute if block 514 200 512 minecraft:stone')).trim()==='Test passed');
  await fixture('mcbot-respawn-fixture clear');
  await fixture('clear ServerBot');
  checkpoint.marker=`B4Save-${randomUUID().slice(0,8)}`;
  await fixture(`item replace entity ServerBot hotbar.0 with minecraft:iron_pickaxe[minecraft:damage=9,minecraft:custom_name='{"text":"${checkpoint.marker}"}']`);
  await fixture('item replace entity ServerBot hotbar.1 with minecraft:gold_ingot 4');
  await fixture('gamerule keepInventory true');
  checkpoint.inventory=(await body.observe()).inventory;
  checkpoint.inventorySnbt=(await command('data get entity ServerBot Inventory')).trim();
  const old={...lease};
  await fixture('kill ServerBot');
  const dead=await until('death invalidation',async()=>{const h=await rpc('hello');return !h.connected&&h.sessionId!==old.sessionId&&h;});
  check('old lease invalid immediately after death',!(await wire('observe',auth(old))).ok);
  check('dead health remains zero',/\b0(?:\.0)?f?$/.test((await command('data get entity ServerBot Health')).trim()));
  check('death save keeps full inventory fields',(await command('data get entity ServerBot Inventory')).trim()===checkpoint.inventorySnbt);
  checkpoint.deadSessionId=dead.sessionId;checkpoint.preparedAt=new Date().toISOString();
  await body.close();body=undefined;
  return {old,dead};
}

/** Records only method names and refuses claim/heartbeat/actions; no token or request body is persisted. */
async function cliRespawn() {
  await alone();const methods=[];
  const relay=http.createServer(async(request,response)=>{
    try{
      if(request.url!=='/v2'||request.method!=='POST'||request.headers.authorization!==`Bearer ${connection.token}`) {response.writeHead(403);response.end('{"ok":false,"error":{"code":"FORBIDDEN"}}');return;}
      let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw Error('oversize');}
      const payload=JSON.parse(raw);methods.push(payload.method);
      if(!['hello','respawn'].includes(payload.method)){response.writeHead(403);response.end('{"ok":false,"error":{"code":"UNEXPECTED_CLI_METHOD"}}');return;}
      const upstream=await fetch(connection.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{'content-type':'application/json',authorization:`Bearer ${connection.token}`},body:raw});
      response.writeHead(upstream.status,{'content-type':'application/json'});response.end(await upstream.text());
    }catch{response.writeHead(502);response.end('{"ok":false,"error":{"code":"RELAY_FAILED"}}');}
  });
  await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(0,'127.0.0.1',resolve);});
  const tempRoot=path.join(root,'output');await fs.mkdir(tempRoot,{recursive:true});const directory=await fs.mkdtemp(path.join(tempRoot,'b4-respawn-cli-'));
  try{
    const selected=path.join(directory,'connection.json');
    await fs.writeFile(selected,JSON.stringify({...connection,endpoint:`http://127.0.0.1:${relay.address().port}/v2`}),{mode:0o600});
    const child=spawn(process.execPath,[path.join(root,'client-runtime/dist/main.js'),'--body','server','--respawn-only','--connection-file',selected,'--username','ServerBot','--world-id','serverbody-validation','--runtime-dir',directory],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Explicit respawn CLI timed out'));},15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    check('actual respawn-only CLI exits successfully',result.code===0,{...result,stderrBytes:Buffer.byteLength(stderr)});
    const value=JSON.parse(stdout.trim());
    check('CLI only calls hello then respawn',isDeepStrictEqual(methods,['hello','respawn']),{methods});
    check('CLI response grants no lease or stop capability',value.respawned&&value.connected&&!('leaseId'in value)&&!('stopToken'in value));
    const files=await fs.readdir(directory);
    check('CLI writes no MCP/control/lock files',isDeepStrictEqual(files,['connection.json']),{files});
    check('CLI does not expose connection credential',!stdout.includes(connection.token)&&!stderr.includes(connection.token));
    evidence.cli={methods,result:value,exitCode:result.code};return value;
  }finally{
    relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve));
    assert(path.dirname(path.resolve(directory))===path.resolve(tempRoot)&&path.basename(directory).startsWith('b4-respawn-cli-'));
    await fs.rm(directory,{recursive:true,force:true});
  }
}
async function verifyReborn(before) {
  const result=await cliRespawn();
  check('explicit CLI advances death epoch',result.sessionId!==before.sessionId);
  await connect();const state=await body.observe(),native=await fixtureState();
  check('new explicit claim has unique same-UUID BodyPlayer',native.uuid===checkpoint.uuid&&native.bodyClass==='BodyPlayer'&&native.registered===1&&(await alone()).filter(name=>name==='ServerBot').length===1);
  check('native respawn is alive with normal health',state.connected&&state.health===20,{health:state.health});
  check('persisted slot/count/components preserved',isDeepStrictEqual(state.inventory,checkpoint.inventory));
  check('independent persisted inventory unchanged',(await command('data get entity ServerBot Inventory')).trim()===checkpoint.inventorySnbt);
  check('persistent named/damaged tool is present',JSON.stringify(state.inventory).includes(checkpoint.marker)&&state.inventory.some(stack=>stack.id==='minecraft:iron_pickaxe'&&stack.components?.['minecraft:damage']?.value===9));
  const action=await body.act('look-at',{x:state.position.x+1,y:state.position.y+1,z:state.position.z});
  check('first new explicit action works',action.status==='succeeded');
}

try{
  const props=readServerProps(serverDir);
  check('fixed isolated server ports',props['server-ip']==='127.0.0.1'&&props['server-port']==='25568'&&props['rcon.port']==='25578');
  check('stopped-world backup evidence',JSON.parse(await fs.readFile('output/serverbody-B-backup.json','utf8')).serverStopped===true);
  connection=await readServerConnection(path.join(serverDir,'config/mcbot-server-control/connection.json'));
  check('fixed role/world',connection.username==='ServerBot'&&connection.worldId==='serverbody-validation');await alone();
  if(options.phase==='prepare'){
    await prepareDeath();
    const saved=await fixture('save-all flush');check('dead player save flushed',/saved/i.test(saved));
    checkpoint.stage='prepared';await saveJson(checkpointFile,checkpoint);leaveDead=true;
    evidence.result='prepared';evidence.checkpoint=checkpointFile;
    evidence.next='Root must gracefully stop and restart this isolated server, then run --phase verify. Dead body intentionally retained; keepInventory restoration is in verify.';
  }else if(options.phase==='verify'||options.phase==='verify-direct'){
    checkpoint=JSON.parse(await fs.readFile(checkpointFile,'utf8'));
    check('matching completed preparation',checkpoint.version===1&&checkpoint.stage==='prepared'&&checkpoint.username==='ServerBot'&&checkpoint.worldId==='serverbody-validation'&&typeof checkpoint.originalKeepInventory==='boolean');
    const initial=await rpc('hello');
    check('new service starts with no automatic role',initial.instanceId!==checkpoint.oldInstanceId&&initial.connected===false&&initial.sessionId===null);
    check('no role registered before explicit load',(await alone()).length===0);
    mutated=true;
    let loaded=initial;
    if(options.phase==='verify'){
    const claim=await wire('claim',{instanceId:initial.instanceId,worldId:connection.worldId,username:connection.username,controllerId:randomUUID()});
    if(claim.ok) await rpc('release',auth(claim.result));
    check('loading dead save rejects ordinary claim',!claim.ok&&claim.error?.code==='DEAD_BODY',{code:claim.error?.code});
    loaded=await rpc('hello');
    check('dead save remains dead after rejected claim',loaded.connected===false&&typeof loaded.sessionId==='string'&&/\b0(?:\.0)?f?$/.test((await command('data get entity ServerBot Health')).trim()));
    check('load did not change inventory fields',(await command('data get entity ServerBot Inventory')).trim()===checkpoint.inventorySnbt);
    }else check('direct respawn begins at null session without first claiming',loaded.sessionId===null);
    const old=await wire('heartbeat',{instanceId:checkpoint.oldInstanceId,sessionId:checkpoint.deadSessionId,leaseId:randomUUID()});
    check('previous service scope is rejected',!old.ok&&old.error?.code==='WRONG_INSTANCE',{code:old.error?.code});
    await verifyReborn(loaded);evidence.result='passed';
  }else{
    const killed=await prepareDeath();
    await fixture('kick ServerBot B4 death-disconnect validation');
    await until('kicked body unregistered',async()=>!(await alone()).includes('ServerBot'));
    check('dead kick unregisters body',(await alone()).length===0);
    check('old controller stays invalid after kick',!(await wire('observe',auth(killed.old))).ok);
    const current=await rpc('hello');check('kicked role is not controllable',!current.connected);
    await verifyReborn(current);evidence.result='passed';
  }
}catch(error){evidence.result='failed';evidence.error={message:error.message,code:error.code};process.exitCode=1;console.error(error.message);}
finally{
  if(!leaveDead&&mutated&&checkpoint&&connection){
    try{
      await alone();const h=await rpc('hello');
      if(!h.connected){await ServerBody.respawn({connection,worldId:connection.worldId,username:connection.username,expectedSessionId:h.sessionId});evidence.cleanup.push({action:'explicit native recovery'});}
      const original=checkpoint.originalSpawn,p=original?.position;
      if(p){assert(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(original.dimension)&&['x','y','z'].every(key=>Number.isSafeInteger(p[key]))&&Number.isFinite(original.angle)&&typeof original.forced==='boolean');
        await fixture(`execute in ${original.dimension} run mcbot-respawn-fixture set ${p.x} ${p.y} ${p.z} ${original.forced} ${original.angle}`);
      }else await fixture('mcbot-respawn-fixture clear');
      assert(typeof checkpoint.originalKeepInventory==='boolean');await fixture(`gamerule keepInventory ${checkpoint.originalKeepInventory}`);
      evidence.cleanup.push({action:'restore original keepInventory and respawn point'});
      check('cleanup leaves unique live body',(await rpc('hello')).connected&&(await fixtureState()).registered===1);
      if(['verify','verify-direct'].includes(options.phase)&&evidence.result==='passed'){checkpoint.stage='verified';checkpoint.verifiedAt=new Date().toISOString();await saveJson(checkpointFile,checkpoint);}
    }catch(error){evidence.cleanup.push({error:error.message});evidence.result='failed';process.exitCode=1;}
  }
  if(body){await body.close();evidence.cleanup.push({action:'release current control'});}
  evidence.finished=new Date().toISOString();await saveJson(output,evidence);console.log(`Evidence ${output}`);
}
