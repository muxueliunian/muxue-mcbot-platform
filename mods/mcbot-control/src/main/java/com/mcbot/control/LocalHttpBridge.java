package com.mcbot.control;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.*;
import java.util.function.*;
import static com.mcbot.control.Protocol.*;

/** Bounded authenticated loopback transport. Never touches Minecraft from an HTTP thread. */
final class LocalHttpBridge implements AutoCloseable {
    private final HttpServer server;
    private final ExecutorService workers;
    private final Consumer<Runnable> mainThread;
    private final BiFunction<String,JsonObject,JsonObject> handler;
    private final String authorization;
    LocalHttpBridge(Path configDirectory, int port, Consumer<Runnable> mainThread,
                    BiFunction<String,JsonObject,JsonObject> handler) throws IOException {
        this.mainThread=mainThread; this.handler=handler;
        byte[] secret=new byte[32]; new SecureRandom().nextBytes(secret);
        String token=Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        authorization="Bearer "+token;
        server=HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),port),8);
        workers=new ThreadPoolExecutor(2,4,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(16),r->{
            Thread t=new Thread(r,"mcbot-control-http"); t.setDaemon(true); return t;
        },new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(workers);
        server.createContext("/v1",this::serve);
        try {
            Files.createDirectories(configDirectory);
            Path temp=configDirectory.resolve("connection.json.tmp");
            Files.writeString(temp,JSON.toJson(obj("protocol",1,"endpoint","http://127.0.0.1:"+server.getAddress().getPort()+"/v1","token",token)),StandardCharsets.UTF_8);
            Files.move(temp,configDirectory.resolve("connection.json"),StandardCopyOption.REPLACE_EXISTING);
            server.start();
        } catch(IOException|RuntimeException e) { server.stop(0); workers.shutdownNow(); throw e; }
    }
    private void serve(HttpExchange exchange) throws IOException {
        try(exchange) {
            if(!exchange.getRemoteAddress().getAddress().isLoopbackAddress()
                    || exchange.getRequestHeaders().containsKey("Origin")
                    || !authorization.equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                reply(exchange,403,failure("FORBIDDEN","Local authentication required; browser requests are not accepted")); return;
            }
            if(!exchange.getRequestMethod().equals("POST") || !exchange.getRequestURI().toString().equals("/v1")) {
                reply(exchange,405,failure("BAD_REQUEST","Use POST /v1")); return;
            }
            String contentType=exchange.getRequestHeaders().getFirst("Content-Type");
            if(contentType==null||!contentType.split(";",2)[0].trim().equalsIgnoreCase("application/json")) {
                reply(exchange,415,failure("BAD_REQUEST","Expected application/json")); return;
            }
            byte[] bytes=exchange.getRequestBody().readNBytes(65_537);
            if(bytes.length>65_536) { reply(exchange,413,failure("TOO_LARGE","Request exceeds 64 KiB")); return; }
            JsonObject request;
            try {
                JsonElement parsed=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8));
                if(!parsed.isJsonObject()) throw new IllegalArgumentException();
                request=parsed.getAsJsonObject();
            } catch(RuntimeException e) { reply(exchange,400,failure("BAD_REQUEST","Invalid JSON object")); return; }
            CompletableFuture<JsonObject> answer=new CompletableFuture<>();
            try {
                String method=string(request,"method"); JsonObject params=object(request,"params");
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
                mainThread.accept(()->{
                    // A request that timed out while queued must never execute on a later tick.
                    if(answer.isDone()||System.nanoTime()>deadline) { answer.cancel(false); return; }
                    try { answer.complete(obj("ok",true,"result",handler.apply(method,params))); }
                    catch(Protocol.Error e) { answer.complete(failure(e.code,e.getMessage())); }
                    catch(RuntimeException e) { answer.complete(failure("INTERNAL","Client control failed: "+e.getClass().getSimpleName())); }
                });
                reply(exchange,200,answer.get(4,TimeUnit.SECONDS));
            } catch(Protocol.Error e) { reply(exchange,400,failure(e.code,e.getMessage())); }
            catch(TimeoutException|CancellationException e) { answer.cancel(false); reply(exchange,503,failure("TIMEOUT","Main thread unavailable; any in-flight result is unknown")); }
            catch(InterruptedException e) { Thread.currentThread().interrupt(); answer.cancel(false); reply(exchange,503,failure("CLOSED","Bridge shutting down")); }
            catch(ExecutionException|RejectedExecutionException e) { reply(exchange,503,failure("UNAVAILABLE","Client unavailable")); }
        }
    }
    private static JsonObject failure(String code,String message) { return obj("ok",false,"error",obj("code",code,"message",message)); }
    private static void reply(HttpExchange exchange,int status,JsonObject json) throws IOException {
        byte[] body=JSON.toJson(json).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control","no-store");
        exchange.sendResponseHeaders(status,body.length);
        exchange.getResponseBody().write(body);
    }
    @Override public void close() { server.stop(0); workers.shutdownNow(); }
}
