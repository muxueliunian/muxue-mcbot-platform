package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** One loaded-only navigation driver shared by movement, interaction approaches and pickup. */
final class NativeNavigation {
    static final int MAX_SEARCH_READS=1_000_000,MAX_REPLANS=3;
    private final BodyPlayer body;
    private final ControlSession session;
    private final ControlSession.Operation operation;
    private final Object dimension;
    private final float initialHealth;
    private FlatApproach geometry;
    private NavigationSearch search;
    private List<Vec3> route;
    private int index,reads,replans;
    private int expandedTotal,plans,routePoints,readsTotal,totalReplans;
    private long searchNanos,maxSearchSliceNanos;
    private Vec3 target,progress,legStart;
    private long lastProgress,lastPlan,airStart;
    private boolean airborneLeg,jumping,sawAir,clearedLip,stopped;
    private int lastTick=Integer.MIN_VALUE;
    private boolean arrivedThisTick;
    private Predicate<Vec3> liveGoal,liveAllowed;
    NativeNavigation(BodyPlayer body,ControlSession session,ControlSession.Operation operation){
        this.body=body;this.session=session;this.operation=operation;dimension=body.serverLevel();initialHealth=body.getHealth();
        progress=body.position();lastProgress=clock();
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
        geometry=new FlatApproach(body);liveGoal=goal;liveAllowed=allowed;Vec3 feet=body.position();long now=clock();
        if(!allowed.test(feet))throw error("OUT_OF_REACH","Navigation left its authorized region");
        if(!geometry.clear(feet,feet))throw error("BLOCKED","Current body intersects danger, collision or unloaded terrain");
        if(body.onGround()&&geometry.stand(feet)&&goal.test(feet)){
            body.stopInput();route=null;search=null;airborneLeg=false;jumping=false;replans=0;reads=0;progress=feet;lastProgress=now;arrivedThisTick=true;return true;
        }
        if(feet.distanceToSqr(progress)>0.04){progress=feet;lastProgress=now;}
        if(route!=null&&now-lastProgress>3000){
            if(!body.onGround())throw error("BLOCKED","Airborne navigation made no progress");
            replan(now);lastProgress=now;
        }
        if(target!=null&&destination.distanceTo(target)>1&&now-lastPlan>=500&&body.onGround()){
            route=null;search=null;airborneLeg=false;jumping=false;
        }
        if(route==null){
            body.stopInput();
            if(!body.onGround())throw error("BLOCKED","Navigation may start or replan only from native supported ground");
            if(search==null)begin(destination,goal,allowed,now);
            if(now-lastPlan>10_000)throw error("TIMEOUT","Navigation incremental search time budget exhausted");
            int before=geometry.reads(),priorExpanded=search.expanded();long began=System.nanoTime();
            boolean done=search.advance();long elapsed=System.nanoTime()-began;searchNanos+=elapsed;maxSearchSliceNanos=Math.max(maxSearchSliceNanos,elapsed);
            expandedTotal+=search.expanded()-priorExpanded;reads+=geometry.reads()-before;readsTotal+=geometry.reads()-before;
            if(reads>MAX_SEARCH_READS)throw error("PATH_BUDGET","Navigation total terrain read budget exhausted");
            if(!session.mayDrive(operation)){stop();return false;}
            if(!done)return false;
            route=new ArrayList<>(search.result().stream().map(NavigationSearch.Cell::point).toList());search=null;index=0;legStart=feet;lastProgress=now;progress=feet;
            if(!goal.test(route.getLast())&&goal.test(destination)&&allowed.test(destination)&&geometry.transition(route.getLast(),destination))route.add(destination);
            routePoints=route.size();
        }
        while(index<route.size()&&body.onGround()&&feet.subtract(route.get(index)).horizontalDistance()<0.17&&Math.abs(feet.y-route.get(index).y)<0.1){
            index++;legStart=feet;airborneLeg=false;jumping=false;sawAir=false;clearedLip=false;
        }
        if(index>=route.size()){replan(now);return false;}
        Vec3 next=route.get(index);double rise=next.y-legStart.y;
        if(!allowed.test(next)||!allowed.test(feet.lerp(next,0.5)))throw error("OUT_OF_REACH","Next navigation leg left its authorized region");
        boolean leavingDrop=groundFlaggedDrop(body.onGround(),airborneLeg,jumping,feet,next,body.onGround()&&geometry.groundContact(feet));
        if(body.onGround()&&!leavingDrop){
            if(airborneLeg&&sawAir&&Math.abs(feet.y-next.y)>0.15)throw error("BLOCKED","Body landed outside its verified destination height");
            GroundNavigation.Step grounded=geometry.groundStep(legStart,feet,next);
            if(!grounded.allowed()) {replan(now);return false;}
            legStart=grounded.from();rise=grounded.rise();
            jumping=rise>0.6;airborneLeg=jumping||rise< -0.05;airStart=now;sawAir=false;clearedLip=false;
        }
        if(!body.onGround()||leavingDrop) {
            // Only the current, previously validated leg may authorize leaving the ground.
            if(!airborneLeg&&rise<=0.6&&rise>=0&&feet.y>=legStart.y-0.1&&feet.y<=next.y+0.65){airborneLeg=true;airStart=now;}
            if(!airborneLeg)throw error("BLOCKED","Unplanned airborne movement");
            sawAir=true;
            if(leavingDrop&&!geometry.dropClear(feet,next))throw error("BLOCKED","Actual drop departure sweep became unsafe");
            if(feet.y>=next.y+0.04)clearedLip=true;
            if(!insideAirCorridor(feet,legStart,next,jumping,clearedLip,body.getDeltaMovement().y,now-airStart))
                throw error("BLOCKED","Body left the verified jump/drop corridor");
            if(!geometry.stand(next))throw error("BLOCKED","Jump/drop landing changed or became unsafe");
        }
        if(!session.mayDrive(operation)){stop();return false;}
        if(!allowed.test(body.position())||!allowed.test(next))throw error("OUT_OF_REACH","Navigation region changed before native input");
        Vec3 delta=next.subtract(feet);
        body.stopInput();
        Input input=inputs(delta,jumping&&!sawAir);
        if(input.jump())body.jumpInput(true);
        // Vanilla handles the safe riser side collision while rising. Waiting until the apex
        // before pressing forward cannot clear a one-block lip when starting from rest.
        if(input.forward()>0)body.moveInput(delta.x,delta.z,input.forward());
        return false;
    }
    private void begin(Vec3 destination,Predicate<Vec3> goal,Predicate<Vec3> allowed,long now){
        Vec3 feet=body.position();NavigationSearch.Cell origin=null;
        NavigationSearch.Cell base=NavigationSearch.Cell.at(feet);
        for(int dx:new int[]{0,-1,1})for(int dz:new int[]{0,-1,1}){
            NavigationSearch.Cell candidate=new NavigationSearch.Cell(base.x()+dx,feet.y,base.z()+dz);
            if(candidate.point().subtract(feet).horizontalDistance()<=0.72&&allowed.test(candidate.point())&&geometry.transition(feet,candidate.point())&&
                (origin==null||candidate.point().distanceToSqr(feet)<origin.point().distanceToSqr(feet)))origin=candidate;
        }
        if(origin==null)throw error("BLOCKED","Cannot enter a supported navigation grid");
        target=destination;lastPlan=now;reads+=geometry.reads();readsTotal+=geometry.reads();plans++;
        search=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){return geometry.neighbours(at).stream().filter(c->liveAllowed.test(c.point())&&liveAllowed.test(at.point().lerp(c.point(),0.5))).toList();}
            public boolean goal(NavigationSearch.Cell at){return FlatApproach.arrivalStand(at.point(),p->liveAllowed.test(p)&&liveGoal.test(p))||
                at.point().distanceTo(destination)<=1&&liveAllowed.test(destination)&&liveGoal.test(destination)&&geometry.transition(at.point(),destination);}
            public double estimate(NavigationSearch.Cell at){return Math.max(0,at.point().distanceTo(destination)-2);}
        });
    }
    private void replan(long now){
        body.stopInput();totalReplans++;if(++replans>MAX_REPLANS)throw error("BLOCKED","Navigation finite obstacle/stuck replan budget exhausted");
        route=null;search=null;airborneLeg=false;jumping=false;lastPlan=now;
    }
    static double horizontalCorridor(Vec3 point,Vec3 from,Vec3 to){
        Vec3 span=new Vec3(to.x-from.x,0,to.z-from.z),offset=new Vec3(point.x-from.x,0,point.z-from.z);
        double t=span.lengthSqr()==0?0:Math.max(0,Math.min(1,offset.dot(span)/span.lengthSqr()));
        return offset.subtract(span.scale(t)).length();
    }
    static boolean insideAirCorridor(Vec3 feet,Vec3 from,Vec3 to,boolean jump,boolean clearedLip,double verticalMotion,long elapsedMs){
        boolean fellBelowLip=jump&&clearedLip&&verticalMotion<0&&feet.y<to.y-0.15;
        double maximum=jump?from.y+1.4:Math.max(from.y,to.y)+0.65;
        return elapsedMs<=2000&&feet.y>=Math.min(from.y,to.y)-0.15&&!fellBelowLip&&feet.y<=maximum&&horizontalCorridor(feet,from,to)<=0.5;
    }
    record Input(float forward,boolean jump){}
    static Input inputs(Vec3 delta,boolean initiateJump){
        double distance=delta.horizontalDistance();return new Input(distance<=0.08?0:(float)Math.min(1,distance/0.4),initiateJump);
    }
    static boolean groundFlaggedDrop(boolean onGround,boolean authorizedAirLeg,boolean jump,Vec3 feet,Vec3 next,boolean contact){
        return onGround&&authorizedAirLeg&&!jump&&feet.y>next.y+0.15&&!contact;
    }
    void stop(){stopped=true;search=null;route=null;airborneLeg=false;jumping=false;body.stopInput();}
    private static JsonObject point(Vec3 p){return p==null?null:obj("x",p.x,"y",p.y,"z",p.z);}
    JsonObject diagnostics(){return obj("plans",plans,"obstacleReplans",totalReplans,"expandedNodes",expandedTotal,"searchReads",readsTotal,"routePoints",routePoints,
        "searchMs",searchNanos/1_000_000d,"maxSearchSliceMs",maxSearchSliceNanos/1_000_000d,"sliceBudgetMs",2,"maxExpansionsPerTick",NavigationSearch.PER_TICK,
        "legStart",point(legStart),"next",route!=null&&index<route.size()?point(route.get(index)):null,"feet",point(body.position()),"motion",point(body.getDeltaMovement()),
        "onGround",body.onGround(),"stage",search!=null?"planning":jumping?(clearedLip?"jump-crossing":"jump-rising"):airborneLeg?"drop-or-land":"walk","airElapsedMs",airborneLeg?clock()-airStart:0);}
}
