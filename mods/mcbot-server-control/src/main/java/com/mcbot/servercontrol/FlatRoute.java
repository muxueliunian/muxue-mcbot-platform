package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Bounded four-neighbour search. No terrain mutation and no vertical steps. */
final class FlatRoute {
    static final int MAX_NODES=2048,MAX_EDGES=8192,MAX_PATH=96,RADIUS=32;
    record Cell(int x,int z) {}
    interface View {boolean edge(Cell from,Cell to);boolean goal(Cell cell);}
    static List<Cell> plan(Cell origin,View view) {
        ArrayDeque<Cell> queue=new ArrayDeque<>();Map<Cell,Cell> previous=new LinkedHashMap<>();
        queue.add(origin);previous.put(origin,null);int edges=0;
        while(!queue.isEmpty()) {
            Cell current=queue.removeFirst();
            if(view.goal(current)) {
                List<Cell> result=new ArrayList<>();
                for(Cell at=current;at!=null;at=previous.get(at)) result.add(at);
                Collections.reverse(result);
                if(result.size()>MAX_PATH) throw error("PATH_BUDGET","Flat route exceeds maximum path length");
                return result;
            }
            for(int[] delta:new int[][]{{1,0},{-1,0},{0,1},{0,-1}}) {
                Cell next=new Cell(current.x()+delta[0],current.z()+delta[1]);
                if(previous.containsKey(next)||Math.abs(next.x()-origin.x())>RADIUS||Math.abs(next.z()-origin.z())>RADIUS||
                    (long)(next.x()-origin.x())*(next.x()-origin.x())+(long)(next.z()-origin.z())*(next.z()-origin.z())>RADIUS*RADIUS) continue;
                if(++edges>MAX_EDGES) throw error("PATH_BUDGET","Flat route edge budget exhausted");
                if(!view.edge(current,next)) continue;
                if(previous.size()>=MAX_NODES) throw error("PATH_BUDGET","Flat route node budget exhausted");
                previous.put(next,current);queue.addLast(next);
            }
        }
        throw error("NO_PATH","No loaded safe flat route within the search bounds");
    }
}
