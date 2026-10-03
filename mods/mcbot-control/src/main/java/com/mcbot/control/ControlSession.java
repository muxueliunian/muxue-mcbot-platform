package com.mcbot.control;

import com.google.gson.*;
import java.util.*;
import java.util.function.LongSupplier;
import static com.mcbot.control.Protocol.*;

/** Main-thread owned, Minecraft-independent lease, world epoch and operation lifecycle. */
final class ControlSession {
    static final long TTL_MS = 10_000;
    static final int HISTORY_LIMIT = 256, ID_LIMIT = 4096;
    interface Game {
        JsonObject hello();
        JsonObject observe(JsonObject params);
        void begin(Operation operation);
        void stop();
    }
    static final class Operation {
        final String id, sessionId, name;
        final JsonObject args;
        String status = "running", summary = "Started";
        JsonElement result;
        Operation(String id, String sessionId, String name, JsonObject args) {
            this.id=id; this.sessionId=sessionId; this.name=name; this.args=args.deepCopy();
        }
        void finish(String status, String summary, JsonElement result) {
            if (!this.status.equals("running")) return;
            this.status=status; this.summary=summary; this.result=result;
        }
        JsonObject json() {
            JsonObject o=obj("operationId",id,"sessionId",sessionId,"name",name,"status",status,"summary",summary);
            if (result!=null) o.add("result",result.deepCopy());
            return o;
        }
    }
    private final Game game;
    private final LongSupplier clock;
    private String sessionId, username, worldId, leaseId;
    private long expiresAt;
    private final LinkedHashMap<String,Operation> history = new LinkedHashMap<>();
    private final Set<String> seenIds = new HashSet<>();
    ControlSession(Game game, LongSupplier clock) { this.game=game; this.clock=clock; }
    String sessionId() { return sessionId; }
    String worldId() { return worldId; }
    boolean leased() { expire(); return leaseId!=null; }
    void worldChanged(String username) {
        revoke("World or player changed");
        this.username=username;
        this.sessionId=username==null ? null : UUID.randomUUID().toString();
        history.clear(); seenIds.clear();
    }
    void expire() { if (leaseId!=null && clock.getAsLong() >= expiresAt) revoke("Controller lease expired"); }
    void revoke(String reason) {
        game.stop();
        for (Operation o:history.values()) o.finish("cancelled",reason,null);
        leaseId=null; worldId=null;
    }
    private void authorize(JsonObject p) {
        expire();
        if (leaseId==null || !leaseId.equals(string(p,"leaseId"))) throw error("LEASE_LOST","No matching live lease");
    }
    JsonObject call(String method, JsonObject p) {
        expire();
        if (method.equals("hello")) {
            JsonObject hello=game.hello();
            hello.addProperty("protocol",1);
            hello.add("sessionId",JSON.toJsonTree(sessionId));
            hello.addProperty("connected",sessionId!=null);
            hello.add("username",JSON.toJsonTree(username));
            return hello;
        }
        if (method.equals("claim")) {
            string(p,"controllerId");
            String requestedName=string(p,"username"), requestedWorld=string(p,"worldId");
            if (sessionId==null) throw error("NOT_CONNECTED","Join a world while alive before claiming control");
            if (!requestedName.equals(username)) throw error("IDENTITY_MISMATCH","Client player does not match username");
            if (leaseId!=null) throw error("LEASE_BUSY","Another controller owns this client");
            leaseId=UUID.randomUUID().toString(); worldId=requestedWorld; expiresAt=clock.getAsLong()+TTL_MS;
            return obj("leaseId",leaseId,"ttlMs",TTL_MS);
        }
        authorize(p);
        switch(method) {
            case "heartbeat": expiresAt=clock.getAsLong()+TTL_MS; return obj("ttlMs",TTL_MS);
            case "release": revoke("Controller released control"); return obj("released",true);
            case "stop":
                game.stop();
                for (Operation o:history.values()) o.finish("cancelled","Stopped by controller",null);
                return obj("stopped",true);
            case "observe": return game.observe(p);
            case "operation", "act":
                if (!Objects.equals(sessionId,string(p,"sessionId"))) throw error("STALE_SESSION","World session changed");
                String id=string(p,"operationId");
                try { UUID.fromString(id); } catch(IllegalArgumentException e) { throw error("INVALID_ARGUMENT","operationId must be a UUID"); }
                Operation old=history.get(id);
                if (method.equals("operation")) {
                    if(old==null) throw error("OPERATION_UNKNOWN","Operation is absent or was evicted; do not replay it");
                    return old.json();
                }
                String name=string(p,"name"); JsonObject args=object(p,"args");
                if(old!=null) {
                    if(!old.name.equals(name)||!old.args.equals(args)) throw error("ID_CONFLICT","operationId was already used with different arguments");
                    return old.json();
                }
                if(seenIds.contains(id)) throw error("OPERATION_EXPIRED","Operation result was evicted; do not replay it");
                if(seenIds.size()>=ID_LIMIT) throw error("OPERATION_LIMIT","Session operation limit reached; rejoin before issuing more actions");
                // One active body operation. Chat can be issued during movement.
                if(!name.equals("send-chat") && history.values().stream().anyMatch(o->o.status.equals("running")&&!o.name.equals("send-chat")))
                    throw error("BUSY","Stop the active body operation first");
                Operation operation=new Operation(id,sessionId,name,args);
                history.put(id,operation); seenIds.add(id);
                while(history.size()>HISTORY_LIMIT) {
                    String removable=history.entrySet().stream().filter(e->!e.getValue().status.equals("running")).map(Map.Entry::getKey).findFirst().orElse(null);
                    if(removable==null) break;
                    history.remove(removable);
                }
                try { game.begin(operation); }
                catch(Protocol.Error e) { operation.finish("failed",e.code+": "+e.getMessage(),null); }
                catch(RuntimeException e) { operation.finish("failed","Client action failed: "+e.getClass().getSimpleName(),null); game.stop(); }
                return operation.json();
            default: throw error("UNKNOWN_METHOD","Unknown protocol method");
        }
    }
}
