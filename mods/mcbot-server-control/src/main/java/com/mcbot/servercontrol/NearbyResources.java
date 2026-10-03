package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

final class NearbyResources {
    static final int VERTICAL_RADIUS=2,MAX_VISITED=13*13*5;
    record Options(Set<String> blockIds,int radius,int maxResults,Vec3 center) {}
    static Options options(JsonObject args,Vec3 body) {
        if(!args.has("blockIds")||!args.get("blockIds").isJsonArray()||args.getAsJsonArray("blockIds").isEmpty()||args.getAsJsonArray("blockIds").size()>8)
            throw error("INVALID_ARGUMENT","blockIds requires one to eight explicit catalog IDs");
        Set<String> ids=new LinkedHashSet<>();
        for(JsonElement entry:args.getAsJsonArray("blockIds")) {
            if(!entry.isJsonPrimitive()||!entry.getAsJsonPrimitive().isString()||!ResourceCatalog.allowed(entry.getAsString())) throw error("UNSUPPORTED","Resource ID is not in the stone/log catalog");
            ids.add(entry.getAsString());
        }
        int radius=integer(args,"radius",4,1,6),limit=integer(args,"maxResults",32,1,64);
        Vec3 center=body;
        if(args.has("center")) {JsonObject p=object(args,"center");center=new Vec3(number(p,"x"),number(p,"y"),number(p,"z"));}
        if(center.distanceTo(body)>8) throw error("INVALID_ARGUMENT","Resource scan center must remain within eight blocks of the body");
        return new Options(Set.copyOf(ids),radius,limit,center);
    }
    private static int integer(JsonObject args,String key,int fallback,int min,int max) {double value=bounded(args,key,fallback,min,max);if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");return (int)value;}
    private record Candidate(BlockPos position,BlockState state,double distance) {}
    static JsonObject discover(ServerPlayer body,JsonObject args,ResourceTargets targets) {
        Options options=options(args,body.position());BlockPos origin=BlockPos.containing(options.center());
        List<Candidate> found=new ArrayList<>();int visited=0,unloaded=0,rejected=0;boolean exhausted=false;
        FlatApproach geometry=new FlatApproach(body);
        scan:for(int x=-options.radius();x<=options.radius();x++) for(int z=-options.radius();z<=options.radius();z++) {
            if(x*x+z*z>options.radius()*options.radius())continue;
            for(int y=-VERTICAL_RADIUS;y<=VERTICAL_RADIUS;y++) {
                visited++;BlockPos pos=origin.offset(x,y,z);
                if(body.serverLevel().isOutsideBuildHeight(pos)||!body.serverLevel().getWorldBorder().isWithinBounds(pos))continue;
                var chunk=body.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
                if(chunk==null){unloaded++;continue;}
                BlockState state=chunk.getBlockState(pos);
                if(!options.blockIds().contains(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString()))continue;
                try {ResourceCatalog.requireSafe(body,pos,geometry);if(!geometry.blockVisible(pos)){rejected++;continue;}}
                catch(Protocol.Error unsafe){if(unsafe.code.equals("PATH_BUDGET")){exhausted=true;break scan;}rejected++;continue;}
                found.add(new Candidate(pos,state,Vec3.atCenterOf(pos).distanceTo(options.center())));
            }
        }
        found.sort(Comparator.comparingDouble(Candidate::distance).thenComparingInt(c->c.position().getX()).thenComparingInt(c->c.position().getY()).thenComparingInt(c->c.position().getZ()));
        JsonArray candidates=new JsonArray();
        for(Candidate candidate:found.subList(0,Math.min(found.size(),options.maxResults()))) {
            JsonObject properties=new JsonObject();candidate.state().getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
            JsonArray suitable=new JsonArray();int recommended=-1;float best=-1;
            for(int slot=0;slot<9;slot++) {
                var stack=body.getInventory().getItem(slot);
                if(!candidate.state().requiresCorrectToolForDrops()||stack.isCorrectToolForDrops(candidate.state())) {
                    suitable.add(slot);float speed=stack.getDestroySpeed(candidate.state());if(speed>best){best=speed;recommended=slot;}
                }
            }
            JsonObject value=obj("position",position(Vec3.atLowerCornerOf(candidate.position())),"id",BuiltInRegistries.BLOCK.getKey(candidate.state().getBlock()).toString(),"properties",properties,
                "targetToken",targets.issue(body,candidate.position(),candidate.state()),"distance",candidate.distance(),"visible",true,"requiresCorrectTool",candidate.state().requiresCorrectToolForDrops(),"suitableToolSlots",suitable);
            if(recommended>=0)value.addProperty("recommendedToolSlot",recommended);
            candidates.add(value);
        }
        return obj("dimension",body.serverLevel().dimension().location().toString(),"center",position(options.center()),"candidates",candidates,
            "truncated",found.size()>options.maxResults()||exhausted,"budget",obj("radius",options.radius(),"verticalRadius",VERTICAL_RADIUS,"visited",visited,"maxVisited",MAX_VISITED,"unloaded",unloaded,"rejected",rejected,"loadedOnly",true,"blockReads",geometry.reads(),"maxBlockReads",FlatApproach.MAX_READS));
    }
    private static JsonObject position(Vec3 p){return obj("x",p.x,"y",p.y,"z",p.z);}
}
