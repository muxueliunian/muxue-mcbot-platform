package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.LongSupplier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** One continuous operation, with bounded loaded-only routes and no automatic recovery after failure. */
final class FollowCompanion {
    static final long REPLAN_MS=500, NO_PROGRESS_MS=2500;
    static final double TARGET_SHIFT=1;
    record Target(Object identity,UUID uuid,Object dimension,Vec3 position,boolean available) {}
    interface View {
        boolean mayDrive();
        void refresh(); // Recheck walking conditions and start one terrain-read budget for this tick.
        Vec3 position();
        Object dimension();
        float health();
        Target target(String name);
        boolean safe(Vec3 from,Vec3 to);
        boolean reached(Vec3 feet,Vec3 target,double distance);
        List<Vec3> plan(Vec3 target,double distance);
        void move(Vec3 delta);
        void stop();
        default boolean nativeNavigation(){return false;}
        default boolean navigate(Vec3 target,double distance){throw new UnsupportedOperationException();}
        default void cancelNavigation(){}
        default JsonObject navigationDetails(){return null;}
    }
    private final ControlSession.Operation operation;
    private final View view;
    private final LongSupplier clock;
    private final String name;
    private final UUID expected;
    private final double distance;
    private final Target bound;
    private float health;
    private List<Vec3> route;
    private int index;
    private Vec3 plannedTarget,progress;
    private long lastPlan=Long.MIN_VALUE,lastProgress;
    private String state;
    private boolean stopped;
    static final double UNREACHABLE_SHIFT=2;
    static final long UNREACHABLE_RETRY_MS=3000;
    private Vec3 unreachableTarget;
    private long unreachableSince;

    FollowCompanion(ControlSession.Operation operation,View view,LongSupplier clock) {
        this.operation=operation;this.view=view;this.clock=clock;
        name=string(operation.args,"player");
        String uuid=string(operation.args,"expectedEntityId");
        try {expected=UUID.fromString(uuid);}
        catch(IllegalArgumentException invalid) {throw error("INVALID_ARGUMENT","expectedEntityId must be a UUID");}
        if(!expected.toString().equalsIgnoreCase(uuid)) throw error("INVALID_ARGUMENT","expectedEntityId must be a complete UUID");
        distance=bounded(operation.args,"distance",2.5,1.5,6);
        if(!view.mayDrive()) throw error("LEASE_LOST","Control expired before continuous follow");
        bound=view.target(name);
        health=view.health();progress=view.position();lastProgress=clock.getAsLong();
    }
    private void validate(Target actual) {
        if(bound==null||actual==null||!actual.available()||!expected.equals(actual.uuid())||
            actual.identity()!=bound.identity()||actual.dimension()!=view.dimension()||actual.dimension()!=bound.dimension())
            throw error("STALE_TARGET","Companion player left, changed identity, or changed dimension");
        if(actual.position().distanceTo(view.position())>32) throw error("STALE_TARGET","Companion player moved beyond 32 blocks");
        if(!view.nativeNavigation()&&Math.abs(actual.position().y-view.position().y)>1.2) throw error("BLOCKED","Companion left supported flat-ground range");
    }
    void tick() {
        if(stopped||!operation.status.equals("running")) {stop();return;}
        if(!view.mayDrive()) {stop();return;}
        try {
            view.refresh();
            Target actual=view.target(name);validate(actual);
            if(view.health()<health) throw error("BLOCKED","Body took damage during continuous follow");
            health=view.health();
            Vec3 feet=view.position();
            if(view.nativeNavigation()){
                // The player may stand where no walking route reaches (a roof, a pillar). Wait in place and
                // look for a route again once they move or a few seconds pass, instead of ending the follow.
                long now=clock.getAsLong();
                if(unreachableTarget!=null&&actual.position().distanceTo(unreachableTarget)<=UNREACHABLE_SHIFT&&now-unreachableSince<UNREACHABLE_RETRY_MS){
                    view.stop();publish("waiting");operation.summary="Waiting: no walking route to companion yet";return;
                }
                unreachableTarget=null;
                try {boolean arrived=view.navigate(actual.position(),distance);publish(arrived?"waiting":"following");}
                catch(Protocol.Error error){
                    if(!error.code.equals("NO_PATH"))throw error;
                    unreachableTarget=actual.position();unreachableSince=now;
                    view.stop();publish("waiting");operation.summary="Waiting: no walking route to companion yet";
                }
                return;
            }
            if(!view.safe(feet,feet)) throw error("BLOCKED","Body is no longer on safe loaded flat ground");
            long now=clock.getAsLong();
            if(view.reached(feet,actual.position(),distance)) {
                view.stop();route=null;lastProgress=now;progress=feet;publish("waiting");return;
            }
            if("waiting".equals(state)) {lastProgress=now;progress=feet;}
            publish("following");
            if(feet.distanceToSqr(progress)>0.04) {lastProgress=now;progress=feet;}
            if(now-lastProgress>NO_PROGRESS_MS) throw error("BLOCKED","Continuous follow made no progress");
            if(route!=null) {
                while(index<route.size()&&feet.subtract(route.get(index)).horizontalDistance()<0.15) index++;
                if(index>=route.size()) route=null;
            }
            if(route==null&&lastPlan!=Long.MIN_VALUE&&now-lastPlan<REPLAN_MS) {view.stop();return;}
            boolean invalid=route!=null&&!remainingSafe(feet);
            boolean moved=route!=null&&actual.position().distanceTo(plannedTarget)>TARGET_SHIFT&&
                !view.reached(route.getLast(),actual.position(),distance);
            if(route==null||invalid||(moved&&now-lastPlan>=REPLAN_MS)) {
                if(invalid&&now-lastPlan<REPLAN_MS) throw error("BLOCKED","Route repeatedly invalidated within replan interval");
                // Keep a small arrival margin so waypoint tolerance cannot end just outside distance.
                route=view.plan(actual.position(),distance-0.2);index=0;lastPlan=now;plannedTarget=actual.position();
                if(route.isEmpty()) throw error("NO_PATH","No continuous follow stand position");
                if(!view.mayDrive()) {stop();return;}
            }
            while(index<route.size()&&feet.subtract(route.get(index)).horizontalDistance()<0.15) index++;
            if(index>=route.size()) {
                // A small target shift can invalidate a completed stand without meeting TARGET_SHIFT.
                route=null;view.stop();return;
            }
            Vec3 delta=route.get(index).subtract(feet);
            Vec3 step=new Vec3(delta.x,0,delta.z).normalize().scale(Math.min(0.6,delta.horizontalDistance()));
            if(!view.safe(feet,feet.add(step))) throw error("BLOCKED","Next follow step is no longer safe");
            if(!view.mayDrive()) {stop();return;}
            view.move(delta);
            publish("following");
        } catch(Protocol.Error failure) {
            operation.finish("failed",failure.code+": "+failure.getMessage(),result(failure.code));stop();
        } catch(RuntimeException failure) {
            operation.finish("failed","Continuous follow failed: "+failure.getClass().getSimpleName(),result("INTERNAL"));stop();
        }
    }
    private boolean remainingSafe(Vec3 feet) {
        Vec3 from=feet;
        for(int i=index;i<route.size();i++) {
            if(!view.safe(from,route.get(i))) return false;
            from=route.get(i);
        }
        return true;
    }
    private JsonObject result(String code) {
        Vec3 feet=view.position();
        JsonObject result=obj("state",state==null?"following":state,"player",name,"expectedEntityId",expected.toString(),
            "distance",distance,"position",obj("x",feet.x,"y",feet.y,"z",feet.z));
        if(view.navigationDetails()!=null)result.add("navigation",view.navigationDetails());
        if(code!=null) result.addProperty("code",code);
        return result;
    }
    private void publish(String next) {
        if(!Objects.equals(state,next)) operation.summary=next.equals("waiting")?"Waiting near companion":"Following companion";
        state=next;operation.result=result(null);
    }
    void stop() {stopped=true;route=null;view.cancelNavigation();view.stop();}

