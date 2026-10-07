package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.Predicate;

/**
 * Which inventory stacks fill which recipe cells, without game classes so it is tested offline. A cell holds one
 * stack, so each cell takes one kind of item (gathered from several slots if needed) and needs at least
 * {@code crafts} of it in one stack's room. Cells are filled in order; each takes the matching kind with the most
 * left, its fullest slots first.
 */
final class MaterialAllocator {
    private MaterialAllocator() {}
    /** A usable inventory slot: {@code kind} groups stacks that may share a cell (same item, no components). */
    record Source<T>(int slot,T stack,Object kind,int count,int maxStack) {}

    /** Per cell: inventory slot → count taken (empty map for an empty cell); null when the cells cannot all be filled. */
    static <T> List<Map<Integer,Integer>> allocate(List<Predicate<T>> cells,List<Source<T>> sources,int crafts) {
        if(crafts<1)return null;
        Map<Integer,Integer> left=new HashMap<>();for(Source<T> s:sources)left.put(s.slot(),s.count());
        List<Map<Integer,Integer>> layout=new ArrayList<>();
        for(Predicate<T> cell:cells) {
            if(cell==null){layout.add(Map.of());continue;}
            Map<Object,Integer> kinds=new LinkedHashMap<>();
            for(Source<T> s:sources)if(left.get(s.slot())>0&&s.maxStack()>=crafts&&cell.test(s.stack()))kinds.merge(s.kind(),left.get(s.slot()),Integer::sum);
            Object best=null;int most=0;
            for(var e:kinds.entrySet())if(e.getValue()>=crafts&&e.getValue()>most){best=e.getKey();most=e.getValue();}
            if(best==null)return null;
            List<Source<T>> slots=new ArrayList<>();for(Source<T> s:sources)if(left.get(s.slot())>0&&s.kind().equals(best))slots.add(s);
            slots.sort(Comparator.comparingInt((Source<T> s)->-left.get(s.slot())).thenComparingInt(Source::slot));
            Map<Integer,Integer> take=new LinkedHashMap<>();int need=crafts;
            for(Source<T> s:slots){if(need==0)break;int n=Math.min(need,left.get(s.slot()));take.put(s.slot(),n);left.merge(s.slot(),-n,Integer::sum);need-=n;}
            layout.add(take);
        }
        return layout;
    }

    /** The largest number of crafts (≤ wanted, ≤ 64) that can be laid out in one round; 0 when none. */
    static <T> int feasible(List<Predicate<T>> cells,List<Source<T>> sources,int wanted) {
        for(int k=Math.min(wanted,64);k>0;k--)if(allocate(cells,sources,k)!=null)return k;
        return 0;
    }
}
