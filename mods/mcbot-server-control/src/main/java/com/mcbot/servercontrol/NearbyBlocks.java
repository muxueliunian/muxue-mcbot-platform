package com.mcbot.servercontrol;

import com.google.gson.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.*;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.*;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Loaded-only discovery of identity. Never opens a menu or reads inventory contents. */
final class NearbyBlocks {
    static final int MAX_VISITED=17*17*5,MAX_BLOCK_READS=8192,VERTICAL_RADIUS=2;
    record Options(int radius,int maxResults,String centerPlayer) {}
    private record Candidate(BlockPos position,BlockState state,double distance) {}
    private NearbyBlocks() {}

    static Options options(JsonObject params) {
        return new Options(integer(params,"radius",4,1,8),integer(params,"maxResults",8,1,16),
            params.has("centerPlayer")?string(params,"centerPlayer"):null);
    }
    private static int integer(JsonObject params,String key,int fallback,int min,int max) {
        double value=bounded(params,key,fallback,min,max);
        if(value!=Math.rint(value)) throw error("INVALID_ARGUMENT",key+" must be an integer");
        return (int)value;
    }
    static boolean ordinaryContainer(BlockState state) {
        Block block=state.getBlock();
        return block instanceof ChestBlock||block instanceof BarrelBlock||block instanceof HopperBlock||
            block instanceof DispenserBlock||block instanceof ShulkerBoxBlock||block instanceof AbstractFurnaceBlock||IronFurnaceAdapter.block(state);
    }
    static JsonObject discover(ServerPlayer bot,ServerPlayer center,Options options,TargetTokens tokens) {
        LoadedView view=new LoadedView(bot);
        BlockPos origin=center.blockPosition();
        List<Candidate> found=new ArrayList<>();int visited=0,unloaded=0;
        for(int x=-options.radius();x<=options.radius();x++) for(int z=-options.radius();z<=options.radius();z++) {
            if(x*x+z*z>options.radius()*options.radius()) continue;
            for(int y=-VERTICAL_RADIUS;y<=VERTICAL_RADIUS;y++) {
                visited++;
                BlockPos pos=origin.offset(x,y,z);
                if(bot.serverLevel().isOutsideBuildHeight(pos)||!bot.serverLevel().getWorldBorder().isWithinBounds(pos)) continue;
                BlockState state=view.loadedState(pos);
                if(state==null) { unloaded++;continue; }
                if(ordinaryContainer(state)) found.add(new Candidate(pos,state,Vec3.atCenterOf(pos).distanceTo(center.position())));
            }
        }
        found.sort(Comparator.comparingDouble(Candidate::distance).thenComparingInt(c->c.position().getX())
            .thenComparingInt(c->c.position().getY()).thenComparingInt(c->c.position().getZ()));
        JsonArray candidates=new JsonArray();
        for(Candidate candidate:found.subList(0,Math.min(found.size(),options.maxResults()))) {
            String token;
            try { token=tokens.issue(bot,candidate.position()); }
            catch(Protocol.Error unavailable) { continue; }
            String visibility=view.visibility(center,Vec3.atCenterOf(candidate.position()),candidate.position());
            JsonObject properties=new JsonObject();
            candidate.state().getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
            candidates.add(obj("position",position(Vec3.atLowerCornerOf(candidate.position())),
                "id",BuiltInRegistries.BLOCK.getKey(candidate.state().getBlock()).toString(),"properties",properties,
                "distance",candidate.distance(),"visible",visibility.equals("unknown")?null:visibility.equals("visible"),"visibility",visibility,"targetToken",token));
        }
        return obj("dimension",bot.serverLevel().dimension().location().toString(),
            "center",obj("player",center.getGameProfile().getName(),"position",position(center.position()),"eyePosition",position(center.getEyePosition())),
            "candidates",candidates,"truncated",found.size()>options.maxResults()||view.exhausted,
            "budget",obj("maxVisited",MAX_VISITED,"visited",visited,"verticalRadius",VERTICAL_RADIUS,
                "loadedOnly",true,"unloaded",unloaded,"maxBlockReads",MAX_BLOCK_READS,"blockReads",view.reads));
    }
    static boolean visiblePlayer(ServerPlayer bot,ServerPlayer target) {
        return new LoadedView(bot).visibility(bot,target.getEyePosition(),null).equals("visible");
    }
    private static JsonObject position(Vec3 point) { return obj("x",point.x,"y",point.y,"z",point.z); }

    /** Shape/ray queries also use loaded chunk lookup, including shape neighbour reads. */
    private static final class LoadedView implements BlockGetter {
        final ServerPlayer bot;
        int reads;boolean missing,exhausted;
        LoadedView(ServerPlayer bot) {this.bot=bot;}
        BlockState loadedState(BlockPos pos) {
            if(reads>=MAX_BLOCK_READS) {exhausted=true;missing=true;return null;}
            reads++;
            if(bot.serverLevel().isOutsideBuildHeight(pos)) return Blocks.AIR.defaultBlockState();
            var chunk=bot.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
            if(chunk==null) {missing=true;return null;}
            return chunk.getBlockState(pos);
        }
        String visibility(ServerPlayer observer,Vec3 destination,BlockPos target) {
            missing=false;
            BlockHitResult hit=clip(new ClipContext(observer.getEyePosition(),destination,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,observer));
            if(missing||exhausted) return "unknown";
            return hit.getType()==HitResult.Type.MISS||(target!=null&&hit.getBlockPos().equals(target))?"visible":"occluded";
        }
        @Override public BlockState getBlockState(BlockPos pos) {BlockState state=loadedState(pos);return state==null?Blocks.AIR.defaultBlockState():state;}
        @Override public FluidState getFluidState(BlockPos pos) {return getBlockState(pos).getFluidState();}
        @Override public BlockEntity getBlockEntity(BlockPos pos) {missing=true;return null;}
        @Override public int getHeight() {return bot.serverLevel().getHeight();}
        @Override public int getMinBuildHeight() {return bot.serverLevel().getMinBuildHeight();}
    }
}
