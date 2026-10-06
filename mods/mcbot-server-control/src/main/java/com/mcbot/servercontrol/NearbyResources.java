package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.tags.BlockTags;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

final class NearbyResources {
    // Up to sixteen blocks around, two below and four above the centre: tree trunks and hillsides a walk away,
    // still never below the body's feet (ResourceCatalog.requireSafe). Matches are checked nearest first.
    static final int MAX_RADIUS=16,BELOW=2,ABOVE=4,MAX_VISITED=33*33*(BELOW+ABOVE+1);
    // Whole trees: logs connected to a log in the scan band are followed up to TREE_ABOVE above the centre
    // (at most TREE_LIMIT more), so gathering can climb a trunk for the rest. Leaves are never candidates.
    static final int TREE_ABOVE=24,TREE_LIMIT=64,TREE_SPREAD=4;
    record Options(Set<String> blockIds,int radius,int maxResults,Vec3 center) {}
    static Options options(JsonObject args,Vec3 body) {
        var mining=args.has("companionMiningGuard")?CompanionMiningGuard.options(object(args,"companionMiningGuard")):null;
        if(mining!=null&&args.has("center"))throw error("INVALID_ARGUMENT","Companion mining scan center is always the live bound player position");
        if(!args.has("blockIds")||!args.get("blockIds").isJsonArray()||args.getAsJsonArray("blockIds").isEmpty()||args.getAsJsonArray("blockIds").size()>8)
            throw error("INVALID_ARGUMENT","blockIds requires one to eight explicit catalog IDs");
        Set<String> ids=new LinkedHashSet<>();
        for(JsonElement entry:args.getAsJsonArray("blockIds")) {
            if(!entry.isJsonPrimitive()||!entry.getAsJsonPrimitive().isString()||!ResourceCatalog.allowed(entry.getAsString())) throw error("UNSUPPORTED","Resource ID is not in the finite stone/log/coal/iron/copper catalog");
            ids.add(entry.getAsString());
        }
        if(mining!=null&&ids.stream().anyMatch(id->!ResourceCatalog.ore(id)))throw error("UNSUPPORTED","Companion mining scans only the six ordinary ore catalog blocks");
        int radius=integer(args,"radius",mining==null?4:mining.maxDistance(),1,mining==null?MAX_RADIUS:mining.maxDistance()),limit=integer(args,"maxResults",32,1,64);
        Vec3 center=body;
        if(args.has("center")) {JsonObject p=object(args,"center");center=new Vec3(number(p,"x"),number(p,"y"),number(p,"z"));}
        if(center.distanceTo(body)>8) throw error("INVALID_ARGUMENT","Resource scan center must remain within eight blocks of the body");
        return new Options(Set.copyOf(ids),radius,limit,center);
    }
    private static int integer(JsonObject args,String key,int fallback,int min,int max) {double value=bounded(args,key,fallback,min,max);if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");return (int)value;}
    private record Candidate(BlockPos position,BlockState state,double distance) {}
    static JsonObject discover(ServerPlayer body,JsonObject args,ResourceTargets targets) {
        Options options=options(args,body.position());
        CompanionMiningGuard mining=args.has("companionMiningGuard")?CompanionMiningGuard.create(body,object(args,"companionMiningGuard")):null;
        if(mining!=null){mining.validateBody();options=new Options(options.blockIds(),options.radius(),options.maxResults(),mining.center());}
        BlockPos origin=BlockPos.containing(options.center());
        List<Candidate> matches=new ArrayList<>(),found=new ArrayList<>();int visited=0,unloaded=0,rejected=0;boolean exhausted=false;
        FlatApproach geometry=new FlatApproach(body);
        for(int x=-options.radius();x<=options.radius();x++) for(int z=-options.radius();z<=options.radius();z++) {
            if(x*x+z*z>options.radius()*options.radius())continue;
            for(int y=-BELOW;y<=ABOVE;y++) {
                visited++;BlockPos pos=origin.offset(x,y,z);
                if(body.serverLevel().isOutsideBuildHeight(pos)||!body.serverLevel().getWorldBorder().isWithinBounds(pos))continue;
                var chunk=body.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
                if(chunk==null){unloaded++;continue;}
                BlockState state=chunk.getBlockState(pos);
                if(!options.blockIds().contains(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString()))continue;
                matches.add(new Candidate(pos,state,Vec3.atCenterOf(pos).distanceTo(options.center())));
            }
        }
        matches.sort(Comparator.comparingDouble(Candidate::distance).thenComparingInt(c->c.position().getX()).thenComparingInt(c->c.position().getY()).thenComparingInt(c->c.position().getZ()));
        Set<BlockPos> tree=mining==null?treeAbove(body,origin,options,matches):Set.of();
        // Safety and line-of-sight checks cost terrain reads: run them nearest first, one past the limit to report truncation.
        for(Candidate match:matches) {
            if(found.size()>options.maxResults())break;
            // Logs high in a tree are usually hidden behind the trunk or leaves from the ground: dig time checks the real line of sight.
            try {if(mining!=null)mining.validateTarget(match.position());ResourceCatalog.requireSafe(body,match.position(),geometry);if(!tree.contains(match.position())&&!geometry.blockVisible(match.position())){rejected++;continue;}}
            catch(Protocol.Error unsafe){if(unsafe.code.equals("PATH_BUDGET")){exhausted=true;break;}rejected++;continue;}
            found.add(match);
        }
        JsonArray candidates=new JsonArray();
        var inventory=ToolAssessment.inventory(body);
        for(Candidate candidate:found.subList(0,Math.min(found.size(),options.maxResults()))) {
            JsonObject properties=new JsonObject();candidate.state().getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
            var tools=ToolAssessment.evaluateSummary(inventory,candidate.state(),candidate.state().getDestroySpeed(body.serverLevel(),candidate.position()));
            var policy=ResourceCatalog.discoveryPolicy(BuiltInRegistries.BLOCK.getKey(candidate.state().getBlock()).toString());
            JsonArray suitable=new JsonArray();for(var tool:tools)if(tool.slot()<9&&ToolAssessment.recommendationReason(tool,policy)==null)suitable.add(tool.slot());
            var recommended=ToolAssessment.recommend(tools,body.getInventory().selected,policy,true);
            var inventoryRecommended=ToolAssessment.recommend(tools,body.getInventory().selected,policy,false);
            JsonObject value=obj("position",position(Vec3.atLowerCornerOf(candidate.position())),"id",BuiltInRegistries.BLOCK.getKey(candidate.state().getBlock()).toString(),"properties",properties,
                "targetToken",targets.issue(body,candidate.position(),candidate.state(),mining),"distance",candidate.distance(),"visible",!tree.contains(candidate.position()),"requiresCorrectTool",candidate.state().requiresCorrectToolForDrops(),"suitableToolSlots",suitable);
            if(recommended!=null)value.addProperty("recommendedToolSlot",recommended.slot());
            if(inventoryRecommended!=null)value.addProperty("recommendedInventorySlot",inventoryRecommended.slot());
            candidates.add(value);
        }
        return obj("dimension",body.serverLevel().dimension().location().toString(),"center",position(options.center()),"candidates",candidates,
            "truncated",found.size()>options.maxResults()||exhausted,"budget",obj("radius",options.radius(),"below",BELOW,"above",ABOVE,"treeAbove",TREE_ABOVE,"treeLogs",tree.size(),"matches",matches.size(),"visited",visited,"maxVisited",MAX_VISITED,"unloaded",unloaded,"rejected",rejected,"loadedOnly",true,"blockReads",geometry.reads(),"maxBlockReads",FlatApproach.MAX_READS));
    }
    /**
     * Logs above the scan band connected (26-neighbourhood) to a requested log found in it, appended to the
     * matches bottom-up. Only requested log IDs, loaded cells, within TREE_SPREAD of the scan radius.
     */
    private static Set<BlockPos> treeAbove(ServerPlayer body,BlockPos origin,Options options,List<Candidate> matches) {
        Set<BlockPos> seen=new HashSet<>(),added=new LinkedHashSet<>();
        Deque<BlockPos> queue=new ArrayDeque<>();
        for(Candidate match:matches) {seen.add(match.position());if(match.state().is(BlockTags.LOGS))queue.add(match.position());}
        int spread=options.radius()+TREE_SPREAD;
        List<Candidate> extra=new ArrayList<>();
        while(!queue.isEmpty()&&added.size()<TREE_LIMIT) {
            BlockPos from=queue.poll();
            for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++) for(int dz=-1;dz<=1;dz++) {
                BlockPos next=from.offset(dx,dy,dz);
                if(!seen.add(next)||next.getY()<=origin.getY()+ABOVE&&dy<=0||next.getY()>origin.getY()+TREE_ABOVE)continue;
                int hx=next.getX()-origin.getX(),hz=next.getZ()-origin.getZ();
                if(hx*hx+hz*hz>spread*spread||body.serverLevel().isOutsideBuildHeight(next))continue;
                var chunk=body.serverLevel().getChunkSource().getChunkNow(next.getX()>>4,next.getZ()>>4);
                if(chunk==null)continue;
                BlockState state=chunk.getBlockState(next);
                if(!state.is(BlockTags.LOGS)||!options.blockIds().contains(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString()))continue;
                queue.add(next);
                if(next.getY()>origin.getY()+ABOVE&&added.size()<TREE_LIMIT){added.add(next);extra.add(new Candidate(next,state,Vec3.atCenterOf(next).distanceTo(options.center())));}
            }
        }
        extra.sort(Comparator.comparingInt((Candidate c)->c.position().getY()).thenComparingDouble(Candidate::distance));
        matches.addAll(extra);
        return added;
    }
    private static JsonObject position(Vec3 p){return obj("x",p.x,"y",p.y,"z",p.z);}
}
