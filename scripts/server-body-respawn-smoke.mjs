#!/usr/bin/env node
// B4: explicit native death respawn. Never starts/stops a server or invokes a model.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ServerBody,readServerConnection} from '../client-runtime/dist/server-body.js';
import {rcon,readServerProps} from './rcon.mjs';

const argv=process.argv.slice(2),options={};
for(let i=0;i<argv.length;i++) {
  if(argv[i]==='--help') {console.log('node scripts/server-body-respawn-smoke.mjs --allow-fixture [--output evidence.json]\nOnly backed-up runtime/serverbody-validation, ports 25568/25578, mcbot.validationFixture=true, no other players. Uses real non-forced bed and native respawn; restores original keepInventory and respawn point.');process.exit(0);}
  if(argv[i]==='--allow-fixture')options.allow=true;
  else if(argv[i]==='--output'&&argv[i+1])options.output=argv[++i];
  else throw Error(`Unknown argument: ${argv[i]}`);
}
assert(options.allow,'Back up the isolated world, then pass --allow-fixture');
const serverDir=resolve('runtime/serverbody-validation');
const output=resolve(options.output||'output/serverbody-respawn-B4.json');
const evidence={started:new Date().toISOString(),scope:'B4: actual Node explicit respawn -> HTTP v2 -> vanilla PERFORM_RESPAWN/PlayerList; RCON only isolated setup and independent checks; no model',checks:[],fixtures:[],respawns:[],cleanup:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let connection,body,lease,originalKeep,originalSpawn,lastKeep,mutated=false;
const bed={x:520,y:201,z:513};
function check(name,value,detail){evidence.checks.push({name,passed:!!value,...(detail===undefined?{}:{detail})});assert(value,name);console.log(`PASS ${name}`);}
async function command(text){const[reply]=await rcon([text],{serverDir});evidence.fixtures.push({command:text,reply});return reply;}
async function alone(){const reply=(await command('list')).trim();const match=reply.match(/:\s*([^\r\n]*)$/);assert(match,'Cannot parse online player list');const names=match[1].split(',').map(s=>s.trim()).filter(Boolean);assert(names.every(n=>n==='Claude'),'Other player present; refuse fixture mutation');return names;}
async function fixture(text){await alone();mutated=true;const reply=await command(text);if(/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply))throw Error(`Fixture rejected: ${text}: ${reply.trim()}`);return reply;}
async function wire(method,params={}){const response=await fetch(connection.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),headers:{'content-type':'application/json',authorization:`Bearer ${connection.token}`},body:JSON.stringify({method,params})});return response.json();}
async function rpc(method,params={}){const result=await wire(method,params);if(!result.ok)throw Object.assign(Error(`${method}: ${result.error?.code}`),{code:result.error?.code});return result.result;}
async function until(label,fn,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100);}throw Error(`Timeout: ${label}`);}
async function connect(){body=await ServerBody.connect({connection,worldId:connection.worldId,username:connection.username,claimWaitMs:0,onLease(value){lease=value;}});}
async function fixtureState(){const reply=await command('mcbot-respawn-fixture status');const at=reply.indexOf('MCBOT_RESPAWN_FIXTURE ');assert(at>=0,'Respawn validation commands disabled or body unavailable');return JSON.parse(reply.slice(at+'MCBOT_RESPAWN_FIXTURE '.length));}
const auth=owner=>({instanceId:owner.instanceId,sessionId:owner.sessionId,leaseId:owner.leaseId});
async function keep(value){await fixture(`gamerule keepInventory ${value}`);lastKeep=value;}
async function kill(){
  const old={...lease};await body.stop();await fixture('kill Claude');
  const dead=await until('dead role invalidates scope',async()=>{const h=await rpc('hello');return !h.connected&&h.sessionId!==old.sessionId&&h;});
  check('death rejects old controller',!(await wire('observe',auth(old))).ok);
  check('death has its own scope',dead.sessionId!==old.sessionId,{oldSession:old.sessionId,deadSession:dead.sessionId});
  check('dead role does not auto-revive',/0(?:\.0)?f?\s*$/.test(await command('data get entity Claude Health')));
  const other=await wire('claim',{instanceId:dead.instanceId,worldId:connection.worldId,username:connection.username,controllerId:randomUUID()});
  check('claim alone cannot revive dead role',!other.ok&&other.error?.code==='DEAD_BODY',{code:other.error?.code});
  await body.close();body=undefined;
  return{old,dead};
}
async function respawn(label,killed){
  const before=await fixtureState();
  const result=await ServerBody.respawn({connection,worldId:connection.worldId,username:connection.username,expectedSessionId:killed.dead.sessionId});
  evidence.respawns.push({label,result});
  check(`${label}: native result and new scope`,result.respawned&&result.connected&&result.sessionId!==killed.dead.sessionId&&!('leaseId'in result));
  const replay=await wire('respawn',{instanceId:killed.dead.instanceId,worldId:connection.worldId,username:connection.username,sessionId:killed.dead.sessionId});
  check(`${label}: old respawn request cannot repeat`,!replay.ok&&replay.error?.code==='WORLD_CHANGED',{code:replay.error?.code});
  check(`${label}: old lease remains invalid`,!(await wire('heartbeat',auth(killed.old))).ok);
  await connect();
  const state=await body.observe(),native=await fixtureState();
  check(`${label}: explicit new claim retains UUID and unique BodyPlayer`,native.uuid===before.uuid&&native.bodyClass==='BodyPlayer'&&native.registered===1);
  check(`${label}: native clone and respawn events fired once`,native.deathClones===before.deathClones+1&&native.respawnEvents===before.respawnEvents+1,{before:{clone:before.deathClones,respawn:before.respawnEvents},after:{clone:native.deathClones,respawn:native.respawnEvents}});
  check(`${label}: original health reset`,state.health===20,{health:state.health});
  const first=await body.act('look-at',{x:state.position.x+1,y:state.position.y+1,z:state.position.z});
  check(`${label}: first explicit new action succeeds`,first.status==='succeeded');
  const live=await rpc('hello');
  const refused=await wire('respawn',{instanceId:live.instanceId,worldId:connection.worldId,username:connection.username,sessionId:live.sessionId});
  check(`${label}: living body refuses respawn without losing control`,!refused.ok&&refused.error?.code==='INVALID_ARGUMENT'&&(await body.observe()).connected);
  return state;
}
try{
  const props=readServerProps(serverDir);
  check('isolated server ports',props['server-ip']==='127.0.0.1'&&props['server-port']==='25568'&&props['rcon.port']==='25578');
  check('offline backup evidence exists',JSON.parse(await readFile('output/serverbody-B-backup.json','utf8')).serverStopped===true);
  connection=await readServerConnection(resolve(serverDir,'config/mcbot-server-control/connection.json'));
  check('isolated role and world',connection.username==='Claude'&&connection.worldId==='serverbody-validation');
  await alone();await connect();originalSpawn=await fixtureState();
  check('respawn fixture explicitly enabled',originalSpawn.enabled===true);
  const keepReply=await command('gamerule keepInventory');const parsed=keepReply.match(/\b(true|false)\b\s*$/);assert(parsed,'Cannot parse original keepInventory');originalKeep=parsed[1]==='true';
  const worldSpawn=JSON.parse(await readFile('output/serverbody-B-spawn.json','utf8'));
  check('expected world spawn evidence',Number.isFinite(worldSpawn.x)&&Number.isFinite(worldSpawn.y)&&Number.isFinite(worldSpawn.z));
  await fixture('tp Claude 514.5 201 512.5');await delay(250);
  await fixture('fill 519 200 511 522 200 515 stone');await fixture('fill 519 201 511 522 203 515 air');
  await fixture('setblock 520 201 514 minecraft:red_bed[part=foot,facing=north]');
  await fixture('setblock 520 201 513 minecraft:red_bed[part=head,facing=north]');
  check('actual two-part bed exists',(await command('execute if block 520 201 513 minecraft:red_bed[part=head] if block 520 201 514 minecraft:red_bed[part=foot]')).trim() === 'Test passed');
  await fixture(`mcbot-respawn-fixture set ${bed.x} ${bed.y} ${bed.z} false 0`);
  const bedSpawn=await fixtureState();check('bed spawn is explicitly non-forced',!bedSpawn.forced&&isDeepStrictEqual(bedSpawn.position,bed));
  await fixture('tp Claude 514.5 201 512.5');await fixture('clear Claude');
  const lossMarker=`B4Loss-${randomUUID().slice(0,8)}`;
  await fixture(`item replace entity Claude hotbar.0 with minecraft:diamond[minecraft:custom_name='{"text":"${lossMarker}"}'] 3`);
  await keep(false);const dropped=await kill();
  check('death removes inventory under keepInventory=false',(await command('data get entity Claude Inventory')).trim().endsWith('[]'));
  const dropReply=await command(`execute as @e[type=minecraft:item,x=514.5,y=201,z=512.5,distance=..6,nbt={Item:{id:"minecraft:diamond"}}] run data get entity @s Item`);
  check('independent dropped stack has original name and count',dropReply.includes(lossMarker)&&/count:\s*3/.test(dropReply),{reply:dropReply});
  const atBed=await respawn('existing non-forced bed',dropped);
  check('native spawn lands by actual bed',Math.hypot(atBed.position.x-bed.x,atBed.position.z-bed.z)<4&&Math.abs(atBed.position.y-bed.y)<2,{position:atBed.position,bed});
  check('death drops are not copied into new inventory',atBed.inventory.every(item=>item.count===0));

  await fixture('tp Claude 522.5 201 510.5');await fixture('clear Claude');
  const keepMarker=`B4Keep-${randomUUID().slice(0,8)}`;
  await fixture(`item replace entity Claude hotbar.0 with minecraft:iron_pickaxe[minecraft:damage=7,minecraft:custom_name='{"text":"${keepMarker}"}']`);
  await fixture('item replace entity Claude hotbar.1 with minecraft:emerald 5');
  await keep(true);const beforeKeep=await body.observe(),beforeNbt=await command('data get entity Claude Inventory');
  const retained=await kill();
  check('dead inventory retained by vanilla gamerule',(await command('data get entity Claude Inventory'))===beforeNbt);
  const afterKeep=await respawn('keepInventory=true',retained);
  check('kept slot/count/components survive native restore',isDeepStrictEqual(afterKeep.inventory,beforeKeep.inventory));
  check('independent kept inventory matches exact SNBT',(await command('data get entity Claude Inventory'))===beforeNbt);

  await fixture('setblock 520 201 513 air');await fixture('setblock 520 201 514 air');
  check('missing bed retains non-forced saved reference',!(await fixtureState()).forced);
  const missing=await kill();const fallback=await respawn('missing bed fallback',missing);
  check('missing non-forced bed uses world spawn',Math.hypot(fallback.position.x-worldSpawn.x,fallback.position.z-worldSpawn.z)<32&&Math.abs(fallback.position.y-worldSpawn.y)<5,{position:fallback.position,worldSpawn});
  check('fallback cannot remain at death or missing bed',Math.hypot(fallback.position.x-bed.x,fallback.position.z-bed.z)>100);
  check('role UUID remains unique after all replacements',(await fixtureState()).uuid===originalSpawn.uuid&&(await alone()).filter(n=>n==='Claude').length===1);
  evidence.result='passed';
}catch(error){evidence.result='failed';evidence.error={message:error.message,code:error.code};process.exitCode=1;console.error(error.message);}
finally{
  if(mutated&&connection){
    try{
      await alone();let h=await rpc('hello');
      if(!h.connected){await ServerBody.respawn({connection,worldId:connection.worldId,username:connection.username,expectedSessionId:h.sessionId});evidence.cleanup.push({action:'explicit native recovery',alive:true});}
      if(originalSpawn){
        const p=originalSpawn.position;
        if(p){assert(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(originalSpawn.dimension));await fixture(`execute in ${originalSpawn.dimension} run mcbot-respawn-fixture set ${p.x} ${p.y} ${p.z} ${originalSpawn.forced} ${originalSpawn.angle}`);}
        else await fixture('mcbot-respawn-fixture clear');
        evidence.cleanup.push({action:'restore original respawn point'});
      }
      if(typeof originalKeep==='boolean'&&typeof lastKeep==='boolean'){
        const current=await command('gamerule keepInventory');
        assert(current.trim().endsWith(String(lastKeep)),'Gamerule changed externally; do not overwrite');
        await fixture(`gamerule keepInventory ${originalKeep}`);evidence.cleanup.push({action:'restore keepInventory',value:originalKeep});
      }
      check('cleanup leaves role alive',(await rpc('hello')).connected);
    }catch(error){evidence.cleanup.push({error:error.message});process.exitCode=1;evidence.result='failed';}
  }
  if(body){await body.close();evidence.cleanup.push({action:'release current control',roleKeptOnline:true});}
  evidence.finished=new Date().toISOString();await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2)+'\n');console.log(`Evidence ${output}`);
}
