package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Offline fault injection through the same boundary used by SurvivalActions, no game launch. */
final class NativeActionBoundaryTest {
    private static int checks;
    private static void check(boolean ok,String message) { checks++;if(!ok)throw new AssertionError(message); }
    private static final class Game implements ControlSession.Game {
        final NativeActionBoundary boundary=new NativeActionBoundary();
        java.util.function.Consumer<ControlSession.Operation> action;
        ControlSession.Operation active;
        int starts,writes,cleanups;
        boolean cleanupThrows;
        public boolean connected(){return true;}
        public void ensureBody(){}
        public JsonObject hello(){return obj();}
        public JsonObject observe(JsonObject params){return obj();}
        public JsonObject watch(){return obj();}
        public long chatCursor(){return 0;}
        public void begin(ControlSession.Operation operation){
            starts++;active=operation;boundary.reset();
            boundary.begin(operation,()->action.accept(operation),this::cleanup);
        }
        public void abort(ControlSession.Operation operation){cleanups++;}
        public void stop(){}
        void tick(Runnable action){boundary.tick(active,action,this::cleanup);}
        void write(){boundary.sent();writes++;}
        void cleanup(){cleanups++;if(cleanupThrows)throw new IllegalStateException("Injected cleanup failure");}
    }
    private static final class Fixture {
        final Game game=new Game();
        final ControlSession session=new ControlSession(game,()->0,"world","ServerBot");
        final JsonObject claim=session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","ServerBot","controllerId","test"));
        final JsonObject request=obj("instanceId",session.instanceId,"sessionId",claim.get("sessionId"),"leaseId",claim.get("leaseId"),"controlGeneration",claim.get("controlGeneration"),"operationId",UUID.randomUUID().toString(),"name","click-slot","args",obj());
        JsonObject begin(String name,java.util.function.Consumer<ControlSession.Operation> action){request.addProperty("name",name);game.action=action;return session.call("act",request);}
        JsonObject query(){return session.call("operation",request);}
        void outcome(String status,String code){JsonObject receipt=query();check(receipt.get("status").getAsString().equals(status),request.get("name")+" expected "+status+", got "+receipt);check(receipt.getAsJsonObject("result").get("code").getAsString().equals(code),"original error code retained");}
        void duplicate(){JsonObject before=query();int writes=game.writes;check(session.call("act",request).equals(before),"duplicate act returns exact cached receipt");check(game.starts==1&&game.writes==writes,"duplicate operation never re-enters native boundary or replays writes");}
        void counts(int dropped,int removed,int requested){JsonObject result=query().getAsJsonObject("result");check(result.get("droppedCount").getAsInt()==dropped&&result.get("removedCount").getAsInt()==removed&&result.get("requestedCount").getAsInt()==requested,"receipt preserves confirmed drop count and independently observed removal only");}
    }
    static void run(){
        Fixture click=new Fixture();click.begin("click-slot",operation->{click.game.write();throw error("UNSUPPORTED","Injected transient component while encoding changed slot/carried receipt");});
        check(click.game.writes==1,"click native entry ran before receipt fault");
        click.outcome("unknown","UNSUPPORTED");click.duplicate();
        for(String name:List.of("click-slot","place-block","dig-block","swap-inventory","eat-item")) {
            for(RuntimeException fault:List.of(error("UNSUPPORTED","Injected incomplete post-write component codec"),new IllegalStateException("Injected post-write codec exception"),error("STALE_TARGET","Injected post-write target replacement"))) {
                Fixture after=new Fixture();after.begin(name,operation->{after.game.write();throw fault;});
                check(after.game.writes==1&&after.game.cleanups==1,"post-write fault cleans active work exactly once");
                after.outcome("unknown",fault instanceof Protocol.Error error?error.code:"NATIVE_UNKNOWN");after.duplicate();
            }
            Fixture before=new Fixture();before.begin(name,operation->{throw error("UNSUPPORTED","Injected pre-write unsupported component guard");});
            before.outcome("failed","UNSUPPORTED");check(before.game.writes==0,"precondition rejection never reaches native write");before.duplicate();
            Fixture refused=new Fixture();refused.begin(name,operation->{refused.game.write();refused.game.boundary.confirmed();operation.finish("failed","Native state and item receipt confirm no change",obj("code","FORBIDDEN"));});
            refused.outcome("failed","FORBIDDEN");refused.duplicate();
        }
        Fixture beforeRuntime=new Fixture();beforeRuntime.begin("place-block",operation->{throw new IllegalStateException("Injected pre-write codec exception");});
        beforeRuntime.outcome("failed","INTERNAL");check(beforeRuntime.game.writes==0,"runtime exception before native entry remains a definite failure");beforeRuntime.duplicate();
        for(RuntimeException fault:List.of(error("UNSUPPORTED","Injected mining completion inventory codec refusal"),new IllegalArgumentException("Injected mining completion inventory codec exception"))) {
            Fixture mining=new Fixture();mining.begin("dig-block",operation->{mining.game.write();mining.game.boundary.confirmed();});
            check(mining.query().get("status").getAsString().equals("running"),"accepted START with unchanged block stays running");
            mining.game.tick(()->{mining.game.write();throw fault;});
            mining.outcome("unknown",fault instanceof Protocol.Error error?error.code:"NATIVE_UNKNOWN");check(mining.game.writes==2,"mining STOP writes before completion receipt fault");mining.duplicate();
        }
        Fixture tickBefore=new Fixture();tickBefore.begin("dig-block",operation->{tickBefore.game.write();tickBefore.game.boundary.confirmed();});
        tickBefore.game.tick(()->{throw error("STALE_ITEM","Injected next-tick hand guard failure");});
        tickBefore.outcome("failed","STALE_ITEM");check(tickBefore.game.writes==1,"tick precheck never sends STOP");tickBefore.duplicate();
        Fixture tickRefused=new Fixture();tickRefused.begin("dig-block",operation->{tickRefused.game.write();tickRefused.game.boundary.confirmed();});
        tickRefused.game.tick(()->{tickRefused.game.write();tickRefused.game.boundary.confirmed();throw error("FORBIDDEN","Authoritative block remained unchanged after STOP");});
        tickRefused.outcome("failed","FORBIDDEN");tickRefused.duplicate();
        for(RuntimeException fault:List.of(error("UNSUPPORTED","Injected dropped entity component serialization failure"),new IllegalStateException("Injected dropped entity codec exception"))) {
            Fixture drop=new Fixture();drop.begin("drop-item",operation->{
                int dropped=0,removed=0;
                try {
                    drop.game.write();dropped=1;removed=1;drop.game.boundary.confirmed();
                    drop.game.write();removed=2;throw fault;
                } finally { NativeActionBoundary.recordDropProgress(operation,dropped,removed,3); }
            });
            drop.outcome("unknown",fault instanceof Protocol.Error error?error.code:"NATIVE_UNKNOWN");drop.counts(1,2,3);check(drop.game.writes==2,"only two requested drop entries ran before fault");drop.duplicate();
        }
        Fixture dropGuard=new Fixture();dropGuard.begin("drop-item",operation->{
            try {dropGuard.game.write();dropGuard.game.boundary.confirmed();throw error("STALE_TARGET","Recipient left before second native drop");}
            finally {NativeActionBoundary.recordDropProgress(operation,1,1,3);}
        });
        dropGuard.outcome("failed","STALE_TARGET");dropGuard.counts(1,1,3);check(dropGuard.game.writes==1,"known partial drop plus guard rejection never sends second drop");dropGuard.duplicate();
        Fixture zeroDrop=new Fixture();zeroDrop.begin("drop-item",operation->{
            try {zeroDrop.game.write();zeroDrop.game.boundary.confirmed();operation.finish("failed","Native drop produced no inventory or entity change",obj("code","DROP_PARTIAL"));}
            finally {NativeActionBoundary.recordDropProgress(operation,0,0,2);}
        });
        zeroDrop.outcome("failed","DROP_PARTIAL");zeroDrop.counts(0,0,2);zeroDrop.duplicate();
        Fixture interruptedNative=new Fixture();interruptedNative.begin("place-block",operation->{interruptedNative.game.boundary.sent();interruptedNative.game.writes++;throw error("UNSUPPORTED","Native callback itself throws after modifying state");});
        interruptedNative.outcome("unknown","UNSUPPORTED");interruptedNative.duplicate();
        Fixture cleanup=new Fixture();cleanup.game.cleanupThrows=true;cleanup.begin("click-slot",operation->{cleanup.game.write();throw error("UNSUPPORTED","Primary receipt failure");});
        cleanup.outcome("unknown","UNSUPPORTED");cleanup.duplicate();
        Fixture reset=new Fixture();reset.begin("click-slot",operation->{reset.game.write();throw error("UNSUPPORTED","First write uncertain");});
        reset.request.addProperty("operationId",UUID.randomUUID().toString());reset.game.action=operation->{throw error("STALE_ITEM","Second action rejected before write");};reset.session.call("act",reset.request);
        reset.outcome("failed","STALE_ITEM");check(reset.game.writes==1&&reset.game.starts==2,"fresh operation clears previous pending native receipt");
        System.out.println("NativeActionBoundaryTest: "+checks+" checks passed");
    }
}
