package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.level.PathNavigationRegion;
import net.minecraft.world.level.pathfinder.*;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * One loaded-only navigation driver shared by movement, interaction approaches and pickup.
 * Routes come from vanilla's walking path finder (the one zombies and villagers use: steps, slopes,
 * one-block jumps, safe drops, no water/lava/fire), computed for a detached zombie standing where
 * the body stands. Driving follows vanilla PathNavigation/MoveControl: steer at the next node,
 * jump when it is a block higher, advance within the waypoint radius, replan when stuck.
 */
final class NativeNavigation {
    static final int MAX_REPLANS=4,MAX_RANGE=48,MAX_VISITED=2048;
    static final double WAYPOINT=0.45,STUCK_MS=2000,FINAL_APPROACH=1.5;
    private final BodyPlayer body;
    private final ControlSession session;
    private final ControlSession.Operation operation;
    private final Object dimension;
    private final float initialHealth;
    private Zombie model;
    private RouteEvaluator evaluator;
    private PathFinder finder;
    private List<Vec3> route;
    private int index,replans;
    private int plans,routePoints,totalReplans,visitedLimit;
    private long searchNanos,maxSearchNanos;
    private Vec3 target,progress,replanAnchor;
    private long lastProgress,lastPlan;
    private boolean stopped,jumped;
    private int lastTick=Integer.MIN_VALUE;
    private boolean arrivedThisTick;
    NativeNavigation(BodyPlayer body,ControlSession session,ControlSession.Operation operation){
        this.body=body;this.session=session;this.operation=operation;dimension=body.serverLevel();initialHealth=body.getHealth();
        progress=replanAnchor=body.position();lastProgress=clock();
    }
    private static long clock(){return System.nanoTime()/1_000_000;}
    static void conditions(BodyPlayer body) {
        if(body.containerMenu!=body.inventoryMenu)throw error("BUSY","Close the container before navigating");
        if(!body.isAlive()||body.isRemoved()||body.isInWater()||body.isInLava()||body.isPassenger()||body.isFallFlying()||body.isSleeping()||body.getPose()!=Pose.STANDING||body.isOnFire()||body.getTicksFrozen()>0)
            throw error("BLOCKED","Body cannot safely navigate in its current state");
    }
    boolean tick(Vec3 destination,Predicate<Vec3> goal){return tick(destination,goal,p->true);}
    boolean tick(Vec3 destination,Predicate<Vec3> goal,Predicate<Vec3> allowed){
        if(stopped||!session.mayDrive(operation)){stop();return false;}
        conditions(body);if(body.serverLevel()!=dimension)throw error("STALE_TARGET","Navigation dimension changed");
        if(body.getHealth()<initialHealth)throw error("BLOCKED","Body took damage during navigation; safe movement was not confirmed");
        int tick=body.getServer().getTickCount();if(lastTick==tick)return arrivedThisTick;
        lastTick=tick;arrivedThisTick=false;
        Vec3 feet=body.position();long now=clock();
        if(!allowed.test(feet))throw error("OUT_OF_REACH","Navigation left its authorized region");
        if(body.onGround()&&goal.test(feet)){
            body.stopInput();route=null;replans=0;progress=replanAnchor=feet;lastProgress=now;arrivedThisTick=true;return true;
        }
        if(feet.distanceToSqr(progress)>0.09){progress=feet;lastProgress=now;}
        // Real progress since the last replan earns the finite replan budget back.
        if(feet.distanceTo(replanAnchor)>2){replans=0;replanAnchor=feet;}
        if(route!=null&&now-lastProgress>STUCK_MS){
            if(!body.onGround())throw error("BLOCKED","Airborne navigation made no progress");
            replan(now);lastProgress=now;
        }
        // A moving destination (a walking player) is re-routed at most twice a second, from the ground.
        if(route!=null&&target!=null&&destination.distanceTo(target)>1&&now-lastPlan>=500&&body.onGround())route=null;
        if(route==null){
            if(!body.onGround()){steer(feet,null);return false;}
            plan(feet,destination,goal,allowed,now);
            if(!session.mayDrive(operation)){stop();return false;}
        }
        while(index<route.size()&&reached(feet,route.get(index)))index++;
        if(index>=route.size()){
            // Route used up but the goal is not met yet (a dropped item still falling, or lying just off the
            // last block centre): step straight at a close destination, and replan no more than twice a second
            // so a settling target does not burn the whole replan budget in a few ticks.
            Vec3 level=new Vec3(destination.x,feet.y,destination.z);
            if(body.onGround()&&level.subtract(feet).horizontalDistance()<=FINAL_APPROACH&&destination.y-feet.y<2.5&&destination.y-feet.y>-1&&allowed.test(level)&&floored(feet,level)){steer(feet,level);return false;}
            if(now-lastPlan<500){body.stopInput();return false;}
            replan(now);return false;
        }
        Vec3 next=route.get(index);
        if(!allowed.test(next))throw error("OUT_OF_REACH","Next navigation node left its authorized region");
        steer(feet,next);
        return false;
    }
    private void ensureModel(){
        if(model==null||model.level()!=body.level()){
            model=new Zombie(EntityType.ZOMBIE,body.level());
            // The body never swims, wades through powder snow or opens doors on its own.
            model.setPathfindingMalus(PathType.WATER,-1);model.setPathfindingMalus(PathType.WATER_BORDER,8);
            model.setPathfindingMalus(PathType.DANGER_FIRE,-1);model.setPathfindingMalus(PathType.DAMAGE_FIRE,-1);
            model.setPathfindingMalus(PathType.DANGER_POWDER_SNOW,-1);model.setPathfindingMalus(PathType.POWDER_SNOW,-1);
            model.setPathfindingMalus(PathType.DANGER_OTHER,-1);model.setPathfindingMalus(PathType.DAMAGE_OTHER,-1);
            evaluator=new RouteEvaluator();evaluator.setCanPassDoors(true);evaluator.setCanOpenDoors(false);evaluator.setCanFloat(false);
        }
    }
    /**
     * A random loaded spot a few blocks around a centre where vanilla would let a walker stand
     * (solid floor, room for the body, no water, fire, powder snow or other danger), or null.
     */
    Vec3 strollPoint(Vec3 centre,double minRadius,double maxRadius,RandomSource random){
        ensureModel();
        for(int attempt=0;attempt<12;attempt++){
            double angle=random.nextDouble()*Math.PI*2,radius=minRadius+random.nextDouble()*(maxRadius-minRadius);
            int x=Mth.floor(centre.x+Math.cos(angle)*radius),z=Mth.floor(centre.z+Math.sin(angle)*radius),top=Mth.floor(centre.y)+2;
            for(int y=top;y>=top-5;y--){
                BlockPos pos=new BlockPos(x,y,z);
                if(!body.serverLevel().isLoaded(pos))break;
                PathType type=WalkNodeEvaluator.getPathTypeStatic(model,pos);
                if(type==PathType.WALKABLE)return new Vec3(x+0.5,y,z+0.5);
                if(type!=PathType.OPEN)break; // the first non-air from above decides: a wall, water or danger is no floor
            }
        }
        return null;
    }
    private void plan(Vec3 feet,Vec3 destination,Predicate<Vec3> goal,Predicate<Vec3> allowed,long now){
        body.stopInput();
        ensureModel();
        model.moveTo(feet.x,feet.y,feet.z,body.getYRot(),0);model.setOnGround(body.onGround());
        float range=(float)Math.min(MAX_RANGE,feet.distanceTo(destination)+16);
        visitedLimit=Math.min(MAX_VISITED,(int)(range*16));
        finder=new PathFinder(evaluator,visitedLimit);
        evaluator.allowed=allowed;
        BlockPos from=body.blockPosition();int radius=(int)range+8;
        long began=System.nanoTime();
        Path path=finder.findPath(new PathNavigationRegion(body.level(),from.offset(-radius,-radius,-radius),from.offset(radius,radius,radius)),
            model,Set.of(BlockPos.containing(destination)),range,0,1); // reach the target block itself: one block short is outside item pickup reach
        long elapsed=System.nanoTime()-began;searchNanos+=elapsed;maxSearchNanos=Math.max(maxSearchNanos,elapsed);plans++;
        if(path==null||path.getNodeCount()==0)throw error("NO_PATH","No loaded walkable route from the current position");
        List<Vec3> points=new ArrayList<>();
        for(int i=0;i<path.getNodeCount();i++){Node node=path.getNode(i);points.add(new Vec3(node.x+0.5,node.y,node.z+0.5));}
        // The last node is a block centre; a nearby, allowed goal point (an item, a stand spot) is the final steer.
        Vec3 last=points.getLast();
        if(path.canReach()&&goal.test(destination)&&allowed.test(destination)&&last.subtract(destination).horizontalDistance()<=FINAL_APPROACH&&Math.abs(last.y-destination.y)<0.6)points.add(destination);
        if(points.size()==1&&reached(feet,points.getFirst())&&!goal.test(feet)&&!path.canReach())throw error("NO_PATH","No loaded walkable route makes progress toward the destination");
        route=points;index=0;target=destination;lastPlan=now;lastProgress=now;progress=feet;routePoints=points.size();
    }
    /** The straight final step stays on solid floor: no hole under its middle or its end. */
    private boolean floored(Vec3 feet,Vec3 to){
        for(Vec3 p:List.of(feet.lerp(to,0.5),to)){
            BlockPos below=BlockPos.containing(p.x,feet.y-0.5,p.z);
            if(!body.serverLevel().isLoaded(below)||body.serverLevel().getBlockState(below).getCollisionShape(body.serverLevel(),below).isEmpty())return false;
        }
        return true;
    }
    /** Vanilla PathNavigation#followThePath: inside the waypoint radius horizontally and less than a block vertically. */
    static boolean reached(Vec3 feet,Vec3 node){
        return Math.abs(feet.x-node.x)<=WAYPOINT&&Math.abs(feet.z-node.z)<=WAYPOINT&&Math.abs(feet.y-node.y)<1;
    }
    private void steer(Vec3 feet,Vec3 next){
        if(next==null){if(body.onGround())body.stopInput();return;}
        Vec3 delta=next.subtract(feet);
        Input input=inputs(delta,body.onGround(),body.horizontalCollision,body.maxUpStep());
        body.jumpInput(input.jump());jumped|=input.jump();
        if(input.forward()>0)body.moveInput(delta.x,delta.z,input.forward());else{body.forwardInput=0;}
    }
    record Input(float forward,boolean jump){}
    /** Vanilla MoveControl: jump when the next node is higher than a step and close, or when a wall stops a rising leg. */
    static Input inputs(Vec3 delta,boolean onGround,boolean blocked,double maxUpStep){
        double distance=delta.horizontalDistance();
        boolean jump=onGround&&(delta.y>maxUpStep&&distance*distance<1.0||blocked&&delta.y>0.05);
        return new Input(distance<=0.08?0:(float)Math.min(1,distance/0.4),jump);
    }
    private void replan(long now){
        body.stopInput();totalReplans++;if(++replans>MAX_REPLANS)throw error("BLOCKED","Navigation finite obstacle/stuck replan budget exhausted");
        route=null;lastPlan=now;
    }
    void stop(){stopped=true;route=null;body.stopInput();}
    private static JsonObject point(Vec3 p){return p==null?null:obj("x",p.x,"y",p.y,"z",p.z);}
    JsonObject diagnostics(){return obj("planner","vanilla-walk","plans",plans,"obstacleReplans",totalReplans,"routePoints",routePoints,"visitedLimit",visitedLimit,
        "searchMs",searchNanos/1_000_000d,"maxSearchMs",maxSearchNanos/1_000_000d,"jumped",jumped,
        "next",route!=null&&index<route.size()?point(route.get(index)):null,"feet",point(body.position()),"motion",point(body.getDeltaMovement()),
        "onGround",body.onGround(),"stage",route==null?"planning":body.onGround()?"walk":"air");}

    /** Walking nodes, minus any node outside the caller's authorized region. */
    private static final class RouteEvaluator extends WalkNodeEvaluator {
        Predicate<Vec3> allowed=p->true;
        @Override public int getNeighbors(Node[] output,Node node){
            int count=super.getNeighbors(output,node),kept=0;
            for(int i=0;i<count;i++){Node next=output[i];if(allowed.test(new Vec3(next.x+0.5,next.y,next.z+0.5)))output[kept++]=next;}
            return kept;
        }
    }
}
