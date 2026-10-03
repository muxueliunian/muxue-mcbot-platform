package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** Deterministic continuous-mode scenarios, with the real session guard and bounded route search. */
final class FollowCompanionTest {
    private static int checks;
    private static final UUID TARGET=UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static void check(boolean ok,String message) {checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action) {
        checks++;try {action.run();throw new AssertionError("Expected "+code);}
        catch(Protocol.Error failure) {if(!failure.code.equals(code))throw failure;}
    }
    private static final class Terrain implements FollowCompanion.View {
        final AtomicLong time=new AtomicLong();
        final Object dimension=new Object();
        Object identity=new Object(),targetDimension=dimension;
        UUID uuid=TARGET;
        Vec3 feet=new Vec3(0.5,1,0.5),target=new Vec3(6.5,1,0.5),input;
        boolean online=true,walkable=true,support=true,closed,expireInPlan;
        float health=20;
        int plans,moves,stops;
        Set<FlatRoute.Cell> walls=new HashSet<>();
        ControlSession session;
        ControlSession.Operation operation;
        public boolean mayDrive() {return session==null||session.mayDrive(operation);}
        public void refresh() {if(!walkable)throw error("BLOCKED","Body cannot walk");}
        public Vec3 position() {return feet;}
        public Object dimension() {return dimension;}
        public float health() {return health;}
        public FollowCompanion.Target target(String name) {return new FollowCompanion.Target(identity,uuid,targetDimension,target,online);}
        private boolean cellSafe(Vec3 point) {return support&&Math.abs(point.x)<40&&Math.abs(point.z)<40&&!walls.contains(cell(point));}
        public boolean safe(Vec3 from,Vec3 to) {
            if(closed&&!from.equals(to))return false;
            int steps=Math.max(1,(int)Math.ceil(from.distanceTo(to)*10));
            for(int i=0;i<=steps;i++)if(!cellSafe(from.lerp(to,(double)i/steps)))return false;
            return true;
        }
        public boolean reached(Vec3 point,Vec3 destination,double distance) {return point.distanceTo(destination)<=distance&&safe(point,destination);}
        public List<Vec3> plan(Vec3 destination,double distance) {
            plans++;
            if(expireInPlan)time.set(ControlSession.TTL_MS);
            Vec3 center=point(cell(feet));
            if(!safe(feet,center))throw error("BLOCKED","Cannot enter grid");
            return FlatRoute.plan(cell(feet),new FlatRoute.View() {
                public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to) {return safe(point(from),point(to));}
                public boolean goal(FlatRoute.Cell at) {return reached(point(at),destination,distance);}
            }).stream().map(Terrain::point).toList();
        }
        public void move(Vec3 delta) {moves++;input=delta;}
        public void stop() {stops++;input=null;}
        void physics() {if(input!=null)feet=feet.add(new Vec3(input.x,0,input.z).normalize().scale(Math.min(0.22,input.horizontalDistance())));}
        static FlatRoute.Cell cell(Vec3 point) {return new FlatRoute.Cell((int)Math.floor(point.x),(int)Math.floor(point.z));}
        static Vec3 point(FlatRoute.Cell cell) {return new Vec3(cell.x()+0.5,1,cell.z()+0.5);}
    }
    private static final class Fixture implements ControlSession.Game {
        final Terrain terrain=new Terrain();
        final ControlSession session=new ControlSession(this,terrain.time::get,"world","Bot");
        final JsonObject claim,auth;
        FollowCompanion follower;
        ControlSession.Operation operation;
        Fixture() {
            terrain.session=session;
            claim=session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","Bot","controllerId","controller"));
            auth=obj("instanceId",session.instanceId,"sessionId",claim.get("sessionId"),"leaseId",claim.get("leaseId"));
        }
        public boolean connected() {return true;}
        public void ensureBody() {}
        public JsonObject hello() {return obj("capabilities",ServerController.CAPABILITIES);}
        public JsonObject observe(JsonObject p) {return obj();}
        public JsonObject watch() {return obj();}
        public long chatCursor() {return 0;}
        public void begin(ControlSession.Operation op) {
            if(op.name.equals("send-chat")) {op.finish("succeeded","Chat delivered",null);return;}
            operation=op;terrain.operation=op;
            follower=new FollowCompanion(op,terrain,terrain.time::get);follower.tick();
        }
        public void abort(ControlSession.Operation op) {if(operation==op)stop();}
        public void stop() {if(follower!=null)follower.stop();terrain.stop();}
        JsonObject action(String name,JsonObject args) {
            JsonObject act=auth.deepCopy();act.addProperty("operationId",UUID.randomUUID().toString());
            act.addProperty("controlGeneration",session.generation());act.addProperty("name",name);act.add("args",args);return act;
        }
        JsonObject start() {return session.call("act",action("follow-companion",obj("player","muxue","expectedEntityId",TARGET.toString())));}
        void tick(long elapsed) {
            terrain.time.addAndGet(elapsed);session.call("heartbeat",auth);follower.tick();terrain.physics();
        }
        String state() {return operation.result.getAsJsonObject().get("state").getAsString();}
        void failed(String code) {
            check(operation.status.equals("failed")&&operation.result.getAsJsonObject().get("code").getAsString().equals(code),"failed with "+code);
            check(terrain.input==null,"failure clears physical input immediately");
            int moves=terrain.moves;follower.tick();check(terrain.moves==moves,"failed operation never retries or resumes itself");
        }
    }
    static void run() {
        check(ServerController.CAPABILITIES.contains("follow-companion")&&ServerController.CAPABILITIES.contains("follow-player"),"continuous capability is additive to finite follow");
        Fixture steady=new Fixture();JsonObject started=steady.start();
        check(started.get("status").getAsString().equals("running")&&steady.state().equals("following"),"continuous follow starts running with following result");
        JsonObject result=started.getAsJsonObject("result");
        check(result.get("player").getAsString().equals("muxue")&&result.get("expectedEntityId").getAsString().equals(TARGET.toString())&&result.get("distance").getAsDouble()==2.5&&result.has("position"),"running result carries player UUID distance and actual position");
        for(int i=0;i<80&&!steady.state().equals("waiting");i++)steady.tick(50);
        check(steady.state().equals("waiting")&&steady.terrain.input==null&&steady.operation.status.equals("running"),"arrival becomes waiting and retains continuous operation");
        int plans=steady.terrain.plans,moves=steady.terrain.moves;String summary=steady.operation.summary;
        for(int i=0;i<130;i++)steady.tick(1000);
        check(steady.operation.status.equals("running")&&steady.terrain.plans==plans&&steady.terrain.moves==moves,"waiting beyond 120 seconds has no natural completion or repeated search");
        check(steady.operation.summary.equals(summary),"stable waiting retains one state summary");
        steady.terrain.target=steady.terrain.target.add(4,0,0);steady.tick(50);
        check(steady.state().equals("following")&&steady.terrain.plans==plans+1&&steady.terrain.input!=null,"player walks away and waiting automatically follows same instance");
        JsonObject chat=steady.session.call("act",steady.action("send-chat",obj("message","hello")));
        check(chat.get("status").getAsString().equals("succeeded")&&steady.operation.status.equals("running"),"ordinary chat does not cancel continuous follow");
        errorCode("BUSY",()->steady.session.call("act",steady.action("look-at",obj("x",1,"y",1,"z",1))));
        errorCode("BUSY",()->steady.session.call("act",steady.action("follow-companion",obj("player","muxue","expectedEntityId",TARGET.toString()))));
        JsonObject old=steady.action("follow-companion",obj("player","muxue","expectedEntityId",TARGET.toString()));
        FollowCompanion retired=steady.follower;steady.session.call("stop",steady.auth);int before=steady.terrain.moves;retired.tick();
        check(steady.operation.status.equals("cancelled")&&steady.terrain.input==null&&steady.terrain.moves==before,"stop clears input and retires old follower");
        errorCode("STALE_CONTROL",()->steady.session.call("act",old));
        check(steady.start().get("status").getAsString().equals("running"),"explicit new operation works after stop with current generation");

        Fixture wall=new Fixture();wall.terrain.walls.addAll(Set.of(new FlatRoute.Cell(2,-1),new FlatRoute.Cell(2,0),new FlatRoute.Cell(2,1)));wall.start();
        for(int i=0;i<120&&!wall.state().equals("waiting");i++)wall.tick(50);
        check(wall.state().equals("waiting")&&wall.terrain.feet.distanceTo(wall.terrain.target)<=2.5,"continuous route walks around loaded flat wall and waits");
        check(wall.terrain.plans==1,"stationary target does not force per-tick replanning");

        Fixture moved=new Fixture();moved.start();moved.tick(100);
        moved.terrain.target=moved.terrain.target.add(0,0,4);moved.tick(100);
        check(moved.terrain.plans==1,"dynamic target search is throttled below 500ms");
        moved.tick(350);check(moved.terrain.plans==2&&moved.operation.status.equals("running"),"moved target replans once cooldown passes");
        moved.tick(50);check(moved.terrain.plans==2,"stable moved target keeps existing route");

        Fixture changed=new Fixture();changed.start();changed.tick(600);changed.terrain.walls.add(new FlatRoute.Cell(2,0));changed.tick(50);
        check(changed.operation.status.equals("running")&&changed.terrain.plans==2,"changed safe route gets one bounded obstacle replan");
        changed.terrain.closed=true;changed.tick(50);changed.failed("BLOCKED");
        Fixture noPath=new Fixture();noPath.terrain.closed=true;noPath.start();noPath.failed("NO_PATH");
        Fixture frozen=new Fixture();frozen.start();frozen.terrain.time.set(FollowCompanion.NO_PROGRESS_MS+1);frozen.follower.tick();frozen.failed("BLOCKED");
        Fixture hurt=new Fixture();hurt.start();hurt.terrain.health=19;hurt.follower.tick();hurt.failed("BLOCKED");
        Fixture unsafe=new Fixture();unsafe.terrain.target=new Vec3(1.5,1,0.5);unsafe.start();unsafe.terrain.support=false;unsafe.follower.tick();unsafe.failed("BLOCKED");
        Fixture unwalkable=new Fixture();unwalkable.start();unwalkable.terrain.walkable=false;unwalkable.follower.tick();unwalkable.failed("BLOCKED");
        Fixture replaced=new Fixture();replaced.start();replaced.terrain.identity=new Object();replaced.follower.tick();replaced.failed("STALE_TARGET");
        Fixture uuidChanged=new Fixture();uuidChanged.start();uuidChanged.terrain.uuid=UUID.fromString("00000000-0000-4000-8000-000000000002");uuidChanged.follower.tick();uuidChanged.failed("STALE_TARGET");
        Fixture offline=new Fixture();offline.start();offline.terrain.online=false;offline.follower.tick();offline.failed("STALE_TARGET");
        Fixture dimension=new Fixture();dimension.start();dimension.terrain.targetDimension=new Object();dimension.follower.tick();dimension.failed("STALE_TARGET");
        Fixture far=new Fixture();far.start();far.terrain.target=new Vec3(33,1,0.5);far.follower.tick();far.failed("STALE_TARGET");
        check(far.operation.result.getAsJsonObject().get("expectedEntityId").getAsString().equals(TARGET.toString()),"failed result preserves bound identity for blocked projection");
        Fixture initiallyOffline=new Fixture();initiallyOffline.terrain.online=false;JsonObject absent=initiallyOffline.start();
        check(absent.get("status").getAsString().equals("failed")&&absent.getAsJsonObject("result").get("expectedEntityId").getAsString().equals(TARGET.toString()),"initially offline valid target retains requested identity in failed result");
        Fixture initiallyUnsafe=new Fixture();initiallyUnsafe.terrain.walkable=false;JsonObject unsafeStart=initiallyUnsafe.start();
        check(unsafeStart.get("status").getAsString().equals("failed")&&unsafeStart.getAsJsonObject("result").get("code").getAsString().equals("BLOCKED")&&unsafeStart.getAsJsonObject("result").has("position"),"initial walking rejection includes blocked result and position");
        Fixture expiry=new Fixture();expiry.start();expiry.terrain.time.set(ControlSession.TTL_MS);expiry.follower.tick();
        check(expiry.operation.status.equals("cancelled")&&expiry.terrain.input==null,"lease expiry before tick cancels continuous input");
        Fixture planExpiry=new Fixture();planExpiry.terrain.expireInPlan=true;planExpiry.start();
        check(planExpiry.operation.status.equals("cancelled")&&planExpiry.terrain.moves==0&&planExpiry.terrain.input==null,"lease expiry during search cannot issue a late movement");
        Fixture waitingLease=new Fixture();waitingLease.terrain.target=new Vec3(1.5,1,0.5);waitingLease.start();waitingLease.session.bodyChanged();waitingLease.follower.tick();
        check(waitingLease.operation.status.equals("cancelled")&&waitingLease.terrain.input==null,"body epoch change invalidates even a waiting follower");
        for(JsonObject invalid:List.of(obj("player","muxue"),obj("player","muxue","expectedEntityId","1-1-1-1-1"),
            obj("player","muxue","expectedEntityId",TARGET.toString(),"distance",1.49),obj("player","muxue","expectedEntityId",TARGET.toString(),"distance",6.01))) {
            Fixture f=new Fixture();JsonObject response=f.session.call("act",f.action("follow-companion",invalid));
            check(response.get("status").getAsString().equals("failed")&&response.getAsJsonObject("result").get("code").getAsString().equals("INVALID_ARGUMENT")&&f.terrain.moves==0,"invalid identity/distance rejected before movement");
        }
        for(double distance:List.of(1.5,6.0)) {
            Fixture f=new Fixture();JsonObject response=f.session.call("act",f.action("follow-companion",obj("player","muxue","expectedEntityId",TARGET.toString(),"distance",distance)));
            check(response.get("status").getAsString().equals("running"),"distance boundary accepted "+distance);
        }
        System.out.println("FollowCompanionTest: "+checks+" checks passed");
    }
}
