package com.mcbot.servercontrol;

import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.Shapes;
import static com.mcbot.servercontrol.Protocol.*;

/** Search scheduling and limits, plus native shape/corridor facts without a world or teleport. */
final class NavigationTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable run){checks++;try{run.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error e){if(!e.code.equals(code))throw e;}}
    private static NavigationSearch.Cell cell(int x,double y,int z){return new NavigationSearch.Cell(x,y,z);}
    private static List<NavigationSearch.Cell> solve(NavigationSearch search){int ticks=0;while(!search.advance()){if(++ticks>1000)throw new AssertionError("Unbounded search");}return search.result();}
    static void run(){
        groundedDriving();
        Map<NavigationSearch.Cell,List<NavigationSearch.Cell>> terrain=new HashMap<>();
        var origin=cell(0,1,0);var slab=cell(1,1.5,0);var stair=cell(2,2,0);var jump=cell(4,3,0);var drop=cell(6,1,0);
        terrain.put(origin,List.of(slab));terrain.put(slab,List.of(stair));terrain.put(stair,List.of(jump));terrain.put(jump,List.of(drop));terrain.put(drop,List.of());
        NavigationSearch route=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){return terrain.getOrDefault(at,List.of());}
            public boolean goal(NavigationSearch.Cell at){return at.equals(drop);}
            public double estimate(NavigationSearch.Cell at){return at.point().distanceTo(drop.point());}
        },()->0);
        check(solve(route).equals(List.of(origin,slab,stair,jump,drop)),"Three-dimensional route retains slab/stair/jump/drop heights");
        AtomicLong time=new AtomicLong();
        NavigationSearch slices=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){return List.of(cell(at.x()+1,at.y(),at.z()));}
            public boolean goal(NavigationSearch.Cell at){return at.x()==40;}
            public double estimate(NavigationSearch.Cell at){return 40-at.x();}
        },()->time.getAndAdd(3_000_000));
        check(!slices.advance()&&slices.expanded()==1,"Time slice yields after one expansion when elapsed time exceeds budget");
        check(!slices.advance()&&slices.expanded()==2,"Search frontier survives between server ticks");
        check(solve(slices).size()==41,"Incremental search reaches the same complete route");
        NavigationSearch nodeSlices=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){List<NavigationSearch.Cell> next=new ArrayList<>();for(int z=0;z<60;z++)next.add(cell(at.x()+1,1,z));return next;}
            public boolean goal(NavigationSearch.Cell at){return false;}
            public double estimate(NavigationSearch.Cell at){return 0;}
        },()->0);
        check(!nodeSlices.advance()&&nodeSlices.expanded()==NavigationSearch.PER_TICK,"Expansion slice caps fast terrain at 64 nodes");
        NavigationSearch noPath=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){return List.of(cell(100,1,0),cell(1,10,0));}
            public boolean goal(NavigationSearch.Cell at){return !at.equals(origin);}
            public double estimate(NavigationSearch.Cell at){return 0;}
        },()->0);
        errorCode("NO_PATH",noPath::advance);
        NavigationSearch manyEdges=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){return Collections.nCopies(NavigationSearch.MAX_EDGES+1,origin);}
            public boolean goal(NavigationSearch.Cell at){return false;}
            public double estimate(NavigationSearch.Cell at){return 0;}
        },()->0);
        errorCode("PATH_BUDGET",manyEdges::advance);
        NavigationSearch manyNodes=new NavigationSearch(origin,new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){List<NavigationSearch.Cell> result=new ArrayList<>();for(int x=-32;x<=32;x++)for(int z=-32;z<=32;z++)result.add(cell(x,1,z));return result;}
            public boolean goal(NavigationSearch.Cell at){return false;}
            public double estimate(NavigationSearch.Cell at){return 0;}
        },()->0);
        errorCode("PATH_BUDGET",manyNodes::advance);
        List<NavigationSearch.Cell> longPath=new ArrayList<>();
        for(int row=0;row<4;row++)for(int x=0;x<60;x++)longPath.add(cell(row%2==0?x:59-x,1,row));
        NavigationSearch tooLong=new NavigationSearch(longPath.getFirst(),new NavigationSearch.View(){
            public List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell at){int i=longPath.indexOf(at);return i+1<longPath.size()?List.of(longPath.get(i+1)):List.of();}
            public boolean goal(NavigationSearch.Cell at){return at.equals(longPath.getLast());}
            public double estimate(NavigationSearch.Cell at){return 0;}
        },()->0);
        errorCode("PATH_BUDGET",()->solve(tooLong));
        AABB standing=new AABB(-0.3,1,-0.3,0.3,2.8,0.3),raised=standing.move(0,1.25,0);
        check(!FlatApproach.collides(standing,Shapes.create(new AABB(-1,3,-1,1,4,1))),"Low ceiling allows standing body");
        check(FlatApproach.collides(standing.minmax(raised),Shapes.create(new AABB(-1,3,-1,1,4,1))),"Same low ceiling intersects the real jumping body envelope");
        check(!FlatApproach.collides(standing.minmax(raised),Shapes.create(new AABB(-1,4.1,-1,1,5,1))),"High ceiling clears native jump envelope");
        var sole=Shapes.create(new AABB(0.46,1.985,0.46,0.54,1.995,0.54));
        check(FlatApproach.supported(sole,Shapes.create(new AABB(0.4,1.5,0,1,2,1))),"Stair upper tread supports checked centre");
        check(!FlatApproach.supported(sole,Shapes.create(new AABB(0,1,0,0.4,2,1))),"Side ledge without centre support rejected");
        check(NativeNavigation.horizontalCorridor(new Vec3(0.5,20,0.1),new Vec3(0,1,0),new Vec3(1,2,0))<0.11,"Known airborne leg checks horizontal corridor independently of height");
        check(NativeNavigation.horizontalCorridor(new Vec3(0.5,1,2),new Vec3(0,1,0),new Vec3(1,2,0))>1.9,"Unplanned lateral displacement leaves navigation corridor");
        check(NativeNavigation.horizontalCorridor(new Vec3(2,1,0),new Vec3(0,1,0),new Vec3(1,2,0))==1,"Air corridor excludes overshooting the destination");
        Vec3 from=new Vec3(0,1,0),to=new Vec3(1,2,0);
        check(NativeNavigation.insideAirCorridor(new Vec3(0,1.42,0),from,to,true,false,0.33,50),"Native first jump tick below landing height remains authorized");
        check(NativeNavigation.insideAirCorridor(new Vec3(0.6,2.18,0),from,to,true,true,-0.02,400),"Descending jump above its landing lip remains authorized");
        check(!NativeNavigation.insideAirCorridor(new Vec3(0.6,1.7,0),from,to,true,true,-0.2,600),"Falling under the cleared landing lip is rejected");
        check(!NativeNavigation.insideAirCorridor(new Vec3(0,2.5,0),from,to,true,true,0.1,300),"Unnative upward displacement above jump height is rejected");
        check(NativeNavigation.insideAirCorridor(new Vec3(0.8,2.4,0),new Vec3(0,3,0),new Vec3(1,1,0),false,false,-0.2,400),"Verified two-block drop permits native airborne descent");
        check(!NativeNavigation.insideAirCorridor(new Vec3(0.5,2.1,0),from,to,true,true,0,2001),"Airborne phase retains its finite deadline");
        var restingJump=NativeNavigation.inputs(new Vec3(1.08,1,0),true);
        check(restingJump.jump()&&restingJump.forward()==1,"One-block jump from rest presses native forward on the initiation tick");
        var crossingJump=NativeNavigation.inputs(new Vec3(0.7,0.8,0),false);
        check(!crossingJump.jump()&&crossingJump.forward()==1,"Authorized ascent continues steering without restarting the jump");
        check(NativeNavigation.inputs(new Vec3(0.2,0,0),false).forward()==0.5,"Waypoint approach reduces native input strength without changing velocity");
        check(NativeNavigation.inputs(new Vec3(0.01,0,0),false).forward()==0,"Arrived horizontal point releases native forward input");
        check(!ServerController.atomicAction("navigation-3d"),"Navigation capability declaration cannot be invoked as a write action");
        check(ServerController.atomicAction("retreat-from-entity"),"Safe retreat uses the existing atomic action admission boundary");
        System.out.println("NavigationTest: "+checks+" checks passed");
    }
    private static void groundedDriving(){
        class Terrain implements GroundNavigation.View{
            final List<AABB> floors=new ArrayList<>(),hazards=new ArrayList<>(),walls=new ArrayList<>();
            public boolean clear(Vec3 from,Vec3 to){
                AABB body=new AABB(from.x-0.3,from.y+0.0001,from.z-0.3,from.x+0.3,from.y+1.8,from.z+0.3);
                AABB swept=body.minmax(body.move(to.subtract(from)));
                return floors.stream().noneMatch(b->FlatApproach.collides(swept,Shapes.create(b)))&&walls.stream().noneMatch(b->FlatApproach.collides(swept,Shapes.create(b)))&&hazards.stream().noneMatch(b->swept.inflate(0,0.025,0).intersects(b));
            }
            public boolean contact(Vec3 p){AABB sole=new AABB(p.x-0.3,p.y-0.015,p.z-0.3,p.x+0.3,p.y-0.005,p.z+0.3);return floors.stream().anyMatch(b->FlatApproach.collides(sole,Shapes.create(b)));}
            public boolean stand(Vec3 p){var sole=Shapes.create(new AABB(p.x-0.04,p.y-0.015,p.z-0.04,p.x+0.04,p.y-0.005,p.z+0.04));return clear(p,p)&&floors.stream().anyMatch(b->FlatApproach.supported(sole,Shapes.create(b)));}
            public boolean supportSweep(Vec3 from,Vec3 to,double low,double high){return FlatApproach.sweptSoleSupport(from,to,low,high,floors,0.2999,0.2999);}
        }
        Terrain field=new Terrain();field.floors.add(new AABB(-3,0,-3,4,1,4));field.hazards.add(new AABB(1,1,1,2,2,2));
        Vec3 planned=new Vec3(0.25,1,0.25),feet=new Vec3(0.5,1,1),next=new Vec3(1.25,1,0.25);
        check(field.clear(feet,feet)&&GroundNavigation.check(planned,planned,next,field).allowed(),"Original leg and pushed standing body both separately clear the fire corner");
        check(!GroundNavigation.check(planned,feet,next,field).allowed(),"Grounded driver rejects the actual pushed-body diagonal into the fire corner");
        field.hazards.clear();var safe=GroundNavigation.check(planned,feet,next,field);
        check(safe.allowed()&&safe.from().equals(feet)&&safe.rise()==0,"Grounded leg anchors to the actual supported feet before steering");
        Terrain tread=new Terrain();tread.floors.add(new AABB(1,0,0,3,1.5,1));
        Vec3 edge=new Vec3(0.85,1.5,0.5),upper=new Vec3(1.25,1.5,0.5);
        check(!tread.stand(edge)&&tread.contact(edge),"Native stair stepping can support the sole edge before its centre reaches the tread");
        var step=GroundNavigation.check(new Vec3(0.5,1,0.5),edge,upper,tread);
        check(step.allowed()&&step.rise()==0,"Native edge support remains valid while actual height rebases the grounded rise");
        Terrain gap=new Terrain();gap.floors.add(new AABB(-1,0,0,0.4,1,1));gap.floors.add(new AABB(1.1,0,0,2,1,1));
        check(!GroundNavigation.check(new Vec3(0,1,0.5),new Vec3(0,1,0.5),new Vec3(1.25,1,0.5),gap).allowed(),"Actual grounded sweep rejects missing intermediate support");
        field.walls.add(new AABB(0.7,1,0.7,1,3,1));
        check(!GroundNavigation.check(planned,feet,next,field).allowed(),"Actual grounded sweep rechecks a newly present native collision shape");
        Terrain descent=new Terrain();descent.floors.add(new AABB(-2,0,-2,3,1,3));descent.floors.add(new AABB(1,1,0,3,2,1));
        Vec3 departure=new Vec3(0.5,2,0.5),landing=new Vec3(0.25,1,0.5);
        check(!descent.contact(departure)&&NativeNavigation.groundFlaggedDrop(true,true,false,departure,landing,false),"Verified drop recognizes a stale native ground flag after the sole leaves its ledge");
        check(GroundNavigation.dropClear(departure,landing,descent),"Authorized drop departure retains actual-body sweep and landing checks");
        check(!NativeNavigation.groundFlaggedDrop(true,false,false,departure,landing,false),"Ground flag plus missing support never authorizes an unplanned drop");
        check(!NativeNavigation.groundFlaggedDrop(true,true,true,departure,landing,false),"A grounded jump cannot borrow the drop-departure exception");
        descent.hazards.add(new AABB(0,1,0,1,2,1));
        check(!GroundNavigation.dropClear(departure,landing,descent),"Stale-ground drop still rejects an actual dangerous descent sweep");
    }
}
