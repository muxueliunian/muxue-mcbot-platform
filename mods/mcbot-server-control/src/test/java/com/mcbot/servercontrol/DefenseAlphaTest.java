package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import static com.mcbot.servercontrol.Protocol.*;

/** Tests the production finite executor and fact policy, without launching Minecraft or fabricating registries. */
final class DefenseAlphaTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String expected,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+expected);}catch(Protocol.Error failure){if(!failure.code.equals(expected))throw failure;}}
    /** Executes the real protocol act/stop and production native-entry policy in one synchronous call stack. */
    private static final class ReentrantGame implements ControlSession.Game,NativeDefenseUse.View {
        final AtomicLong clock=new AtomicLong();final ControlSession session=new ControlSession(this,clock::get,"world","ServerBot");
        final String entityId=UUID.randomUUID().toString();JsonObject lease;NativeDefenseUse use;ControlSession.Operation current;
        boolean revoke,interrupt=true,cleanupSawCancelled,stopInsidePost;int appliedDamage,starts;
        ReentrantGame(boolean revoke){this.revoke=revoke;lease=claim();}
        JsonObject claim(){return session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","ServerBot","controllerId","test"));}
        JsonObject auth(){return obj("instanceId",session.instanceId,"sessionId",lease.get("sessionId"),"leaseId",lease.get("leaseId"));}
        JsonObject host(){JsonObject p=auth();p.add("stopToken",lease.get("stopToken"));return p;}
        JsonObject act(){JsonObject p=auth();p.addProperty("operationId",UUID.randomUUID().toString());p.addProperty("name","defend-entity");p.addProperty("controlGeneration",session.generation());p.add("args",obj("entityId",entityId));return p;}
        public boolean connected(){return true;}
        public void ensureBody(){}
        public JsonObject hello(){return obj("capabilities",java.util.List.of("defend-entity"));}
        public JsonObject observe(JsonObject params){return obj();}
        public JsonObject watch(){return obj();}
        public long chatCursor(){return 0;}
        public void begin(ControlSession.Operation operation){current=operation;starts++;NativeActionBoundary boundary=new NativeActionBoundary();use=new NativeDefenseUse(operation,this,boundary,clock::get,1000,1,entityId);use.tick();}
        public void abort(ControlSession.Operation operation){if(current==operation)stop();}
        public void stop(){if(current!=null){cleanupSawCancelled=current.status.equals("cancelled")&&session.generation()>current.generation;if(use!=null)use.stop();}}
        public boolean nativeWriteInProgress(){return use!=null&&use.nativeWriteInProgress();}
        public void guard(){if(!session.mayDrive(current))throw error("LEASE_LOST","Native damage authority was withdrawn");}
        public String termination(){return null;}
        public boolean cooledDown(){return true;}
        public boolean targetAlive(){return true;}
        public void attack(){
            if(stopInsidePost){
                check(use.allowNativeTarget(entityId),"original damage is authorized before a Post listener stops control");
                appliedDamage+=2;
                errorCode("STOP_UNCONFIRMED",()->session.call("stop",auth()));
                use.receipt(entityId,2); // immutable native Post evidence may reach our listener after the stopping listener
                check(!use.allowNativeTarget(entityId),"read-only Post receipt cannot authorize another native write");
                return;
            }
            if(interrupt){
                if(revoke){
                    errorCode("STOP_UNCONFIRMED",()->session.call("revoke",host()));
                    errorCode("STOP_UNCONFIRMED",()->session.call("revoke",host()));
                    errorCode("STOP_UNCONFIRMED",this::claim);
                } else {
                    errorCode("STOP_UNCONFIRMED",()->session.call("stop",auth()));
                    errorCode("BUSY",()->session.call("act",act()));
                }
                check(nativeWriteInProgress(),"cleared defense intent must not clear the synchronous native scope");
            }
            // This is the production policy called by AttackEntity/IncomingDamage adapters; no View exception fakes refusal.
            if(use.allowNativeTarget(entityId)){appliedDamage+=2;use.receipt(entityId,2);}
        }
    }
    private static final class Fixture implements NativeDefenseUse.View {
        final String id=UUID.randomUUID().toString();final AtomicLong time=new AtomicLong();
        final NativeActionBoundary boundary=new NativeActionBoundary();
        final ControlSession.Operation operation=new ControlSession.Operation(UUID.randomUUID().toString(),"session",1,"defend-entity",obj("entityId",id));
        final NativeDefenseUse use=new NativeDefenseUse(operation,this,boundary,time::get,1000,2,id);
        boolean permission=true,cooldown=true,targetAlive=true,fault,collateral,cancelInside;String reason;float amount;int calls;
        public void guard(){if(!permission)throw error("LEASE_LOST","Lease expired");}
        public String termination(){return reason;}
        public boolean cooledDown(){return cooldown;}
        public boolean targetAlive(){return targetAlive;}
        public void attack(){calls++;if(amount>0)use.receipt(id,amount);if(collateral)use.receipt(UUID.randomUUID().toString(),1);if(cancelInside){use.stop();operation.finish("cancelled","Native callback stopped control",operation.result);throw error("LEASE_LOST","Revoked during native attack");}if(fault)throw new IllegalStateException("Native callback failed");}
    }
    static void run(){
        var unavailable=com.google.gson.JsonParser.parseString(JSON.toJson(ThreatSense.unavailable("00000000-0000-0000-0000-000000000001"))).getAsJsonObject();
        for(String key:java.util.List.of("type","distance","lineOfSight","alive","explosionPreparing","targetingSelf"))check(unavailable.has(key)&&unavailable.get(key).isJsonNull(),"unavailable native "+key+" remains explicit null in serialized threat contract");
        check(!unavailable.get("defenseEligible").getAsBoolean()&&!unavailable.get("factsAvailable").getAsBoolean()&&unavailable.get("classification").getAsString().equals("unknown"),"unavailable entity facts retain unknown classification and cannot authorize defense");
        check(!ThreatSense.classify(true,false,true,true,true,true).eligible(),"players remain excluded even if targeting or recently attacking the body");
        check(!ThreatSense.classify(false,true,true,true,true,true).eligible(),"friendships override hostile facts");
        check(!ThreatSense.classify(false,false,false,false,false,true).eligible(),"unaggravated vanilla neutral entity cannot be attacked");
        check(!ThreatSense.classify(false,false,false,false,false,false).eligible(),"unknown Mod entity is not invented as hostile");
        check(ThreatSense.classify(false,false,false,true,false,false).eligible(),"native targeting-self fact authorizes defense against an otherwise unknown entity");
        check(ThreatSense.classify(false,false,true,false,false,true).source().equals("vanilla_hostile_allowlist"),"explicit vanilla hostile fact has a stated evidence source");
        check(ThreatSense.classify(false,false,false,false,true,true).source().equals("native_recent_attacker"),"actual recent attacker source is distinct from targeting self");
        Fixture finite=new Fixture();finite.amount=3;finite.use.tick();check(finite.operation.status.equals("running")&&finite.calls==1,"one tick attempts at most one native attack");
        finite.use.tick();finite.use.tick();check(finite.operation.status.equals("succeeded")&&finite.calls==2,"finite attack budget terminates without chasing or replay");
        var result=finite.operation.result.getAsJsonObject();check(result.get("attemptedAttacks").getAsInt()==2&&result.get("confirmedHits").getAsInt()==2&&result.get("confirmedDamage").getAsFloat()==6,"only scoped post-damage receipts confirm hit and damage totals");
        Fixture late=new Fixture();late.use.receipt(late.id,9);late.use.tick();check(late.operation.result.getAsJsonObject().get("confirmedHits").getAsInt()==0,"late/unrelated post-damage event outside synchronous attack cannot invent a hit");
        Fixture blocked=new Fixture();blocked.cooldown=false;blocked.use.tick();check(blocked.calls==0&&blocked.operation.status.equals("running"),"native attack cooldown gates every strike");
        blocked.time.set(1000);blocked.use.tick();check(blocked.operation.status.equals("succeeded")&&blocked.calls==0&&blocked.operation.result.getAsJsonObject().get("terminationReason").getAsString().equals("timeout"),"bounded cooldown waiting finishes without attacks");
        Fixture left=new Fixture();left.reason="target_left";left.use.tick();check(left.calls==0&&left.operation.status.equals("succeeded"),"target leaving reach terminates rather than starting pursuit");
        Fixture lost=new Fixture();lost.amount=2;lost.use.tick();lost.permission=false;lost.use.tick();check(lost.calls==1&&lost.operation.status.equals("failed")&&lost.operation.result.getAsJsonObject().get("confirmedDamage").getAsFloat()==2,"lost lease prevents more strikes while retaining already confirmed damage");
        Fixture failed=new Fixture();failed.amount=2;failed.fault=true;failed.use.tick();check(failed.calls==1&&failed.operation.status.equals("unknown")&&failed.operation.result.getAsJsonObject().get("sideEffects").getAsString().equals("unknown")&&failed.operation.result.getAsJsonObject().get("confirmedDamage").getAsFloat()==2,"native callback fault is unknown with confirmed partial effects retained");
        failed.use.tick();check(failed.calls==1,"unknown native outcome is never automatically retried");
        Fixture collateral=new Fixture();collateral.collateral=true;collateral.use.tick();check(collateral.operation.status.equals("unknown")&&collateral.operation.result.getAsJsonObject().get("code").getAsString().equals("DEFENSE_EFFECT_UNKNOWN"),"unexpected collateral damage remains unknown and aborts finite executor");
        Fixture stopped=new Fixture();stopped.use.tick();stopped.use.stop();stopped.operation.finish("cancelled","Hard stop",stopped.operation.result);stopped.use.tick();check(stopped.calls==1&&stopped.operation.status.equals("cancelled")&&stopped.operation.result.getAsJsonObject().get("attemptedAttacks").getAsInt()==1,"stop preserves known attempt and cannot revive intent");
        Fixture reentrant=new Fixture();reentrant.amount=2;reentrant.cancelInside=true;reentrant.use.tick();reentrant.use.tick();check(reentrant.calls==1&&reentrant.operation.status.equals("cancelled")&&reentrant.operation.result.getAsJsonObject().get("confirmedDamage").getAsFloat()==2&&reentrant.operation.result.getAsJsonObject().get("sideEffects").getAsString().equals("unknown"),"reentrant hard stop during native callback preserves cancellation and uncertain partial side effects");
        ReentrantGame stopProtocol=new ReentrantGame(false);JsonObject stoppedAction=stopProtocol.session.call("act",stopProtocol.act());
        check(stopProtocol.appliedDamage==0&&stopProtocol.cleanupSawCancelled&&stoppedAction.get("status").getAsString().equals("cancelled"),"real ControlSession stop withdraws authority before cleanup and production native-entry gate prevents subsequent damage");
        check(!stopProtocol.nativeWriteInProgress()&&stoppedAction.getAsJsonObject("result").get("sideEffects").getAsString().equals("unknown"),"synchronous native scope exits in finally while cancelled action retains its uncertain outcome");
        check(stopProtocol.session.call("stop",stopProtocol.auth()).get("stopped").getAsBoolean(),"external explicit stop can confirm after the original native stack returned");
        stopProtocol.interrupt=false;check(stopProtocol.session.call("act",stopProtocol.act()).get("status").getAsString().equals("succeeded")&&stopProtocol.appliedDamage==2,"first explicit new-generation operation works after stop confirmation; old cleanup cannot remove it");
        ReentrantGame revokeProtocol=new ReentrantGame(true);JsonObject revokedAction=revokeProtocol.session.call("act",revokeProtocol.act());
        check(revokeProtocol.appliedDamage==0&&revokedAction.get("status").getAsString().equals("cancelled"),"host revoke prevents post-revocation native damage and cannot grant premature stopped receipt");
        check(revokeProtocol.session.call("revoke",revokeProtocol.host()).get("stopped").getAsBoolean(),"retired revoke token confirms only after the native write exited");
        revokeProtocol.lease=revokeProtocol.claim();revokeProtocol.interrupt=false;check(revokeProtocol.session.call("act",revokeProtocol.act()).get("status").getAsString().equals("succeeded"),"explicit reclaim after native stack exit starts a clean defense operation");
        ReentrantGame stoppedPost=new ReentrantGame(false);stoppedPost.stopInsidePost=true;JsonObject postAction=stoppedPost.session.call("act",stoppedPost.act());
        check(postAction.get("status").getAsString().equals("cancelled")&&postAction.getAsJsonObject("result").get("confirmedHits").getAsInt()==1&&postAction.getAsJsonObject("result").get("confirmedDamage").getAsDouble()==2,"same-call immutable Post evidence survives a prior stopping listener without weakening cancelled status");
        stoppedPost.use.receipt(stoppedPost.entityId,20);check(postAction.getAsJsonObject("result").get("confirmedDamage").getAsDouble()==2&&!stoppedPost.use.nativeWriteInProgress()&&stoppedPost.appliedDamage==2,"scope exit rejects every late Post and stopped intent applies no further damage");
        System.out.println("DefenseAlphaTest: "+checks+" checks passed (production finite executor and threat policy; no Minecraft launch/native attack execution)");
    }
}
