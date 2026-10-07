package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * travel-to: a long walk in legs of up to LEG blocks, each one an ordinary NativeNavigation route to a standable
 * point on the surface toward the destination. The body is a real player, so chunks load around it as it goes;
 * a leg is only planned over loaded chunks. A leg that finds no route tries the same distance turned left and
 * right, then shorter; MAX_FAILURES legs in a row without progress fail the walk. Damage stops it, as any walk.
 */
final class TravelTask {
    static final int LEG=28,MAX_FAILURES=10;
    private static final double[] TURNS={0,35,-35,70,-70,0,50,-50};
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final double x,z,tolerance;
    private final Double y;
    private final long deadline;
    private final Vec3 start;
    private NativeNavigation navigation;
    private Vec3 leg;
    private int failures,legs;
    private double legStartDistance;
    private String lastFailure;

    TravelTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        this.operation=operation;this.player=player;this.session=session;JsonObject args=operation.args;
        x=bounded(args,"x",0,-29_999_000,29_999_000);z=bounded(args,"z",0,-29_999_000,29_999_000);
        y=args.has("y")?bounded(args,"y",0,-2048,2048):null;
        tolerance=bounded(args,"tolerance",2,1,8);
        if(horizontal(player.position())>2000)throw error("OUT_OF_REACH","travel-to is limited to 2000 blocks");
        deadline=now()+(long)bounded(args,"timeoutMs",300_000,5_000,900_000);start=player.position();
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    private double horizontal(Vec3 feet){return Math.hypot(x-feet.x,z-feet.z);}
    /** Close enough, and nothing solid between the body and the spot (a wall would mean the wrong side of it). */
    private boolean arrived(Vec3 feet) {
        if(horizontal(feet)>tolerance||y!=null&&Math.abs(feet.y-y)>3)return false;
        // Not in a doorway: the door could not be shut behind, and it is neither inside nor outside.
        var box=player.getBoundingBox().move(feet.subtract(player.position()));
        for(int bx=(int)Math.floor(box.minX);bx<=(int)Math.floor(box.maxX);bx++)for(int bz=(int)Math.floor(box.minZ);bz<=(int)Math.floor(box.maxZ);bz++)
            if(NavigationDoors.handDoor(player.serverLevel().getBlockState(new BlockPos(bx,(int)Math.floor(feet.y+0.01),bz))))return false;
        Vec3 from=feet.add(0,0.5,0),to=new Vec3(x,(y!=null?y:feet.y)+0.5,z);
        if(from.distanceTo(to)<0.3)return true;
        return player.serverLevel().clip(new ClipContext(from,to,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,player)).getType()==HitResult.Type.MISS;
    }
    JsonObject progress() {
        Vec3 feet=player.position();
        JsonObject result=obj("position",obj("x",feet.x,"y",feet.y,"z",feet.z),"remaining",horizontal(feet),"travelled",Math.hypot(feet.x-start.x,feet.z-start.z),"legs",legs,"failures",failures);
        if(lastFailure!=null)result.addProperty("lastFailure",lastFailure);
        return result;
    }
    /** Feet height of the surface at a column (top of the motion-blocking ground), or null when its chunk is not loaded. */
    private Integer surface(int bx,int bz) {
        if(player.serverLevel().getChunkSource().getChunkNow(bx>>4,bz>>4)==null)return null;
        return player.serverLevel().getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,bx,bz);
    }
    private Vec3 pickLeg(Vec3 feet) {
        double remaining=horizontal(feet);
        if(remaining<=LEG) {
            Integer top=surface((int)Math.floor(x),(int)Math.floor(z));
            if(top!=null)return new Vec3(x,y!=null?y:top,z);
        }
        double angle=Math.atan2(z-feet.z,x-feet.x)+Math.toRadians(TURNS[failures%TURNS.length]);
        for(double length=Math.min(LEG,remaining)*(failures>=TURNS.length/2+1?0.6:1);length>=6;length-=6) {
            double lx=feet.x+Math.cos(angle)*length,lz=feet.z+Math.sin(angle)*length;
            Integer top=surface((int)Math.floor(lx),(int)Math.floor(lz));
            if(top!=null&&Math.abs(top-feet.y)<=24)return new Vec3(Math.floor(lx)+0.5,top,Math.floor(lz)+0.5);
        }
        return null;
    }
    void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(now()>=deadline)throw error("TIMEOUT","Travel time limit reached before the destination");
        Vec3 feet=player.position();
        if(player.onGround()&&arrived(feet)){player.stopInput();if(navigation!=null)navigation.closeDoorsBehind();operation.finish("succeeded","Arrived",progress());return;}
        if(navigation==null) {
            if(!player.onGround())return;
            NativeNavigation.conditions(player);
            leg=pickLeg(feet);
            if(leg==null){fail(feet,"no loaded surface toward the destination");return;}
            navigation=new NativeNavigation(player,session,operation);legStartDistance=horizontal(feet);legs++;
        }
        Vec3 target=leg;boolean last=Math.hypot(target.x-x,target.z-z)<0.01;
        try {
            boolean done=navigation.tick(target,f->last?arrived(f):Math.hypot(f.x-target.x,f.z-target.z)<=2.5&&Math.abs(f.y-target.y)<=4);
            if(!done)return;
        } catch(Protocol.Error failure) {
            if(failure.getMessage()!=null&&failure.getMessage().contains("damage"))throw failure;
            if(!failure.code.equals("NO_PATH")&&!failure.code.equals("BLOCKED"))throw failure;
            navigation.stop();navigation=null;fail(feet,failure.code+": "+failure.getMessage());return;
        }
        navigation.closeDoorsBehind();navigation.stop();navigation=null;
        if(horizontal(player.position())<legStartDistance-2)failures=0;else fail(player.position(),"leg made no progress");
    }
    private void fail(Vec3 feet,String why) {
        lastFailure=why;
        if(++failures>MAX_FAILURES)throw error("NO_PATH","No way found toward the destination ("+why+")");
    }
    void stop(){if(navigation!=null)navigation.stop();navigation=null;player.stopInput();}
}
