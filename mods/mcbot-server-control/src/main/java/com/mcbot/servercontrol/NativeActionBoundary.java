package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import static com.mcbot.servercontrol.Protocol.*;

/** Production exception boundary shared by immediate interactions and mining ticks. */
final class NativeActionBoundary {
    private boolean pending;
    void reset() { pending=false; }
    void sent() { pending=true; }
    void confirmed() { pending=false; }

    void begin(ControlSession.Operation operation,Runnable action,Runnable cleanup) {
        execute(operation,action,cleanup,true);
    }
    void tick(ControlSession.Operation operation,Runnable action,Runnable cleanup) {
        execute(operation,action,cleanup,false);
    }
    private void execute(ControlSession.Operation operation,Runnable action,Runnable cleanup,boolean rethrowBeforeWrite) {
        try { action.run(); }
        catch(RuntimeException failure) {
            if(!pending&&rethrowBeforeWrite&&operation.result==null) {
                cleanup(cleanup);throw failure; // ControlSession retains its ordinary precondition failures.
            }
            String code=failure instanceof Protocol.Error error?error.code:pending?"NATIVE_UNKNOWN":"INTERNAL";
            // drop's finally records only quantities already observed; never discard them on a receipt fault.
            JsonObject result=operation.result!=null&&operation.result.isJsonObject()?operation.result.getAsJsonObject().deepCopy():obj();
            result.addProperty("code",code);
            operation.finish(pending?"unknown":"failed",pending?"Native interaction has no reliable receipt; observe current state, never blindly replay":code+": "+failure.getMessage(),result);
            cleanup(cleanup);
        }
    }
    private static void cleanup(Runnable cleanup) {
        try { cleanup.run(); }
        catch(RuntimeException ignored) { /* Cleanup cannot turn an uncertain native effect into a certain failure. */ }
    }
    static void recordDropProgress(ControlSession.Operation operation,int dropped,int removed,int requested) {
        JsonObject result=operation.result!=null&&operation.result.isJsonObject()?operation.result.getAsJsonObject():obj();
        result.addProperty("droppedCount",dropped);result.addProperty("removedCount",removed);result.addProperty("requestedCount",requested);operation.result=result;
    }
}
