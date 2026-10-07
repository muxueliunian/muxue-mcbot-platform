package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.Predicate;

/**
 * Which inventory stacks fill which recipe cells, without game classes so it is tested offline. A cell holds one
 * stack, so each cell takes one kind of item (gathered from several slots if needed) and needs at least
 * {@code crafts} of it in one stack's room. The choice is global: the most constrained cells pick first and a
 * choice is undone when a later cell is left without enough (one cell takes any planks, another only oak: the
 * oak goes to the second). Among equal choices the kind with the most left wins, then the fullest slots.
 */
final class MaterialAllocator {
    private MaterialAllocator() {}
    /** A usable inventory slot: {@code kind} groups stacks that may share a cell (same item, same components). */
    record Source<T>(int slot,T stack,Object kind,int count,int maxStack) {}
    private static final int BUDGET=20_000;

    /** Per cell: inventory slot → count taken (empty map for an empty cell); null when the cells cannot all be filled. */
    static <T> List<Map<Integer,Integer>> allocate(List<Predicate<T>> cells,List<Source<T>> sources,int crafts) {
        if(crafts<1)return null;
        Map<Object,Integer> total=new LinkedHashMap<>();
        for(Source<T> s:sources)if(s.maxStack()>=crafts&&s.count()>0)total.merge(s.kind(),s.count(),Integer::sum);
        List<List<Object>> options=new ArrayList<>();
        for(Predicate<T> cell:cells) {
            if(cell==null){options.add(null);continue;}
            List<Object> kinds=new ArrayList<>();
            for(Source<T> s:sources)if(s.maxStack()>=crafts&&s.count()>0&&!kinds.contains(s.kind())&&cell.test(s.stack()))kinds.add(s.kind());
            if(kinds.isEmpty())return null;
            options.add(kinds);
        }
        List<Integer> order=new ArrayList<>();
        for(int i=0;i<cells.size();i++)if(options.get(i)!=null)order.add(i);
        order.sort(Comparator.comparingInt(i->options.get(i).size()));
        Object[] chosen=new Object[cells.size()];
        if(!choose(order,0,options,new LinkedHashMap<>(total),crafts,chosen,new int[]{BUDGET}))return null;
        // Take from the chosen kind's fullest slots, cells in their own order.
        Map<Integer,Integer> left=new HashMap<>();for(Source<T> s:sources)left.put(s.slot(),s.count());
        List<Map<Integer,Integer>> layout=new ArrayList<>();
        for(int cell=0;cell<cells.size();cell++) {
            if(chosen[cell]==null){layout.add(Map.of());continue;}
            Object kind=chosen[cell];
            List<Source<T>> slots=new ArrayList<>();for(Source<T> s:sources)if(left.get(s.slot())>0&&s.maxStack()>=crafts&&s.kind().equals(kind))slots.add(s);
            slots.sort(Comparator.comparingInt((Source<T> s)->-left.get(s.slot())).thenComparingInt(Source::slot));
            Map<Integer,Integer> take=new LinkedHashMap<>();int need=crafts;
            for(Source<T> s:slots){if(need==0)break;int n=Math.min(need,left.get(s.slot()));take.put(s.slot(),n);left.merge(s.slot(),-n,Integer::sum);need-=n;}
            if(need>0)return null;
            layout.add(take);
        }
        return layout;
    }
    private static boolean choose(List<Integer> order,int index,List<List<Object>> options,Map<Object,Integer> left,int crafts,Object[] chosen,int[] budget) {
        if(index==order.size())return true;
        if(--budget[0]<0)return false;
        int cell=order.get(index);
        List<Object> kinds=new ArrayList<>(options.get(cell));
        kinds.sort(Comparator.comparingInt(k->-left.getOrDefault(k,0)));
        for(Object kind:kinds) {
            if(left.getOrDefault(kind,0)<crafts)continue;
            left.merge(kind,-crafts,Integer::sum);chosen[cell]=kind;
            if(choose(order,index+1,options,left,crafts,chosen,budget))return true;
            left.merge(kind,crafts,Integer::sum);chosen[cell]=null;
        }
        return false;
    }

    /** The largest number of crafts (≤ wanted, ≤ 64) that can be laid out in one round; 0 when none. */
    static <T> int feasible(List<Predicate<T>> cells,List<Source<T>> sources,int wanted) {
        for(int k=Math.min(wanted,64);k>0;k--)if(allocate(cells,sources,k)!=null)return k;
        return 0;
    }
}
