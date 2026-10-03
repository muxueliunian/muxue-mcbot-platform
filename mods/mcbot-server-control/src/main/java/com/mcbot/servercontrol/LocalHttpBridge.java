package com.mcbot.servercontrol;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.*;
import static com.mcbot.servercontrol.Protocol.*;

final class LocalHttpBridge implements AutoCloseable {
    private final HttpServer server;
    private final ExecutorService workers;
    private final Consumer<Runnable> mainThread;
    private final BiFunction<String,JsonObject,JsonObject> handler;
    private final String authorization;
    private final Semaphore queued=new Semaphore(16);
    LocalHttpBridge(Path directory,ServerConfig config,Consumer<Runnable> mainThread,BiFunction<String,JsonObject,JsonObject> handler) throws IOException {
        this.mainThread=mainThread; this.handler=handler;
        byte[] secret=new byte[32]; new SecureRandom().nextBytes(secret);
        String token=Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        authorization="Bearer "+token;
        server=HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),config.port()),8);
        workers=new ThreadPoolExecutor(4,4,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(16),r->{Thread t=new Thread(r,"mcbot-server-http");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(workers); server.createContext("/v2",this::serve);
        try {
            Path temp=directory.resolve("connection.json.tmp");
            Files.writeString(temp,JSON.toJson(obj("protocol",2,"backend","server","endpoint","http://127.0.0.1:"+config.port()+"/v2","token",token,"worldId",config.worldId(),"username",config.username())),StandardCharsets.UTF_8);
            try { Files.move(temp,directory.resolve("connection.json"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE); }
            catch(AtomicMoveNotSupportedException e) { Files.move(temp,directory.resolve("connection.json"),StandardCopyOption.REPLACE_EXISTING); }
            server.start();
        } catch(IOException|RuntimeException e) { server.stop(0); workers.shutdownNow(); throw e; }
    }
    private void serve(HttpExchange exchange) throws IOException {
        try(exchange) {
            if(!exchange.getRemoteAddress().getAddress().isLoopbackAddress()||exchange.getRequestHeaders().containsKey("Origin")||!authorization.equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                reply(exchange,403,failure("FORBIDDEN","Local authentication required")); return;
            }
            if(!exchange.getRequestMethod().equals("POST")||!exchange.getRequestURI().toString().equals("/v2")) { reply(exchange,405,failure("INVALID_ARGUMENT","Use POST /v2"));return; }
            String contentType=exchange.getRequestHeaders().getFirst("Content-Type");
            if(contentType==null||!contentType.split(";",2)[0].trim().equalsIgnoreCase("application/json")) { reply(exchange,415,failure("INVALID_ARGUMENT","Expected application/json"));return; }
            byte[] bytes=exchange.getRequestBody().readNBytes(65_537);
            if(bytes.length>65_536) { reply(exchange,413,failure("INVALID_ARGUMENT","Request exceeds 64 KiB"));return; }
            JsonObject request;
            try { request=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8)).getAsJsonObject(); }
            catch(RuntimeException e) { reply(exchange,400,failure("INVALID_ARGUMENT","Invalid JSON object"));return; }
            CompletableFuture<JsonObject> answer=new CompletableFuture<>();
            AtomicInteger state=new AtomicInteger(); // 0 queued, 1 started, 2 abandoned
            boolean acquired=false,enqueued=false;
            try {
                String method=string(request,"method"); JsonObject params=object(request,"params");
                if(!(acquired=queued.tryAcquire())) { reply(exchange,503,failure("BUSY","Main-thread queue full")); return; }
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
                mainThread.accept(()->{
                    try {
                        if(System.nanoTime()>=deadline||!state.compareAndSet(0,1)) { state.compareAndSet(0,2);answer.cancel(false); return; }
                        try { answer.complete(obj("ok",true,"result",handler.apply(method,params))); }
                        catch(Protocol.Error e) { answer.complete(failure(e.code,e.getMessage())); }
                        catch(RuntimeException e) { answer.complete(failure("INTERNAL","Server control failed: "+e.getClass().getSimpleName())); }
                    } finally { queued.release(); }
                });
                enqueued=true;
                reply(exchange,200,answer.get(4,TimeUnit.SECONDS));
            } catch(Protocol.Error e) { reply(exchange,400,failure(e.code,e.getMessage())); }
            catch(TimeoutException|CancellationException e) { state.compareAndSet(0,2);answer.cancel(false);reply(exchange,503,failure("TIMEOUT","Main thread unavailable; started result is unknown")); }
            catch(InterruptedException e) { Thread.currentThread().interrupt();state.compareAndSet(0,2);answer.cancel(false);reply(exchange,503,failure("CLOSED","Bridge shutting down")); }
            catch(ExecutionException|RejectedExecutionException e) { state.compareAndSet(0,2);reply(exchange,503,failure("UNAVAILABLE","Server unavailable")); }
            // Abandoned runnables keep a permit until drained: a frozen server has bounded queue growth.
            finally { if(acquired&&!enqueued) queued.release(); }
        } catch(RuntimeException e) { /* Malformed transport cannot escape the worker. */ }
    }
    private static JsonObject failure(String code,String message) { return obj("ok",false,"error",obj("code",code,"message",message)); }
    private static void reply(HttpExchange exchange,int status,JsonObject json) throws IOException {
        byte[] body=JSON.toJson(json).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8"); exchange.getResponseHeaders().set("Cache-Control","no-store");
        exchange.sendResponseHeaders(status,body.length); exchange.getResponseBody().write(body);
    }
    @Override public void close() { server.stop(0); workers.shutdownNow(); }
}
