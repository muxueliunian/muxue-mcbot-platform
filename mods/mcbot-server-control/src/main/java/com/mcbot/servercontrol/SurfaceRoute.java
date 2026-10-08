package com.mcbot.servercontrol;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.PriorityQueue;

/**
 * The rough way for a long walk (travel-to), planned over the ground of every loaded column within RADIUS of the
 * body: one cell per column, its feet height and whether it is land or water. Land to land is a step when the two
 * heights differ by at most one block (a body jumps up one; a long walk also steps down only one, so it can always
 * come back). Water is swum, at SWIM times the cost: in from a bank at most MAX_ENTER above the water, out only
 * onto a bank level with or below the surface (vanilla lifts a swimmer over a lip, not over a whole block). Tree
 * trunks, lava, cactus, magma, campfires and columns without headroom are not crossed; unloaded columns neither.
 * A* finds the way to the destination, or, when it is out of reach or outside the grid, to the reachable cell
 * closest to it. TravelTask walks that way leg by leg with the ordinary navigation, which settles the details.
 */
final class SurfaceRoute {
    static final int RADIUS=96,MAX_ENTER=3;
    static final double SWIM=3;
    static final byte BLOCKED=0,LAND=1,WATER=2;
    record Cell(int x,int z,int y,byte kind){}

    final int originX,originZ,size;
    final int[] height;
    final byte[] kind;
    SurfaceRoute(int originX,int originZ,int size){
        this.originX=originX;this.originZ=originZ;this.size=size;
        height=new int[size*size];kind=new byte[size*size];
    }
    int index(int x,int z){
        int i=x-originX,j=z-originZ;
        return i<0||j<0||i>=size||j>=size?-1:j*size+i;
    }
    void set(int x,int z,int y,byte type){int i=index(x,z);height[i]=y;kind[i]=type;}

    /** Ground of the loaded columns around a centre. */
    static SurfaceRoute sample(ServerLevel level,int centreX,int centreZ){
        SurfaceRoute grid=new SurfaceRoute(centreX-RADIUS,centreZ-RADIUS,2*RADIUS+1);
        BlockPos.MutableBlockPos pos=new BlockPos.MutableBlockPos();
        for(int z=grid.originZ;z<grid.originZ+grid.size;z++)for(int x=grid.originX;x<grid.originX+grid.size;x++){
            if(level.getChunkSource().getChunkNow(x>>4,z>>4)==null)continue; // BLOCKED
            int top=level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,x,z);
            BlockState ground=level.getBlockState(pos.set(x,top-1,z));
            byte type;
            if(!ground.getFluidState().isEmpty())type=ground.getFluidState().is(FluidTags.WATER)?WATER:BLOCKED;
            else if(ground.is(BlockTags.LOGS)||ground.is(Blocks.CACTUS)||ground.is(Blocks.MAGMA_BLOCK)||ground.is(BlockTags.CAMPFIRES))type=BLOCKED;
            else type=LAND;
            // Headroom: leaves (left out of this heightmap) or anything else solid where the body would stand.
            if(type!=BLOCKED&&(level.getBlockState(pos.set(x,top,z)).blocksMotion()||level.getBlockState(pos.set(x,top+1,z)).blocksMotion()))type=BLOCKED;
            grid.set(x,z,top,type);
        }
        return grid;
    }

    /** Cost of one step between neighbouring cells, or a negative number when it cannot be taken. */
    double step(int from,int to,double length){
        byte a=kind[from],b=kind[to];
        if(a==BLOCKED||b==BLOCKED)return -1;
        int rise=height[to]-height[from];
        if(a==LAND&&b==LAND)return Math.abs(rise)<=1?length*(1+0.5*Math.abs(rise)):-1;
        if(a==LAND)return -rise<=MAX_ENTER&&rise<=1?length*SWIM:-1; // into the water
        if(b==LAND)return rise<=0?length*SWIM:-1;                    // out onto a low bank
        return length*SWIM;
    }

    /**
     * The cells from the start to the destination, or to the reachable cell closest to it; empty when the start is
     * not on the grid or nothing reachable is closer to the destination than the start itself.
     */
    List<Cell> plan(int startX,int startZ,double targetX,double targetZ){
        int start=index(startX,startZ);
        if(start<0||kind[start]==BLOCKED)return List.of();
        int n=size*size;
        double[] cost=new double[n];Arrays.fill(cost,Double.POSITIVE_INFINITY);
        int[] previous=new int[n];
        boolean[] closed=new boolean[n];
        double[] estimate=new double[n];
        PriorityQueue<Integer> open=new PriorityQueue<>((p,q)->Double.compare(estimate[p],estimate[q]));
        cost[start]=0;estimate[start]=distance(start,targetX,targetZ);previous[start]=-1;open.add(start);
        int best=start;double bestLeft=distance(start,targetX,targetZ);
        int goal=index((int)Math.floor(targetX),(int)Math.floor(targetZ));
        while(!open.isEmpty()){
            int current=open.poll();
            if(closed[current])continue;
            closed[current]=true;
            double left=distance(current,targetX,targetZ);
            if(left<bestLeft){bestLeft=left;best=current;}
            if(current==goal)break;
            int cx=current%size,cz=current/size;
            for(int dz=-1;dz<=1;dz++)for(int dx=-1;dx<=1;dx++){
                if(dx==0&&dz==0)continue;
                int nx=cx+dx,nz=cz+dz;
                if(nx<0||nz<0||nx>=size||nz>=size)continue;
                int next=nz*size+nx;
                if(closed[next])continue;
                double stepCost;
                if(dx!=0&&dz!=0){
                    // No cutting a corner: both side cells must be steps of their own.
                    if(step(current,cz*size+nx,1)<0||step(current,nz*size+cx,1)<0)continue;
                    stepCost=step(current,next,Math.sqrt(2));
                } else stepCost=step(current,next,1);
                if(stepCost<0)continue;
                double total=cost[current]+stepCost;
                if(total<cost[next]){cost[next]=total;previous[next]=current;estimate[next]=total+distance(next,targetX,targetZ);open.add(next);}
            }
        }
        if(best==start)return List.of();
        List<Cell> way=new ArrayList<>();
        for(int cell=best;cell!=-1;cell=previous[cell])way.add(new Cell(originX+cell%size,originZ+cell/size,height[cell],kind[cell]));
        return way.reversed();
    }
    private double distance(int cell,double targetX,double targetZ){
        return Math.hypot(originX+cell%size+0.5-targetX,originZ+cell/size+0.5-targetZ);
    }
}
