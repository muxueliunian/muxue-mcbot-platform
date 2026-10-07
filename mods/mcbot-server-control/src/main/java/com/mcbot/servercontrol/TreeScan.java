package com.mcbot.servercontrol;

import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Which logs make up one tree. Logs touching one another (also diagonally: a slanted acacia trunk, a 2x2 trunk)
 * form a piece. A piece with a log standing on the ground (soil, stone, mangrove roots: not a log, leaves or air)
 * is a trunk; a piece up in the air (a branch past a gap in the leaves, a cherry or acacia limb, a jungle branch)
 * belongs to the trunk it is nearest to within BRANCH_REACH blocks, so two trees standing side by side stay two
 * trees even where their crowns touch. A piece that reaches no trunk is left out (it is no tree).
 */
final class TreeScan {
    static final int BRANCH_REACH=4,SPREAD=10,BELOW=4,ABOVE=40,MAX_LOGS=256;
    record Tree(List<BlockPos> logs,boolean truncated) {}

    /** Tree ids (0, 1, ...) for logs already found, grouped by the rule above; logs that reach no trunk get their own id. */
    static Map<BlockPos,Integer> group(ServerLevel level,Collection<BlockPos> logs) {
        List<Set<BlockPos>> pieces=pieces(new HashSet<>(logs));
        int[] owner=attach(level,pieces);
        Map<Integer,Integer> ids=new HashMap<>();Map<BlockPos,Integer> result=new HashMap<>();
        for(int i=0;i<pieces.size();i++){int root=owner[i]<0?i:owner[i];int id=ids.computeIfAbsent(root,k->ids.size());for(BlockPos p:pieces.get(i))result.put(p,id);}
        return result;
    }

    /**
     * The whole tree nearest a point: the requested log closest to it (within radius, BELOW below to 8 above), then
     * every requested log around it (SPREAD across, ABOVE up), grouped as above. Loaded chunks only.
     */
    static Tree nearest(ServerLevel level,Vec3 center,int radius,ResourceCatalog.Selection selection) {
        BlockPos origin=BlockPos.containing(center);BlockPos seed=null;double best=Double.MAX_VALUE;
        for(int x=-radius;x<=radius;x++)for(int z=-radius;z<=radius;z++)for(int y=-BELOW;y<=8;y++){
            if(x*x+z*z>radius*radius)continue;
            BlockPos pos=origin.offset(x,y,z);BlockState state=loaded(level,pos);
            if(state==null||!log(state,selection))continue;
            double d=Vec3.atCenterOf(pos).distanceTo(center);if(d<best){best=d;seed=pos.immutable();}
        }
        if(seed==null)return new Tree(List.of(),false);
        Set<BlockPos> logs=new HashSet<>();
        for(int x=-SPREAD;x<=SPREAD;x++)for(int z=-SPREAD;z<=SPREAD;z++)for(int y=-BELOW;y<=ABOVE;y++){
            BlockPos pos=seed.offset(x,y,z);BlockState state=loaded(level,pos);
            if(state!=null&&log(state,selection))logs.add(pos.immutable());
        }
        List<Set<BlockPos>> pieces=pieces(logs);int[] owner=attach(level,pieces);
        int seedPiece=-1;for(int i=0;i<pieces.size();i++)if(pieces.get(i).contains(seed))seedPiece=i;
        int root=owner[seedPiece]<0?seedPiece:owner[seedPiece];
        List<BlockPos> tree=new ArrayList<>();
        for(int i=0;i<pieces.size();i++)if(i==root||owner[i]==root)tree.addAll(pieces.get(i));
        BlockPos base=seed;
        tree.sort(Comparator.comparingInt((BlockPos p)->p.getY()).thenComparingDouble(p->p.distSqr(base)));
        return new Tree(tree.size()>MAX_LOGS?List.copyOf(tree.subList(0,MAX_LOGS)):tree,tree.size()>MAX_LOGS);
    }

    private static boolean log(BlockState state,ResourceCatalog.Selection selection){return ResourceCatalog.kind(state)==ResourceCatalog.Kind.LOG&&selection.matches(state);}
    private static BlockState loaded(ServerLevel level,BlockPos pos) {
        if(level.isOutsideBuildHeight(pos)||!level.getWorldBorder().isWithinBounds(pos))return null;
        var chunk=level.getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        return chunk==null?null:chunk.getBlockState(pos);
    }
    /** Logs connected through the 26-neighbourhood. */
    private static List<Set<BlockPos>> pieces(Set<BlockPos> logs) {
        List<Set<BlockPos>> pieces=new ArrayList<>();Set<BlockPos> seen=new HashSet<>();
        List<BlockPos> order=new ArrayList<>(logs);order.sort(Comparator.comparingInt((BlockPos p)->p.getY()).thenComparingInt(p->p.getX()).thenComparingInt(p->p.getZ()));
        for(BlockPos start:order){
            if(!seen.add(start))continue;
            Set<BlockPos> piece=new HashSet<>();Deque<BlockPos> queue=new ArrayDeque<>(List.of(start));
            while(!queue.isEmpty()){BlockPos at=queue.poll();piece.add(at);
                for(int dx=-1;dx<=1;dx++)for(int dy=-1;dy<=1;dy++)for(int dz=-1;dz<=1;dz++){BlockPos next=at.offset(dx,dy,dz);if(logs.contains(next)&&seen.add(next))queue.add(next);}}
            pieces.add(piece);
        }
        return pieces;
    }
    /** owner[i]: the trunk piece a branch piece belongs to; -1 for a trunk itself, or for a piece that reaches no trunk. */
    private static int[] attach(ServerLevel level,List<Set<BlockPos>> pieces) {
        int n=pieces.size();int[] owner=new int[n];Arrays.fill(owner,-1);boolean[] trunk=new boolean[n],tree=new boolean[n];
        for(int i=0;i<n;i++){trunk[i]=grounded(level,pieces.get(i));tree[i]=trunk[i];}
        // Nearest first, a branch may also hang on a branch already placed (a limb off a limb).
        for(boolean grew=true;grew;){
            grew=false;int bestPiece=-1,bestTo=-1,bestGap=Integer.MAX_VALUE;
            for(int i=0;i<n;i++){if(tree[i])continue;
                for(int j=0;j<n;j++){if(!tree[j])continue;int gap=gap(pieces.get(i),pieces.get(j));if(gap<bestGap){bestGap=gap;bestPiece=i;bestTo=j;}}}
            if(bestPiece>=0&&bestGap<=BRANCH_REACH){owner[bestPiece]=trunk[bestTo]?bestTo:owner[bestTo];tree[bestPiece]=true;grew=true;}
        }
        return owner;
    }
    private static int gap(Set<BlockPos> a,Set<BlockPos> b) {
        int best=Integer.MAX_VALUE;
        for(BlockPos p:a)for(BlockPos q:b)best=Math.min(best,Math.max(Math.abs(p.getX()-q.getX()),Math.max(Math.abs(p.getY()-q.getY()),Math.abs(p.getZ()-q.getZ()))));
        return best;
    }
    private static boolean grounded(ServerLevel level,Set<BlockPos> piece) {
        for(BlockPos p:piece){
            BlockPos below=p.below();if(piece.contains(below))continue;
            BlockState state=loaded(level,below);
            if(state==null||state.isAir()||state.is(BlockTags.LOGS)||state.is(BlockTags.LEAVES))continue;
            if(state.is(Blocks.MANGROVE_ROOTS)||state.is(Blocks.MUDDY_MANGROVE_ROOTS)||state.isCollisionShapeFullBlock(level,below))return true;
        }
        return false;
    }
}