    static FollowCompanion create(ControlSession.Operation operation,BodyPlayer body,ControlSession session,MinecraftServer server) {
        View view=new View() {
            FlatApproach geometry;
            final NativeNavigation navigation=new NativeNavigation(body,session,operation);
            public boolean mayDrive() {return session.mayDrive(operation);}
            public void refresh() {NativeNavigation.conditions(body);geometry=new FlatApproach(body);}
            public boolean nativeNavigation(){return true;}
            public boolean navigate(Vec3 target,double distance){return navigation.tick(target,feet->geometry.playerReach(feet,server.getPlayerList().getPlayerByName(string(operation.args,"player")),distance));}
            public void cancelNavigation(){navigation.stop();}
            public JsonObject navigationDetails(){return navigation.diagnostics();}
            public Vec3 position() {return body.position();}
            public Object dimension() {return body.serverLevel();}
            public float health() {return body.getHealth();}
            public Target target(String name) {
                ServerPlayer target=server.getPlayerList().getPlayerByName(name);
                return target==null?null:new Target(target,target.getUUID(),target.serverLevel(),target.position(),
                    target!=body&&target.isAlive()&&!target.isRemoved()&&target.connection!=null&&target.connection.isAcceptingMessages());
            }
            public boolean safe(Vec3 from,Vec3 to) {return geometry.safe(from,to);}
            public boolean reached(Vec3 feet,Vec3 target,double distance) {
                ServerPlayer actual=server.getPlayerList().getPlayerByName(string(operation.args,"player"));
                return actual!=null&&geometry.playerReach(feet,actual,distance);
            }
            public List<Vec3> plan(Vec3 target,double distance) {
                FlatRoute.Cell origin=new FlatRoute.Cell(body.blockPosition().getX(),body.blockPosition().getZ());
                if(!geometry.safe(body.position(),geometry.point(origin))) throw error("BLOCKED","Cannot safely enter follow route grid");
                return FlatRoute.plan(origin,new FlatRoute.View() {
                    public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to) {return geometry.safe(geometry.point(from),geometry.point(to));}
                    public boolean goal(FlatRoute.Cell cell) {return reached(geometry.point(cell),target,distance);}
                }).stream().map(geometry::point).toList();
            }
            public void move(Vec3 delta) {body.moveInput(delta.x,delta.z);}
            public void stop() {body.stopInput();}
        };
        return new FollowCompanion(operation,view,()->System.nanoTime()/1_000_000);
    }
}
