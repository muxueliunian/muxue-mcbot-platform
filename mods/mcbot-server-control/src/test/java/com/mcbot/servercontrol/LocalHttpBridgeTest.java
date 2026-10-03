package com.mcbot.servercontrol;

import com.google.gson.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static com.mcbot.servercontrol.Protocol.*;

final class LocalHttpBridgeTest {
    private static int checks;
    private static void check(boolean condition,String message) {checks++;if(!condition)throw new AssertionError(message);}
    static int run() throws Exception {
        Path directory=Files.createTempDirectory("mcbot-server-http-test-");
        int port;
        try(java.net.ServerSocket free=new java.net.ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))) {port=free.getLocalPort();}
        var config=new ServerConfig("world","ServerBot",UUID.randomUUID(),port,null,null,null);
        var backlog=new LinkedBlockingQueue<Runnable>();
        AtomicInteger calls=new AtomicInteger();
        try(var bridge=new LocalHttpBridge(directory,config,backlog::add,(method,params)->{calls.incrementAndGet();if(method.equals("bad"))throw error("INVALID_ARGUMENT","Rejected");if(method.equals("crash"))throw new IllegalStateException();return obj("accepted",true);})) {
            JsonObject connection=JsonParser.parseString(Files.readString(directory.resolve("connection.json"))).getAsJsonObject();
            check(connection.get("backend").getAsString().equals("server")&&connection.get("protocol").getAsInt()==2,"v2 connection metadata");
            String token=connection.get("token").getAsString();URI endpoint=URI.create(connection.get("endpoint").getAsString());
            try(HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()) {
                var body=HttpRequest.BodyPublishers.ofString(JSON.toJson(obj("method","hello","params",obj())));
                HttpResponse<String> unauth=client.send(HttpRequest.newBuilder(endpoint).header("Content-Type","application/json").POST(body).build(),HttpResponse.BodyHandlers.ofString());
                check(unauth.statusCode()==403&&calls.get()==0,"missing authentication rejected");
                HttpResponse<String> origin=client.send(HttpRequest.newBuilder(endpoint).header("Authorization","Bearer "+token).header("Origin","http://127.0.0.1").header("Content-Type","application/json").POST(body).build(),HttpResponse.BodyHandlers.ofString());
                check(origin.statusCode()==403&&calls.get()==0,"browser origin rejected");
                HttpResponse<String> large=client.send(HttpRequest.newBuilder(endpoint).header("Authorization","Bearer "+token).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString("x".repeat(65_537))).build(),HttpResponse.BodyHandlers.ofString());
                check(large.statusCode()==413&&calls.get()==0,"over-limit request rejected");
                HttpResponse<String> invalid=client.send(HttpRequest.newBuilder(endpoint).header("Authorization","Bearer "+token).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString("[]")).build(),HttpResponse.BodyHandlers.ofString());
                check(invalid.statusCode()==400,"non-object JSON rejected");
                for(String method:new String[]{"hello","bad","crash"}) {
                    var request=HttpRequest.newBuilder(endpoint).header("Authorization","Bearer "+token).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.toJson(obj("method",method,"params",obj())))).build();
                    var answer=client.sendAsync(request,HttpResponse.BodyHandlers.ofString());
                    Runnable pending=backlog.poll(2,TimeUnit.SECONDS);check(pending!=null,"request queued to main thread");pending.run();
                    JsonObject response=JsonParser.parseString(answer.get(2,TimeUnit.SECONDS).body()).getAsJsonObject();
                    if(method.equals("hello")) check(response.get("ok").getAsBoolean(),"normal dispatch succeeds");
                    else check(response.getAsJsonObject("error").get("code").getAsString().equals(method.equals("bad")?"INVALID_ARGUMENT":"INTERNAL"),"handler failure is contained");
                }
                var request=HttpRequest.newBuilder(endpoint).header("Authorization","Bearer "+token).header("Content-Type","application/json").POST(body).build();
                var answer=client.sendAsync(request,HttpResponse.BodyHandlers.ofString());
                Runnable delayed=backlog.poll(2,TimeUnit.SECONDS);check(delayed!=null,"stalled request queued");
                HttpResponse<String> timeout=answer.get(6,TimeUnit.SECONDS);
                check(timeout.statusCode()==503&&JsonParser.parseString(timeout.body()).getAsJsonObject().getAsJsonObject("error").get("code").getAsString().equals("TIMEOUT"),"stalled main thread times out");
                int before=calls.get();delayed.run();check(calls.get()==before,"timed-out queued mutation never executes later");
            }
        } finally {
            Files.deleteIfExists(directory.resolve("connection.json.tmp"));Files.deleteIfExists(directory.resolve("connection.json"));Files.delete(directory);
        }
        System.out.println("LocalHttpBridgeTest: "+checks+" checks passed");return checks;
    }
}
