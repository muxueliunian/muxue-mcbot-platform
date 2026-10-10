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
    private static class Terrain implements FollowCompanion.View {
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
        GuardCombat guard;int resets;boolean dutyGuards;
        public GuardCombat guard() {return guard;}
        public boolean dutyGuards() {return dutyGuards;}
        public void resetNavigation() {resets++;}
        void physics() {if(input!=null)feet=feet.add(new Vec3(input.x,0,input.z).normalize().scale(Math.min(0.22,input.horizontalDistance())));}
        static FlatRoute.Cell cell(Vec3 point) {return new FlatRoute.Cell((int)Math.floor(point.x),(int)Math.floor(point.z));}
        static Vec3 point(FlatRoute.Cell cell) {return new Vec3(cell.x()+0.5,1,cell.z()+0.5);}
    }
    /** Native-navigation body: walks straight at the player or a stroll spot, 0.22 blocks per tick. */
    private static final class NativeTerrain extends Terrain {
        int strollTicks,strollEnds;
        boolean noSpot;
        public boolean nativeNavigation(){return true;}
        public boolean navigate(Vec3 destination,double distance){
            if(feet.distanceTo(destination)<=distance){input=null;return true;}
            moves++;input=destination.subtract(feet);return false;
        }
        public Vec3 strollPoint(Vec3 centre){return noSpot?null:centre.add(0,0,3.5);}
        public boolean stroll(Vec3 point,Vec3 centre){
            strollTicks++;
            if(feet.subtract(point).horizontalDistance()<=0.6){input=null;return true;}
            input=point.subtract(feet);return false;
        }
        public void endStroll(){strollEnds++;}
    }
    private static final class Fixture implements ControlSession.Game {
        final Terrain terrain;
        final ControlSession session;
        final JsonObject claim,auth;
        FollowCompanion follower;
        ControlSession.Operation operation;
        Fixture() {this(new Terrain());}
        Fixture(Terrain terrain) {
            this.terrain=terrain;session=new ControlSession(this,terrain.time::get,"world","Bot");terrain.session=session;
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
            follower=new FollowCompanion(op,terrain,terrain.time::get,new Random(7));follower.tick();
        }
        public void abort(ControlSession.Operation op) {if(operation==op)stop();}
        public void stop() {if(follower!=null)follower.stop();terrain.stop();}
        JsonObject action(String name,JsonObject args) {
            JsonObject act=auth.deepCopy();act.addProperty("operationId",UUID.randomUUID().toString());
            act.addProperty("controlGeneration",session.generation());act.addProperty("name",name);act.add("args",args);return act;
        }
        JsonObject start() {return start(obj());}
        JsonObject start(JsonObject extra) {
            JsonObject args=obj("player","muxue","expectedEntityId",TARGET.toString());
            for(var entry:extra.entrySet())args.add(entry.getKey(),entry.getValue());
            return session.call("act",action("follow-companion",args));
        }
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
        stroll();
        guarding();
        System.out.println("FollowCompanionTest: "+checks+" checks passed");
    }
    /** Guarding follow: damage no longer ends it, the guard takes the tick while it fights, then the follow resumes from a fresh route. */
    private static void guarding() {
        NativeTerrain terrain=new NativeTerrain();
        GuardCombatTest.FakeView fake=new GuardCombatTest.FakeView();
        terrain.guard=new GuardCombat(fake,GuardCombat.Options.parse(com.google.gson.JsonParser.parseString("true")));
        Fixture guarded=new Fixture(terrain);guarded.start(obj("guard",true));
        check(guarded.state().equals("following")&&guarded.operation.result.getAsJsonObject().getAsJsonObject("guard").get("state").getAsString().equals("idle"),"guarding follow starts as an ordinary follow and reports the guard");
        fake.foes.add(GuardCombatTest.foe("zombie","minecraft:zombie",4,3));terrain.health=14;
        int moves=terrain.moves;guarded.tick(50);
        check(guarded.operation.status.equals("running")&&guarded.state().equals("guarding")&&fake.approaches==1&&terrain.moves==moves,"hit while guarding: the follow keeps running and the guard drives");
        check(guarded.operation.summary.equals("Guarding companion")&&guarded.operation.result.getAsJsonObject().getAsJsonObject("guard").get("state").getAsString().equals("approaching"),"the result says what the guard is doing");
        fake.dead.add("zombie");int resets=terrain.resets;guarded.tick(50);
        check(guarded.operation.status.equals("running")&&!guarded.state().equals("guarding")&&terrain.resets==resets+1,"fight over: the follow resumes with a fresh route");
        guarded.stop();
        // Through the protocol (act follow-companion with guard): a skeleton drawing its bow at the body makes the guard stand and shield, then go on once it has loosed.
        NativeTerrain aimed=new NativeTerrain();
        GuardCombatTest.FakeView shooter=new GuardCombatTest.FakeView();shooter.shield=true;
        aimed.guard=new GuardCombat(shooter,GuardCombat.Options.parse(com.google.gson.JsonParser.parseString("true")));
        Fixture archery=new Fixture(aimed);archery.start(obj("guard",true));
        shooter.foes.add(GuardCombatTest.archer("skeleton",12,true));
        int walked=aimed.moves;archery.tick(50);
        check(archery.operation.status.equals("running")&&archery.state().equals("guarding")&&shooter.shieldUp&&shooter.approaches==0&&aimed.moves==walked,"a bow drawn at the body: the guarding follow stands and shields");
        check("RANGED".equals(archery.operation.result.getAsJsonObject().getAsJsonObject("guard").get("blocking").getAsString()),"the result says what the shield is up against");
        shooter.foes.set(0,GuardCombatTest.archer("skeleton",12,false));
        for(int i=0;i<GuardCombat.SHIELD_DELAY&&shooter.shieldUp;i++){shooter.tick();archery.tick(50);}
        check(!shooter.shieldUp&&shooter.approaches==1&&archery.state().equals("guarding"),"loosed: the shield comes down and the guard walks to the archer");
        archery.stop();
        Fixture plain=new Fixture(new NativeTerrain());plain.start();plain.terrain.health=14;plain.tick(50);
        plain.failed("BLOCKED");
        // A standing guard duty protects the player: being hit does not end the follow; the duty takes ticks, then hands the body back.
        Fixture duty=new Fixture(new NativeTerrain());duty.terrain.dutyGuards=true;duty.start();duty.terrain.health=14;duty.tick(50);
        check(duty.operation.status.equals("running"),"hit while a guard duty protects the player: the follow keeps running");
        duty.follower.guardedElsewhere();
        check(duty.state().equals("guarding")&&duty.operation.summary.equals("Guarding companion")&&!duty.follower.ownGuard(),"the duty took the body: the follow reports guarding");
        int dutyResets=duty.terrain.resets;duty.follower.resumeAfterGuard();duty.terrain.dutyGuards=false;duty.tick(50);
        check(duty.operation.status.equals("running")&&duty.terrain.resets==dutyResets+1,"handed back: a fresh route, and earlier damage no longer counts");
        duty.stop();
    }
    /** Idle stroll while waiting on native navigation: late, short, stays put until the player moves. */
    private static void stroll() {
        Fixture f=new Fixture(new NativeTerrain());NativeTerrain t=(NativeTerrain)f.terrain;f.start();
        for(int i=0;i<80&&!f.state().equals("waiting");i++)f.tick(50);
        check(f.state().equals("waiting")&&f.follower.waiting(),"native follow arrives and waits");
        for(int i=0;i<7;i++)f.tick(1000);
        check(t.strollTicks==0&&f.follower.waiting(),"no stroll in the first 8 seconds of waiting");
        long waited=7_000;
        while(!f.follower.strolling()&&waited<25_000){f.tick(500);waited+=500;}
        check(f.follower.strolling()&&waited>=8_000&&waited<=18_500,"a stroll starts 8..18 seconds after the player stood still");
        check(!f.follower.waiting()&&f.state().equals("waiting"),"strolling is reported as waiting but turns off idle gaze");
        check(f.operation.result.getAsJsonObject().get("strolling").getAsBoolean(),"result marks the stroll");
        Vec3 spot=t.target.add(0,0,3.5);
        for(int i=0;i<60&&f.follower.strolling();i++)f.tick(50);
        check(!f.follower.strolling()&&t.feet.subtract(spot).horizontalDistance()<=0.6&&t.strollEnds==1,"walks to the stroll spot and ends the stroll");
        Vec3 rested=t.feet;int moves=t.moves;
        for(int i=0;i<7;i++)f.tick(1000);
        check(t.feet.equals(rested)&&t.moves==moves&&f.state().equals("waiting"),"stays at the stroll spot instead of walking back while the player stands still");
        for(int i=0;i<40&&!f.follower.strolling();i++)f.tick(1000);
        check(f.follower.strolling(),"strolls again later");
        f.follower.holdStroll();
        check(!f.follower.strolling()&&t.input==null&&f.follower.waiting(),"someone speaking stops the stroll where it is");
        f.tick(50);
        check(!f.follower.strolling()&&f.follower.waiting(),"after speech it rests, not strolls straight away");
        t.target=t.target.add(6,0,0);f.tick(50);
        check(f.state().equals("following")&&t.input!=null,"player moving off ends the rest and follows again");

        Fixture time=new Fixture(new NativeTerrain());NativeTerrain slow=(NativeTerrain)time.terrain;time.start();
        for(int i=0;i<80&&!time.state().equals("waiting");i++)time.tick(50);
        while(!time.follower.strolling())time.tick(1000);
        // A spot that is never reached: the stroll gives up after its time limit and the body stops.
        Vec3 start=slow.feet;
        for(int i=0;i<12;i++){time.tick(1000);slow.feet=start;}
        check(!time.follower.strolling()&&slow.strollEnds==1&&time.operation.status.equals("running"),"an unreached stroll ends within its time limit without failing the follow");

        Fixture off=new Fixture(new NativeTerrain());NativeTerrain still=(NativeTerrain)off.terrain;off.start(obj("wander",false));
        for(int i=0;i<200;i++)off.tick(1000);
        check(still.strollTicks==0&&off.follower.waiting(),"wander false never strolls");
        Fixture none=new Fixture(new NativeTerrain());NativeTerrain blocked=(NativeTerrain)none.terrain;blocked.noSpot=true;none.start();
        for(int i=0;i<120;i++)none.tick(1000);
        check(blocked.strollTicks==0&&none.follower.waiting()&&none.operation.status.equals("running"),"no standable spot nearby: keeps waiting");
        Fixture bad=new Fixture(new NativeTerrain());JsonObject rejected=bad.start(obj("wander","yes"));
        check(rejected.get("status").getAsString().equals("failed")&&rejected.getAsJsonObject("result").get("code").getAsString().equals("INVALID_ARGUMENT"),"wander must be a boolean");
    }
}
