package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.function.LongSupplier;
import static com.mcbot.servercontrol.Protocol.*;

/** Main-thread owned protocol lifecycle; monotonic elapsed time, never game ticks. */
final class ControlSession {
    static final long TTL_MS=10_000;
    static final int HISTORY_LIMIT=256, ID_LIMIT=4096;
    interface Game {
        boolean connected();
        void ensureBody();
        default void respawn() { throw error("UNSUPPORTED","Explicit native respawn is not available"); }
        /** The body logs out like a player (vanilla saves it); the next claim brings it back where it left. */
        default boolean leave() { throw error("UNSUPPORTED","Body logout is not available"); }
        JsonObject hello();
        JsonObject observe(JsonObject params);
        default JsonObject nearbyBlocks(JsonObject params) {throw error("UNSUPPORTED","Nearby discovery is not available");}
        default JsonObject nearbyResources(JsonObject params) {throw error("UNSUPPORTED","Resource discovery is not available");}
        default JsonObject lookAround(JsonObject params) {throw error("UNSUPPORTED","Look-around summary is not available");}
        default JsonObject survivalState(JsonObject params) {throw error("UNSUPPORTED","Survival state is not available");}
        default JsonObject assessTool(JsonObject params) {throw error("UNSUPPORTED","Native tool assessment is not available");}
        JsonObject watch();
        long chatCursor();
        void begin(Operation operation);
        void abort(Operation operation);
        void stop();
        default boolean nativeWriteInProgress() {return false;}
    }
    static final class Operation {
        final String id, sessionId, name;
        final long generation;
        final JsonObject args;
        String status="running", summary="Started";
        JsonElement result;
        Operation(String id,String sessionId,long generation,String name,JsonObject args) {
            this.id=id; this.sessionId=sessionId; this.generation=generation; this.name=name; this.args=args.deepCopy();
        }
        void finish(String status,String summary,JsonElement result) {
            if(!this.status.equals("running")) return;
            this.status=status; this.summary=summary; this.result=result;
        }
        JsonObject json() {
            JsonObject json=obj("operationId",id,"sessionId",sessionId,"controlGeneration",generation,"name",name,"status",status,"summary",summary);
            if(result!=null) json.add("result",result.deepCopy());
            return json;
        }
    }
    private record Retired(String sessionId,String leaseId,String stopToken) {}
    private final Game game;
    private final LongSupplier clock;
    final String instanceId=UUID.randomUUID().toString(), worldId, username;
    private String sessionId, leaseId, stopToken, controllerId;
    private long expiresAt, generation;
    private final LinkedHashMap<String,Operation> history=new LinkedHashMap<>();
    private final Set<String> seenIds=new HashSet<>();
    private final ArrayDeque<Retired> retired=new ArrayDeque<>();
    ControlSession(Game game,LongSupplier clock,String worldId,String username) {
        this.game=game; this.clock=clock; this.worldId=worldId; this.username=username;
    }
    String sessionId() { return sessionId; }
    long generation() { return generation; }
    void bodyChanged() {
        revokeCurrent("Body died, changed dimension, or was removed");
        sessionId=UUID.randomUUID().toString();
    }
    void expire() {
        if(leaseId!=null&&clock.getAsLong()>=expiresAt) revokeCurrent("Controller lease expired");
    }
    boolean mayDrive(Operation operation) {
        expire();
        return leaseId!=null&&game.connected()&&operation.generation==generation&&operation.sessionId.equals(sessionId)&&operation.status.equals("running");
    }
    private void cancel(String reason) {
        // Withdraw authority before cleanup can reenter a native hook.
        generation++;
        for(Operation o:history.values()) o.finish("cancelled",reason,o.result);
        try { game.stop(); }
        catch(RuntimeException ignored) { /* Metadata and the next physical guard remain authoritative. */ }
    }
    private void requireNativeStopped() {
        if(game.nativeWriteInProgress())throw error("STOP_UNCONFIRMED","Authorization was withdrawn but the synchronous native write has not returned");
    }
    private boolean leaveBody() {
        if(!game.leave())return false;
        bodyChanged();return true;
    }
    void revokeCurrent(String reason) {
        Retired previous=leaseId==null?null:new Retired(sessionId,leaseId,stopToken);
        try { cancel(reason); }
        finally {
            if(previous!=null) {
                retired.addLast(previous);
                while(retired.size()>64) retired.removeFirst();
            }
            leaseId=stopToken=controllerId=null;
        }
    }
    private void instance(JsonObject p) {
        if(!instanceId.equals(string(p,"instanceId"))) throw error("WRONG_INSTANCE","Server instance changed");
    }
    private void authorize(JsonObject p) {
        instance(p);
        if(!Objects.equals(sessionId,string(p,"sessionId"))) throw error("WORLD_CHANGED","Body session changed");
        if(leaseId==null||!leaseId.equals(string(p,"leaseId"))) throw error("LEASE_LOST","No matching live lease");
        if(!game.connected()) { bodyChanged(); throw error("WORLD_CHANGED","Body is unavailable"); }
    }
    JsonObject call(String method,JsonObject p) {
        expire();
        if(method.equals("hello")) {
            JsonObject hello=game.hello();
            hello.addProperty("protocol",2); hello.addProperty("backend","server"); hello.addProperty("instanceId",instanceId);
            hello.addProperty("worldId",worldId); hello.addProperty("username",username);
            hello.addProperty("connected",game.connected()); hello.add("sessionId",JSON.toJsonTree(sessionId));
            return hello;
        }
        instance(p);
        if(method.equals("respawn")) {
            if(!worldId.equals(string(p,"worldId"))) throw error("WRONG_WORLD","Configured world does not match");
            if(!username.equals(string(p,"username"))) throw error("WRONG_PLAYER","Only the configured player may respawn");
            if(!p.has("sessionId")) throw error("INVALID_ARGUMENT","Explicit respawn requires the observed sessionId, including null before a saved body is loaded");
            String expected=p.get("sessionId").isJsonNull()?null:string(p,"sessionId");
            if(!Objects.equals(sessionId,expected)) throw error("WORLD_CHANGED","Body session changed before explicit respawn");
            if(game.connected()) throw error("INVALID_ARGUMENT","Live body cannot respawn");
            revokeCurrent("Explicit native respawn requested");
            requireNativeStopped();
            // Even an interrupted native replacement invalidates the old epoch, never old-task recovery.
            try { game.respawn(); }
            finally { bodyChanged(); }
            if(!game.connected()) throw error("WORLD_CHANGED","Native respawn did not produce an available body");
            return obj("respawned",true,"connected",true,"instanceId",instanceId,"sessionId",sessionId,"controlGeneration",generation);
        }
        if(method.equals("claim")) {
            if(!worldId.equals(string(p,"worldId"))) throw error("WRONG_WORLD","Configured world does not match");
            if(!username.equals(string(p,"username"))) throw error("WRONG_PLAYER","Only the configured player may be controlled");
            String requestedController=string(p,"controllerId");
            requireNativeStopped();
            if(leaseId!=null) {
                if(!requestedController.equals(controllerId)) throw error("LEASE_BUSY","Another controller owns this body");
                return claimResult(); // Retransmission never extends TTL.
            }
            game.ensureBody();
            if(!game.connected()) throw error("WORLD_CHANGED","Cannot claim an unavailable body");
            if(sessionId==null) sessionId=UUID.randomUUID().toString();
            cancel("New explicit claim"); history.clear(); seenIds.clear();
            leaseId=UUID.randomUUID().toString(); stopToken=UUID.randomUUID().toString(); controllerId=requestedController;
            expiresAt=clock.getAsLong()+TTL_MS;
            return claimResult();
        }
        if(method.equals("revoke")) {
            String requestedSession=string(p,"sessionId"), requestedLease=string(p,"leaseId"), requestedToken=string(p,"stopToken");
            // leave: the host is shutting down for good, so the body logs out instead of standing idle in the world.
            boolean leave=p.has("leave")&&p.get("leave").isJsonPrimitive()&&p.get("leave").getAsBoolean();
            if(retired.stream().anyMatch(r->r.sessionId.equals(requestedSession)&&r.leaseId.equals(requestedLease)&&r.stopToken.equals(requestedToken))) {
                requireNativeStopped();
                // An already revoked (stopped by chat, died) host may still send its body home, unless another controller took it meanwhile.
                return obj("stopped",true,"revoked",true,"left",leave&&leaseId==null&&leaveBody());
            }
            authorize(p);
            if(!stopToken.equals(requestedToken)) throw error("FORBIDDEN","Wrong host stop token");
            revokeCurrent("Host revoked control");requireNativeStopped(); return obj("stopped",true,"revoked",true,"left",leave&&leaveBody());
        }
        if(method.equals("watch")&&leaseId==null) {
            Retired last=retired.peekLast();
            if(last==null||!Objects.equals(sessionId,last.sessionId)||!last.sessionId.equals(string(p,"sessionId"))||!last.leaseId.equals(string(p,"leaseId"))||!last.stopToken.equals(string(p,"stopToken")))
                throw error("LEASE_LOST","No matching recent host watch lease");
            return game.watch();
        }
        authorize(p);
        switch(method) {
            case "heartbeat": expiresAt=clock.getAsLong()+TTL_MS; return withOperationBudget(obj("ttlMs",TTL_MS,"controlGeneration",generation));
            case "release": revokeCurrent("Controller released control");requireNativeStopped(); return obj("released",true);
            case "stop": cancel("Stopped by controller");requireNativeStopped(); return withOperationBudget(obj("stopped",true,"controlGeneration",generation));
            case "observe", "nearby-blocks", "nearby-resources", "look-around", "survival-state", "assess-tool": {
                if(!method.equals("observe")&&!game.hello().getAsJsonArray("capabilities").contains(JSON.toJsonTree(method)))
                    throw error("UNSUPPORTED","Nearby discovery capability is not available");
                JsonObject observation=switch(method) {
                    case "observe" -> game.observe(p);
                    case "nearby-resources" -> game.nearbyResources(p);
                    case "nearby-blocks" -> game.nearbyBlocks(p);
                    case "look-around" -> game.lookAround(p);
                    case "survival-state" -> game.survivalState(p);
                    default -> game.assessTool(p);
                };
                observation.addProperty("instanceId",instanceId); observation.addProperty("sessionId",sessionId);
                observation.addProperty("worldId",worldId); observation.addProperty("controlGeneration",generation);
                return withOperationBudget(observation);
            }
            case "watch":
                if(!stopToken.equals(string(p,"stopToken"))) throw error("FORBIDDEN","Wrong host stop token");
                return game.watch();
            case "operation", "act": return operation(method,p);
            default: throw error("INVALID_ARGUMENT","Unknown protocol method");
        }
    }
    private JsonObject claimResult() {
        return withOperationBudget(obj("leaseId",leaseId,"stopToken",stopToken,"ttlMs",Math.max(1,expiresAt-clock.getAsLong()),"instanceId",instanceId,"sessionId",sessionId,"controlGeneration",generation,"chatCursor",game.chatCursor()));
    }
    private JsonObject withOperationBudget(JsonObject result) {
        // This is the lifetime admission budget of the authenticated lease, not the result cache.
        int used=seenIds.size();
        result.add("operationBudget",obj("used",used,"remaining",ID_LIMIT-used,"limit",ID_LIMIT,"exhausted",used>=ID_LIMIT));
        return result;
    }
    private JsonObject operation(String method,JsonObject p) {
        String id=string(p,"operationId");
        try { UUID.fromString(id); } catch(IllegalArgumentException e) { throw error("INVALID_ARGUMENT","operationId must be a UUID"); }
        Operation old=history.get(id);
        if(method.equals("operation")) {
            if(old==null) throw error("UNKNOWN_OPERATION","Result absent or evicted; never replay");
            return withOperationBudget(old.json());
        }
        long requestedGeneration=Protocol.generation(p);
        if(requestedGeneration!=generation) throw error("STALE_CONTROL","Control generation changed");
        String name=string(p,"name"); JsonObject args=object(p,"args");
        if(old!=null) {
            if(!old.name.equals(name)||!old.args.equals(args)||old.generation!=requestedGeneration) throw error("OPERATION_CONFLICT","Operation ID already used with different content");
            return withOperationBudget(old.json());
        }
        if(seenIds.contains(id)) throw error("UNKNOWN_OPERATION","Result evicted; never replay this ID");
        if(seenIds.size()>=ID_LIMIT) throw error("OPERATION_LIMIT","All "+ID_LIMIT+" lease operation IDs are used; stop and observation remain available; release and explicitly claim again for a new budget");
        if(!name.equals("send-chat")&&game.nativeWriteInProgress())throw error("BUSY","A synchronous native write must return before another action may start");
        if(!name.equals("send-chat")&&history.values().stream().anyMatch(o->o.status.equals("running")&&!o.name.equals("send-chat"))) throw error("BUSY","Stop the current operation first");
        Operation operation=new Operation(id,sessionId,generation,name,args);
        history.put(id,operation); seenIds.add(id);
        while(history.size()>HISTORY_LIMIT) {
            String removable=history.entrySet().stream().filter(e->!e.getValue().status.equals("running")).map(Map.Entry::getKey).findFirst().orElse(null);
            if(removable==null) break;
            history.remove(removable);
        }
        try { game.begin(operation); }
        catch(Protocol.Error e) { operation.finish("failed",e.code+": "+e.getMessage(),obj("code",e.code)); }
        catch(RuntimeException e) {
            operation.finish("failed","Action failed: "+e.getClass().getSimpleName(),obj("code","INTERNAL"));
            // Chat is allowed during movement; a failing new operation must not abort its neighbour.
            game.abort(operation);
        }
        return withOperationBudget(operation.json());
    }
}
