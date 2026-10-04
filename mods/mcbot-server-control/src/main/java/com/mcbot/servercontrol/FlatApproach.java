package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.*;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.*;
import net.minecraft.world.phys.shapes.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Loaded-only native geometry. Flat legacy sweeps retain their full sole; 3D stands support stair treads. */
final class FlatApproach implements BlockGetter {
    static final int MAX_READS=150_000;
    private final ServerPlayer player;
    private final double y;
    private int reads;
    private boolean missing;
    private final Map<BlockPos,BlockState> states=new HashMap<>();
    private final Map<BlockPos,VoxelShape> collisions=new HashMap<>();
    FlatApproach(ServerPlayer player) {this.player=player;this.y=player.getY();}
    int reads(){return reads;}
    static boolean arrivalStand(Vec3 feet,Predicate<Vec3> goal) {
        // Waypoints are accepted within 0.15 blocks. Require the complete 0.2 square
        // to meet the original native reach/LOS predicate before selecting a stand.
        if(!goal.test(feet))return false;
        for(double x:new double[]{-0.2,0.2})for(double z:new double[]{-0.2,0.2})
            if(!goal.test(feet.add(x,0,z)))return false;
        return true;
    }
    Vec3 point(FlatRoute.Cell cell) {return new Vec3(cell.x()+0.5,y,cell.z()+0.5);}
    List<NavigationSearch.Cell> neighbours(NavigationSearch.Cell from) {
        List<NavigationSearch.Cell> result=new ArrayList<>();
        for(int[] d:new int[][]{{1,0},{-1,0},{0,1},{0,-1},{2,0},{-2,0},{0,2},{0,-2}}) {
            int nx=from.x()+d[0],nz=from.z()+d[1];double x=nx*0.5+0.25,z=nz*0.5+0.25;
            Set<Double> heights=new TreeSet<>(Comparator.reverseOrder());missing=false;
            for(int by=(int)Math.floor(from.y()-2.5)-1;by<=(int)Math.floor(from.y()+1.05);by++) {
                BlockPos pos=BlockPos.containing(x,by,z);BlockState state=loaded(pos);
                if(missing)break;
                for(AABB box:collision(pos,state).toAabbs()) {
                    double top=box.maxY+by;
                    if(x>=box.minX+pos.getX()&&x<=box.maxX+pos.getX()&&z>=box.minZ+pos.getZ()&&z<=box.maxZ+pos.getZ()&&top<=from.y()+1.05&&top>=from.y()-2.5)
                        heights.add(top);
                }
            }
            if(missing)continue;
            for(double height:heights) {
                NavigationSearch.Cell next=new NavigationSearch.Cell(nx,height,nz);
                if(transition(from.point(),next.point()))result.add(next);
            }
        }
        return result;
    }
    boolean stand(Vec3 feet) {
        if(!clear(feet,feet))return false;
        missing=false;VoxelShape support=Shapes.empty();
        // A stair tread can be narrower than the player's sole. Require native support under
        // the centre, while the complete standing body must remain collision-free.
        VoxelShape sole=Shapes.create(new AABB(feet.x-0.04,feet.y-0.015,feet.z-0.04,feet.x+0.04,feet.y-0.005,feet.z+0.04));
        for(int x=(int)Math.floor(feet.x)-1;x<=(int)Math.floor(feet.x)+1;x++)
            for(int z=(int)Math.floor(feet.z)-1;z<=(int)Math.floor(feet.z)+1;z++)
                for(int by=(int)Math.floor(feet.y)-1;by<=(int)Math.floor(feet.y);by++) {
                    BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);if(missing)return false;
                    support=Shapes.or(support,collision(pos,state).move(x,by,z));
                    if(missing)return false;
                }
        return !missing&&supported(sole,support);
    }
    private boolean travelSupport(Vec3 point,double low,double high) {
        missing=false;AABB probe=new AABB(point.x-0.04,low-0.015,point.z-0.04,point.x+0.04,high-0.005,point.z+0.04);
        for(int x=(int)Math.floor(point.x)-1;x<=(int)Math.floor(point.x)+1;x++)
            for(int z=(int)Math.floor(point.z)-1;z<=(int)Math.floor(point.z)+1;z++)
                for(int by=(int)Math.floor(low)-1;by<=(int)Math.floor(high);by++){
                    BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);if(missing)return false;
                    if(collides(probe,collision(pos,state).move(x,by,z)))return !missing&&!hazard(state);
                }
        return false;
    }
    boolean groundContact(Vec3 feet){
        missing=false;AABB body=player.getBoundingBox().move(feet.subtract(player.position()));
        AABB sole=new AABB(body.minX+0.0001,feet.y-0.015,body.minZ+0.0001,body.maxX-0.0001,feet.y-0.005,body.maxZ-0.0001);
        for(int x=(int)Math.floor(sole.minX)-1;x<=(int)Math.floor(sole.maxX)+1;x++)
            for(int z=(int)Math.floor(sole.minZ)-1;z<=(int)Math.floor(sole.maxZ)+1;z++)
                for(int by=(int)Math.floor(feet.y)-1;by<=(int)Math.floor(feet.y);by++){
                    BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);if(missing)return false;
                    if(collides(sole,collision(pos,state).move(x,by,z)))return !missing;
                }
        return false;
    }
    GroundNavigation.Step groundStep(Vec3 plannedStart,Vec3 feet,Vec3 next){
        return GroundNavigation.check(plannedStart,feet,next,groundView());
    }
    boolean dropClear(Vec3 feet,Vec3 next){return GroundNavigation.dropClear(feet,next,groundView());}
    private GroundNavigation.View groundView(){
        return new GroundNavigation.View(){
            public boolean clear(Vec3 from,Vec3 to){return FlatApproach.this.clear(from,to);}
            public boolean contact(Vec3 p){return groundContact(p);}
            public boolean stand(Vec3 p){return FlatApproach.this.stand(p);}
            public boolean supportSweep(Vec3 from,Vec3 to,double low,double high){return groundSupport(from,to,low,high);}
        };
    }
    private boolean groundSupport(Vec3 from,Vec3 to,double low,double high){
        missing=false;AABB body=player.getBoundingBox();double halfX=body.getXsize()/2-0.0001,halfZ=body.getZsize()/2-0.0001;
        List<AABB> support=new ArrayList<>();
        for(int x=(int)Math.floor(Math.min(from.x,to.x)-halfX)-1;x<=(int)Math.floor(Math.max(from.x,to.x)+halfX)+1;x++)
            for(int z=(int)Math.floor(Math.min(from.z,to.z)-halfZ)-1;z<=(int)Math.floor(Math.max(from.z,to.z)+halfZ)+1;z++)
                for(int by=(int)Math.floor(low)-1;by<=(int)Math.floor(high);by++){
                    BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);if(missing)return false;
                    for(AABB box:collision(pos,state).toAabbs())support.add(box.move(x,by,z));if(missing)return false;
                }
        return sweptSoleSupport(from,to,low,high,support,halfX,halfZ);
    }
    static boolean sweptSoleSupport(Vec3 from,Vec3 to,double low,double high,List<AABB> obstacles,double halfX,double halfZ){
        // Expanding support by the native sole projects every possible sole-edge contact onto
        // feet-centre space. Exact shape coverage rejects gaps without sparse sample points.
        double minY=low-0.015,maxY=high-0.005;VoxelShape support=Shapes.empty();
        for(AABB box:obstacles)if(box.maxY>minY&&box.minY<maxY)
            support=Shapes.or(support,Shapes.create(new AABB(box.minX-halfX,minY,box.minZ-halfZ,box.maxX+halfX,maxY,box.maxZ+halfZ)));
        VoxelShape required=Shapes.create(new AABB(Math.min(from.x,to.x)-0.00001,minY,Math.min(from.z,to.z)-0.00001,Math.max(from.x,to.x)+0.00001,maxY,Math.max(from.z,to.z)+0.00001));
        return supported(required,support);
    }
    boolean clear(Vec3 from,Vec3 to) {
        missing=false;
        AABB body=player.getBoundingBox().move(from.subtract(player.position())).deflate(0.0001);
        AABB sweep=body.minmax(body.move(to.subtract(from)));
        for(int x=(int)Math.floor(sweep.minX)-1;x<=(int)Math.floor(sweep.maxX)+1;x++)
            for(int z=(int)Math.floor(sweep.minZ)-1;z<=(int)Math.floor(sweep.maxZ)+1;z++)
                for(int by=(int)Math.floor(sweep.minY)-1;by<=(int)Math.floor(sweep.maxY)+1;by++) {
                    BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);if(missing)return false;
                    if(collides(sweep,collision(pos,state).move(x,by,z)))return false;
                    if(hazard(state)&&new AABB(x,by,z,x+1,by+1,z+1).intersects(sweep.inflate(0,0.025,0)))return false;
                    if(missing)return false;
                }
        return !missing&&player.serverLevel().getEntities(player,sweep,e->e.isAlive()&&(e instanceof net.minecraft.world.entity.LivingEntity||e.canBeCollidedWith())).isEmpty();
    }
    boolean transition(Vec3 from,Vec3 to) {
        double rise=to.y-from.y;
        // Planned neighbours remain at most one block; runtime source includes waypoint tolerance.
        if(from.subtract(to).horizontalDistance()>1.25||rise>1.05||rise< -2.5||!stand(from)||!stand(to))return false;
        double travelY=rise>0.6?from.y+1.25:Math.max(from.y,to.y);
        Vec3 highFrom=new Vec3(from.x,travelY,from.z),highTo=new Vec3(to.x,travelY,to.z);
        if(!clear(from,highFrom)||!clear(highFrom,highTo)||!clear(highTo,to))return false;
        if(Math.abs(rise)<0.001) {
            // Same-height walking must not accidentally turn into a gap jump.
            for(double t:new double[]{0.25,0.5,0.75})if(!stand(from.lerp(to,t)))return false;
        } else if(rise>0&&rise<=0.6) {
            for(double t:new double[]{0.25,0.5,0.75})if(!travelSupport(from.lerp(to,t),from.y,to.y))return false;
        }
        return true;
    }
    BlockState loaded(BlockPos pos) {
        BlockState cached=states.get(pos);if(cached!=null)return cached;
        if(++reads>MAX_READS) throw error("PATH_BUDGET","Loaded terrain read budget exhausted");
        if(player.serverLevel().isOutsideBuildHeight(pos)||!player.serverLevel().getWorldBorder().isWithinBounds(pos)) {missing=true;return Blocks.AIR.defaultBlockState();}
        var chunk=player.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        if(chunk==null) {missing=true;return Blocks.AIR.defaultBlockState();}
        BlockState state=chunk.getBlockState(pos);states.put(pos.immutable(),state);return state;
    }
    private VoxelShape collision(BlockPos pos,BlockState state){
        VoxelShape cached=collisions.get(pos);if(cached!=null)return cached;
        VoxelShape shape=state.getCollisionShape(this,pos,CollisionContext.of(player));
        if(!missing)collisions.put(pos.immutable(),shape);return shape;
    }
    BlockState requireLoaded(BlockPos pos) {
        missing=false;BlockState state=loaded(pos);
        if(missing)throw error("UNLOADED","Resource neighbourhood is outside loaded terrain");
        return state;
    }
    boolean safe(Vec3 from,Vec3 to) {
        if(Math.abs(from.y-y)>0.05||Math.abs(to.y-y)>0.05) return false;
        missing=false;
        AABB body=player.getBoundingBox().move(from.subtract(player.position())).deflate(0.0001);
        AABB end=body.move(to.subtract(from));
        AABB sweep=body.minmax(end);
        // Scan one extra neighbour layer because collision shapes may extend outside their cell.
        int minX=(int)Math.floor(sweep.minX)-1,maxX=(int)Math.floor(sweep.maxX)+1;
        int minY=(int)Math.floor(sweep.minY)-1,maxY=(int)Math.floor(sweep.maxY)+1;
        int minZ=(int)Math.floor(sweep.minZ)-1,maxZ=(int)Math.floor(sweep.maxZ)+1;
        VoxelShape sole=Shapes.create(new AABB(sweep.minX,y-0.025,sweep.minZ,sweep.maxX,y-0.001,sweep.maxZ));
        VoxelShape support=Shapes.empty();
        for(int x=minX;x<=maxX;x++) for(int z=minZ;z<=maxZ;z++) for(int by=minY;by<=maxY;by++) {
            BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);
            if(missing) return false;
            VoxelShape shape=collision(pos,state).move(x,by,z);
            if(collides(sweep,shape)) return false;
            support=Shapes.or(support,shape);
            AABB dangerBox=new AABB(x,by,z,x+1,by+1,z+1);
            if(dangerBox.intersects(sweep)||dangerBox.intersects(new AABB(sweep.minX,y-0.03,sweep.minZ,sweep.maxX,y,sweep.maxZ)))
                if(hazard(state)) return false;
            if(missing) return false;
        }
        if(missing||!supported(sole,support)) return false;
        // Real entity bounds (including players) must not be crossed by the swept body.
        return player.serverLevel().getEntities(player,sweep,e->e.isAlive()&&(e instanceof net.minecraft.world.entity.LivingEntity||e.canBeCollidedWith())).isEmpty();
    }
    static boolean collides(AABB swept,VoxelShape obstacle) {return Shapes.joinIsNotEmpty(Shapes.create(swept),obstacle,BooleanOp.AND);}
    static boolean supported(VoxelShape sole,VoxelShape support) {return !Shapes.joinIsNotEmpty(sole,support,BooleanOp.ONLY_FIRST);}
    boolean containerReach(Vec3 feet,BlockPos pos) {
        missing=false;Vec3 eye=feet.add(0,player.getEyeHeight(),0);
        BlockHitResult hit=clip(new ClipContext(eye,Vec3.atCenterOf(pos),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return !missing&&hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(pos)&&eye.distanceTo(hit.getLocation())<=player.blockInteractionRange();
    }
    boolean blockVisible(BlockPos pos) {
        missing=false;
        BlockHitResult hit=clip(new ClipContext(player.getEyePosition(),Vec3.atCenterOf(pos),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return !missing&&hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(pos);
    }
    String itemVisibility(Vec3 destination) {
        missing=false;
        BlockHitResult hit=clip(new ClipContext(player.getEyePosition(),destination,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return missing?"unknown":hit.getType()==HitResult.Type.MISS?"visible":"occluded";
    }
    boolean itemReach(Vec3 feet,AABB item) {
        AABB body=player.getBoundingBox().move(feet.subtract(player.position())).inflate(1,0.5,1);
        return body.intersects(item);
    }
    boolean playerReach(Vec3 feet,ServerPlayer target,double distance) {
        if(feet.distanceTo(target.position())>distance) return false;
        missing=false;
        BlockHitResult hit=clip(new ClipContext(feet.add(0,player.getEyeHeight(),0),target.getEyePosition(),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return !missing&&hit.getType()==HitResult.Type.MISS;
    }
    static boolean hazard(BlockState state) {
        return !state.getFluidState().isEmpty()||state.is(Blocks.MAGMA_BLOCK)||state.is(Blocks.CACTUS)||state.is(Blocks.FIRE)||state.is(Blocks.SOUL_FIRE)||state.is(Blocks.SWEET_BERRY_BUSH)||state.is(Blocks.POWDER_SNOW)||state.is(Blocks.WITHER_ROSE)||state.is(Blocks.CAMPFIRE)||state.is(Blocks.SOUL_CAMPFIRE);
    }
    @Override public BlockState getBlockState(BlockPos pos) {return loaded(pos);}
    @Override public FluidState getFluidState(BlockPos pos) {return loaded(pos).getFluidState();}
    @Override public BlockEntity getBlockEntity(BlockPos pos) {missing=true;return null;}
    @Override public int getHeight() {return player.serverLevel().getHeight();}
    @Override public int getMinBuildHeight() {return player.serverLevel().getMinBuildHeight();}
}
