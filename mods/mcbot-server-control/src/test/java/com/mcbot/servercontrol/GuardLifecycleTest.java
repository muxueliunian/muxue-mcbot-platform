package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import static com.mcbot.servercontrol.Protocol.*;

/** Real protocol and execution-authority regressions; no Minecraft or native damage is simulated as a live-game test. */
final class GuardLifecycleTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable call){checks++;try{call.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static final class Fixture implements ControlSession.Game {
        final AtomicLong clock=new AtomicLong();
        final ControlSession session=new ControlSession(this,clock::get,"world","Bot");
        JsonObject lease;
        GuardExecution execution;
        boolean nativeWriting,connected=true;
        int stops;
        Fixture(){claim();}
        void claim(){lease=session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","Bot","controllerId","review"));}
        JsonObject auth(){return obj("instanceId",session.instanceId,"sessionId",session.sessionId(),"leaseId",lease.get("leaseId").getAsString());}
        JsonObject guard(long revision,boolean off){JsonObject p=auth();p.addProperty("guardRevision",revision);if(off)p.addProperty("off",true);return p;}
        public boolean connected(){return connected;}
        public void ensureBody(){}
        public JsonObject hello(){return obj("capabilities",List.of("guard-duty-fenced"));}
        public JsonObject observe(JsonObject p){return obj();}
        public JsonObject watch(){return obj();}
        public long chatCursor(){return 0;}
        public void begin(ControlSession.Operation op){}
        public void abort(ControlSession.Operation op){}
        public boolean nativeWriteInProgress(){return nativeWriting;}
        public void stop(){stops++;if(execution!=null)execution.interrupt();}
        public void clearDuty(){GuardExecution old=execution;execution=null;if(old!=null)old.interrupt();}
        public JsonObject guard(JsonObject p){clearDuty();if(!p.has("off"))execution=new GuardExecution(session.dutyPermission());return obj("enabled",execution!=null);}
        BooleanSupplier open(long revision){session.call("guard",guard(revision,false));return execution.capture();}
    }
    static void run(){
        ordering();nativeCallbacks();leaseBoundaries();
        System.out.println("GuardLifecycleTest: "+checks+" checks passed (protocol and execution authority, no live-game damage)");
    }
    private static void ordering(){
        Fixture f=new Fixture();f.open(1);
        JsonObject lateOn=f.guard(2,false);
        int stops=f.stops;
        f.session.call("guard",f.guard(3,true));
        errorCode("CANCELLED",()->f.session.call("guard",lateOn));
        check(f.execution==null&&f.stops==stops,"off fences late setup without stopping an unrelated task");
        errorCode("CANCELLED",()->f.session.call("guard",f.guard(3,false)));
        errorCode("INVALID_ARGUMENT",()->f.session.call("guard",f.auth()));
        JsonObject invalid=f.guard(4,false);invalid.addProperty("guardRevision",1.5);
        errorCode("INVALID_ARGUMENT",()->f.session.call("guard",invalid));
        f.open(4);JsonObject beforeStop=f.guard(5,false);
        JsonObject clear=f.auth();clear.addProperty("clearGuard",true);clear.addProperty("guardRevision",6);
        JsonObject stopped=f.session.call("stop",clear);
        check(stopped.get("stopped").getAsBoolean()&&f.execution==null,"stop clears protection before acknowledging");
        errorCode("CANCELLED",()->f.session.call("guard",beforeStop));
        BooleanSupplier fresh=f.open(7);
        check(fresh.getAsBoolean(),"a fresh explicit command after stop can protect again");
        check(stopped.getAsJsonObject("operationBudget").get("used").getAsInt()==0,"guard configuration and clearing use no operation IDs");
        // A clearing stop overtaken by a later setting still stops, and leaves that later setting in place.
        JsonObject staleClear=f.auth();staleClear.addProperty("clearGuard",true);staleClear.addProperty("guardRevision",7);
        long generation=f.session.generation();
        check(f.session.call("stop",staleClear).get("stopped").getAsBoolean()&&f.session.generation()==generation+1,"a clearing stop is never refused");
        check(f.execution!=null&&f.execution.capture().getAsBoolean(),"an overtaken clear does not undo the later setting");
        // An ordinary stop keeps the intent, so a setting issued before it but arriving after it still applies; off too.
        JsonObject lateOff=f.guard(8,true);f.session.call("stop",f.auth());
        f.session.call("guard",lateOff);
        check(f.execution==null,"off is ordered by revision alone, not by control generation");
    }
    private static void nativeCallbacks(){
        Fixture f=new Fixture();BooleanSupplier attack=f.open(1);f.nativeWriting=true;
        errorCode("STOP_UNCONFIRMED",()->f.session.call("stop",f.auth()));
        check(!attack.getAsBoolean(),"stop withdraws the old native callback's authority");
        check(f.execution!=null&&f.execution.capture().getAsBoolean(),"ordinary stop preserves the standing intent for a later execution");
        BooleanSupplier nextAttack=f.execution.capture();
        errorCode("STOP_UNCONFIRMED",()->f.session.call("guard",f.guard(2,true)));
        check(f.execution==null&&!nextAttack.getAsBoolean(),"off withdraws intent and native authority before reporting unconfirmed");
        errorCode("STOP_UNCONFIRMED",()->f.session.call("guard",f.guard(3,false)));
        check(f.execution==null,"cannot start a replacement duty inside the old native write");
        f.nativeWriting=false;
        f.session.call("guard",f.guard(4,true));
        BooleanSupplier replacement=f.open(5);
        check(!attack.getAsBoolean()&&!nextAttack.getAsBoolean()&&replacement.getAsBoolean(),"new execution never revives old callbacks");
        BooleanSupplier previous=replacement;f.open(6);
        check(!previous.getAsBoolean(),"replacing guard options also revokes the old execution");
    }
    private static void leaseBoundaries(){
        for(String boundary:List.of("release","revoke","expire","bodyChanged")){
            Fixture f=new Fixture();BooleanSupplier lease=f.session.dutyPermission(),attack=f.open(1);
            switch(boundary){
                case "release" -> f.session.call("release",f.auth());
                case "revoke" -> {JsonObject p=f.auth();p.add("stopToken",f.lease.get("stopToken"));f.session.call("revoke",p);}
                case "expire" -> {f.clock.set(ControlSession.TTL_MS);f.session.expire();}
                default -> f.session.bodyChanged();
            }
            check(f.execution==null&&!lease.getAsBoolean()&&!attack.getAsBoolean(),boundary+" clears protection and execution");
            f.claim();f.open(1);
            check(!lease.getAsBoolean()&&!attack.getAsBoolean(),boundary+": a new claim does not revive old callbacks");
        }
    }
}
