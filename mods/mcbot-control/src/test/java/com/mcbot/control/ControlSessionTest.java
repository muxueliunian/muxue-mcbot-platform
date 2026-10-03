package com.mcbot.control;

import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static com.mcbot.control.Protocol.*;

/** Runs without Minecraft or a server; verifies controller safety and transport semantics. */
public final class ControlSessionTest {
    private static int passed;
    private static final class FakeGame implements ControlSession.Game {
        int stops,begins;
        ControlSession.Operation running;
        public JsonObject hello() { return obj("capabilities",List.of("move-to-position","send-chat"),"screen",null); }
        public JsonObject observe(JsonObject p) { return obj("observed",true,"container",null); }
        public void stop() { stops++; running=null; }
        public void begin(ControlSession.Operation o) {
            begins++; running=o;
            if(o.name.equals("send-chat")) o.finish("succeeded","Sent",null);
        }
    }
    private static final class Fixture {
        long now;
        final FakeGame game=new FakeGame();
        final ControlSession session=new ControlSession(game,()->now);
        String lease;
        Fixture() { session.worldChanged("ClientBot"); claim(); }
        void claim() { lease=session.call("claim",obj("controllerId","test","username","ClientBot","worldId","explicit-world")).get("leaseId").getAsString(); }
        JsonObject credentials() { return obj("leaseId",lease); }
        JsonObject act(String id,String name,JsonObject args) {
            return obj("leaseId",lease,"sessionId",session.sessionId(),"operationId",id,"name",name,"args",args);
        }
    }
    private static void check(boolean condition,String message) { if(!condition) throw new AssertionError(message); }
    private static void errorCode(String code,Runnable action) {
        try { action.run(); throw new AssertionError("Expected "+code); }
        catch(Protocol.Error e) { check(e.code.equals(code),"Expected "+code+", got "+e.code); }
    }
    private static void test(String name,Checked action) throws Exception { action.run(); passed++; System.out.println("PASS "+name); }
    private interface Checked { void run() throws Exception; }
    public static void main(String[] args) throws Exception {
        test("requires joined identity and exclusive lease",()->{
            FakeGame game=new FakeGame(); ControlSession session=new ControlSession(game,()->0L);
            JsonObject claim=obj("controllerId","one","username","ClientBot","worldId","world");
            errorCode("NOT_CONNECTED",()->session.call("claim",claim));
            session.worldChanged("OtherBot"); errorCode("IDENTITY_MISMATCH",()->session.call("claim",claim));
            session.worldChanged("ClientBot"); session.call("claim",claim); errorCode("LEASE_BUSY",()->session.call("claim",claim));
        });
        test("only heartbeat extends ten second lease",()->{
            Fixture f=new Fixture(); int initialStops=f.game.stops;
            f.now=9000; f.session.call("observe",f.credentials());
            f.now=10000; errorCode("LEASE_LOST",()->f.session.call("observe",f.credentials()));
            check(f.game.stops>initialStops,"Expiry did not clear controls");
            f.claim(); f.now=19000; f.session.call("heartbeat",f.credentials()); f.now=28000;
            check(f.session.leased(),"Heartbeat did not extend lease");
            f.now=29000; check(!f.session.leased(),"Lease did not expire at deadline");
        });
        test("duplicate operation returns existing result without replay",()->{
            Fixture f=new Fixture(); String id=UUID.randomUUID().toString();
            JsonObject p=f.act(id,"send-chat",obj("message","hello","extra",obj("a",1,"b",2)));
            JsonObject first=f.session.call("act",p);
            p.add("args",obj("extra",obj("b",2,"a",1),"message","hello"));
            check(first.equals(f.session.call("act",p)),"Reordered JSON fields changed duplicate semantics");
            check(f.game.begins==1,"Duplicate ran twice");
            p.add("args",obj("message","changed")); errorCode("ID_CONFLICT",()->f.session.call("act",p));
        });
        test("busy body rejects competing action but permits chat",()->{
            Fixture f=new Fixture(); f.session.call("act",f.act(UUID.randomUUID().toString(),"move-to-position",obj("x",1)));
            errorCode("BUSY",()->f.session.call("act",f.act(UUID.randomUUID().toString(),"move-to-position",obj("x",2))));
            f.session.call("act",f.act(UUID.randomUUID().toString(),"send-chat",obj("message","hello")));
            check(f.game.begins==2,"Chat did not run beside body action");
        });
        test("stop cancels old action and allows a new explicit operation",()->{
            Fixture f=new Fixture(); JsonObject p=f.act(UUID.randomUUID().toString(),"move-to-position",obj());
            f.session.call("act",p); f.session.call("stop",f.credentials());
            check(f.session.call("operation",p).get("status").getAsString().equals("cancelled"),"Old operation not cancelled");
            check(f.session.leased(),"Stop should retain lease");
            f.session.call("act",f.act(UUID.randomUUID().toString(),"move-to-position",obj()));
            check(f.game.begins==2,"New command failed after stop");
        });
        test("world change invalidates lease operations and disconnect hello",()->{
            Fixture f=new Fixture(); String old=f.session.sessionId();
            JsonObject p=f.act(UUID.randomUUID().toString(),"move-to-position",obj()); f.session.call("act",p);
            f.session.worldChanged(null);
            check(f.session.call("hello",obj()).get("sessionId").isJsonNull(),"Disconnected session should be null");
            errorCode("LEASE_LOST",()->f.session.call("operation",p));
            f.session.worldChanged("ClientBot"); f.claim(); p.addProperty("leaseId",f.lease);
            errorCode("STALE_SESSION",()->f.session.call("operation",p));
            check(!old.equals(f.session.sessionId()),"World epoch reused");
        });
        test("evicted operation IDs remain non-replayable",()->{
            Fixture f=new Fixture(); JsonObject first=f.act(UUID.randomUUID().toString(),"send-chat",obj("message","one"));
            f.session.call("act",first);
            for(int i=0;i<ControlSession.HISTORY_LIMIT;i++) f.session.call("act",f.act(UUID.randomUUID().toString(),"send-chat",obj("message","next")));
            errorCode("OPERATION_EXPIRED",()->f.session.call("act",first));
        });
        test("release stops and invalidates credentials",()->{
            Fixture f=new Fixture(); f.session.call("release",f.credentials());
            errorCode("LEASE_LOST",()->f.session.call("stop",f.credentials()));
        });
        test("background world actions allow multiplayer pause screen but preserve other screens",()->{
            ControlPolicy.worldAction(false,false,false,false);
            ControlPolicy.worldAction(false,true,true,false);
            errorCode("WORLD_PAUSED",()->ControlPolicy.worldAction(true,true,true,false));
            errorCode("SCREEN_OPEN",()->ControlPolicy.worldAction(false,true,false,false));
            errorCode("SCREEN_OPEN",()->ControlPolicy.worldAction(false,false,false,true));
            errorCode("SCREEN_OPEN",()->ControlPolicy.worldAction(false,true,true,true));
        });
        test("manual takeover revokes lease and cancels a live body operation",()->{
            Fixture f=new Fixture();
            JsonObject command=f.act(UUID.randomUUID().toString(),"move-to-position",obj());
            f.session.call("act",command);
            ControlSession.Operation operation=f.game.running;
            f.session.revoke("Player took control with keyboard input");
            check(operation.status.equals("cancelled"),"Manual takeover did not cancel active action");
            check(f.game.running==null,"Manual takeover did not clear physical control");
            errorCode("LEASE_LOST",()->f.session.call("heartbeat",f.credentials()));
        });
        test("slot click requires exact observed cursor item and count",()->{
            JsonObject empty=obj("expectedCarriedItem","minecraft:air","expectedCarriedCount",0);
            expectedStack(empty,"expectedCarriedItem","expectedCarriedCount","minecraft:air",0);
            errorCode("STALE_ITEM",()->expectedStack(empty,"expectedCarriedItem","expectedCarriedCount","minecraft:diamond",1));
            JsonObject held=obj("expectedCarriedItem","minecraft:stone","expectedCarriedCount",8);
            expectedStack(held,"expectedCarriedItem","expectedCarriedCount","minecraft:stone",8);
            errorCode("STALE_ITEM",()->expectedStack(held,"expectedCarriedItem","expectedCarriedCount","minecraft:stone",7));
            errorCode("INVALID_ARGUMENT",()->expectedStack(obj(),"expectedCarriedItem","expectedCarriedCount","minecraft:air",0));
            errorCode("INVALID_ARGUMENT",()->expectedStack(obj("expectedCarriedItem","minecraft:stone","expectedCarriedCount",-1),"expectedCarriedItem","expectedCarriedCount","minecraft:stone",0));
        });
        test("dig requires a matching server target and world rather than local prediction",()->{
            BlockConfirmation evidence=new BlockConfirmation("world-one",123,"minecraft:air",true);
            check(!evidence.confirmed(),"No server update must remain unconfirmed");
            evidence.serverBlock("world-two",123,"minecraft:air",true,obj("id","minecraft:air"));
            evidence.serverBlock("world-one",124,"minecraft:air",true,obj("id","minecraft:air"));
            check(!evidence.confirmed(),"Foreign world or position confirmed the dig");
            evidence.serverBlock("world-one",123,"minecraft:stone",false,obj("id","minecraft:stone"));
            check(!evidence.confirmed(),"An unchanged server block confirmed the dig");
            evidence.serverBlock("world-one",123,"minecraft:air",true,obj("id","minecraft:air"));
            check(evidence.confirmed(),"Matching server air did not confirm the dig");
        });
        test("placement checks expected server block and retains latest correction",()->{
            BlockConfirmation evidence=new BlockConfirmation("world",123,"mod:machine",false);
            evidence.serverBlock("world",123,"minecraft:air",true,obj("id","minecraft:air"));
            check(!evidence.confirmed(),"Server denial/air must not confirm placement");
            JsonObject packet=obj("id","mod:machine","properties",obj("facing","north"));
            evidence.serverBlock("world",123,"mod:machine",false,packet);
            packet.addProperty("id","modified-later");
            check(evidence.confirmed()&&evidence.latestServerState().get("id").getAsString().equals("mod:machine"),"Server record was not copied");
            evidence.serverBlock("world",123,"minecraft:air",true,obj("id","minecraft:air"));
            check(!evidence.confirmed(),"A later server correction left stale success evidence");
            check(!new BlockConfirmation("world",123,"mod:machine",false).confirmed(),"New operation reused prior evidence");
        });
        test("HTTP wire preserves required null hello and container fields",()->{
            Path directory=Files.createTempDirectory("mcbot-control-null-");
            FakeGame game=new FakeGame();
            ControlSession session=new ControlSession(game,()->0L);
            try(LocalHttpBridge bridge=new LocalHttpBridge(directory,0,Runnable::run,session::call)) {
                JsonObject connection=JsonParser.parseString(Files.readString(directory.resolve("connection.json"))).getAsJsonObject();
                URI uri=URI.create(connection.get("endpoint").getAsString());
                String bearer="Bearer "+connection.get("token").getAsString();
                HttpClient client=HttpClient.newHttpClient();
                var helloResponse=send(client,uri,bearer,null,JSON.toJson(obj("method","hello","params",obj())));
                check(helloResponse.statusCode()==200,"Hello HTTP call failed");
                JsonObject hello=JsonParser.parseString(helloResponse.body()).getAsJsonObject().getAsJsonObject("result");
                for(String field:List.of("username","sessionId","screen"))
                    check(hello.has(field)&&hello.get(field).isJsonNull(),"HTTP serialization omitted nullable hello field "+field);
                check(!hello.get("connected").getAsBoolean(),"Disconnected hello reported connected");
                session.worldChanged("ClientBot");
                var claimResponse=send(client,uri,bearer,null,JSON.toJson(obj("method","claim","params",obj("controllerId","test","username","ClientBot","worldId","world"))));
                String lease=JsonParser.parseString(claimResponse.body()).getAsJsonObject().getAsJsonObject("result").get("leaseId").getAsString();
                var observeResponse=send(client,uri,bearer,null,JSON.toJson(obj("method","observe","params",obj("leaseId",lease))));
                JsonObject observation=JsonParser.parseString(observeResponse.body()).getAsJsonObject().getAsJsonObject("result");
                check(observation.has("container")&&observation.get("container").isJsonNull(),"HTTP serialization omitted empty container");
            } finally { Files.deleteIfExists(directory.resolve("connection.json")); Files.deleteIfExists(directory); }
        });
        test("loopback transport rejects unauthenticated origin and oversize inputs",()->{
            Path directory=Files.createTempDirectory("mcbot-control-test-");
            try(LocalHttpBridge bridge=new LocalHttpBridge(directory,0,Runnable::run,(m,p)->obj("method",m))) {
                JsonObject connection=JsonParser.parseString(Files.readString(directory.resolve("connection.json"))).getAsJsonObject();
                URI uri=URI.create(connection.get("endpoint").getAsString());
                check(uri.getHost().equals("127.0.0.1"),"Bridge did not bind loopback");
                String bearer="Bearer "+connection.get("token").getAsString();
                HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
                check(send(client,uri,null,null,"{}").statusCode()==403,"Missing auth accepted");
                check(send(client,uri,bearer,"http://localhost","{}").statusCode()==403,"Browser origin accepted");
                check(send(client,uri,bearer,null,"x".repeat(65_537)).statusCode()==413,"Oversize accepted");
                var response=send(client,uri,bearer,null,"{\"method\":\"hello\",\"params\":{}}");
                check(response.statusCode()==200&&JsonParser.parseString(response.body()).getAsJsonObject().get("ok").getAsBoolean(),"Authenticated call failed");
            } finally { Files.deleteIfExists(directory.resolve("connection.json")); Files.deleteIfExists(directory); }
        });
        test("timed out queued operation never executes later",()->{
            Path directory=Files.createTempDirectory("mcbot-control-timeout-");
            ConcurrentLinkedQueue<Runnable> queued=new ConcurrentLinkedQueue<>(); AtomicInteger executed=new AtomicInteger();
            try(LocalHttpBridge bridge=new LocalHttpBridge(directory,0,queued::add,(m,p)->{ executed.incrementAndGet(); return obj(); })) {
                JsonObject connection=JsonParser.parseString(Files.readString(directory.resolve("connection.json"))).getAsJsonObject();
                var response=send(HttpClient.newHttpClient(),URI.create(connection.get("endpoint").getAsString()),"Bearer "+connection.get("token").getAsString(),null,"{\"method\":\"act\",\"params\":{}}");
                check(response.statusCode()==503,"Queued request did not time out");
                queued.forEach(Runnable::run); check(executed.get()==0,"Timed out queued mutation executed later");
            } finally { Files.deleteIfExists(directory.resolve("connection.json")); Files.deleteIfExists(directory); }
        });
        System.out.println("Control tests: "+passed+" passed");
    }
    private static HttpResponse<String> send(HttpClient client,URI uri,String auth,String origin,String body) throws Exception {
        var builder=HttpRequest.newBuilder(uri).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body));
        if(auth!=null) builder.header("Authorization",auth);
        if(origin!=null) builder.header("Origin",origin);
        return client.send(builder.build(),HttpResponse.BodyHandlers.ofString());
    }
}
