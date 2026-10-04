package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.LongSupplier;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** Incremental bounded A*; all terrain reads are supplied by the calling server tick. */
final class NavigationSearch {
    static final int MAX_NODES=4096,MAX_EDGES=32768,MAX_PATH=192,PER_TICK=64;
    static final long SLICE_NANOS=2_000_000;
    record Cell(int x,double y,int z) {
        Vec3 point(){return new Vec3(x*0.5+0.25,y,z*0.5+0.25);}
        static Cell at(Vec3 point){return new Cell((int)Math.floor(point.x*2),point.y,(int)Math.floor(point.z*2));}
    }
    interface View {List<Cell> neighbours(Cell from);boolean goal(Cell at);double estimate(Cell at);}
    private record Entry(Cell cell,double cost,double score,long order) {}
    private final Cell origin;
    private final View view;
    private final LongSupplier nano;
    private final PriorityQueue<Entry> open=new PriorityQueue<>(Comparator.comparingDouble(Entry::score).thenComparingLong(Entry::order));
    private final Map<Cell,Double> cost=new HashMap<>();
    private final Map<Cell,Cell> previous=new HashMap<>();
    private int edges,expanded;
    private long order;
    private List<Cell> result;
    NavigationSearch(Cell origin,View view){this(origin,view,System::nanoTime);}
    NavigationSearch(Cell origin,View view,LongSupplier nano){
        this.origin=origin;this.view=view;this.nano=nano;
        cost.put(origin,0d);previous.put(origin,null);open.add(new Entry(origin,0,view.estimate(origin),order++));
    }
    boolean advance(){
        long start=nano.getAsLong();int slice=0;
        while(!open.isEmpty()&&slice<PER_TICK&&(slice==0||nano.getAsLong()-start<SLICE_NANOS)){
            Entry next=open.remove();if(next.cost()!=cost.get(next.cell()))continue;
            Cell current=next.cell();slice++;expanded++;
            if(view.goal(current)){
                List<Cell> path=new ArrayList<>();for(Cell at=current;at!=null;at=previous.get(at))path.add(at);
                Collections.reverse(path);if(path.size()>MAX_PATH)throw error("PATH_BUDGET","Navigation path length exhausted");
                result=List.copyOf(path);return true;
            }
            for(Cell to:view.neighbours(current)){
                if(++edges>MAX_EDGES)throw error("PATH_BUDGET","Navigation edge budget exhausted");
                Vec3 offset=to.point().subtract(origin.point());
                if(offset.horizontalDistance()>32||Math.abs(offset.y)>8)continue;
                double candidate=next.cost()+current.point().distanceTo(to.point())+Math.max(0,to.y()-current.y())*0.25;
                if(candidate>=cost.getOrDefault(to,Double.POSITIVE_INFINITY))continue;
                if(!cost.containsKey(to)&&cost.size()>=MAX_NODES)throw error("PATH_BUDGET","Navigation node budget exhausted");
                cost.put(to,candidate);previous.put(to,current);
                open.add(new Entry(to,candidate,candidate+view.estimate(to),order++));
            }
        }
        if(open.isEmpty())throw error("NO_PATH","No loaded safe route within navigation bounds");
        return false;
    }
    List<Cell> result(){return result;}
    int expanded(){return expanded;}
}
