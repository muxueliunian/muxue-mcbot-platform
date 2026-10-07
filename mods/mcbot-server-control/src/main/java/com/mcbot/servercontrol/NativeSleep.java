package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Lying down in a bed through the native player path (ServerPlayer.startSleepInBed), never a block right-click:
 * a bed used in the Nether or the End explodes, startSleepInBed only refuses. Like any player, sleeping sets the
 * body's respawn point to that bed. Waking is vanilla's: morning, damage, or an explicit wake-up.
 */
final class NativeSleep {
    static final int SEARCH_RADIUS=16,VERTICAL_RADIUS=4;
    private NativeSleep() {}

    /** Before walking anywhere: refuse what startSleepInBed would refuse anyway at the bed. */
    static void requireSleepable(ServerPlayer bot) {
        if(bot.isSleeping()) throw error("SLEEPING","Body is already asleep");
        if(!bot.level().dimensionType().natural()) throw error("BED_NOT_POSSIBLE_HERE","Beds do not work in this dimension");
        if(bot.level().isDay()) throw error("NOT_NIGHT","You can sleep only at night or during thunderstorms");
    }
    /** The head half of the nearest free bed around the centre, loaded chunks only; null when there is none. */
    static BlockPos nearestFreeBed(ServerPlayer bot,Vec3 center) {
        BlockPos origin=BlockPos.containing(center),best=null;double bestDistance=Double.MAX_VALUE;
        for(int x=-SEARCH_RADIUS;x<=SEARCH_RADIUS;x++) for(int z=-SEARCH_RADIUS;z<=SEARCH_RADIUS;z++) {
            if(x*x+z*z>SEARCH_RADIUS*SEARCH_RADIUS) continue;
            for(int y=-VERTICAL_RADIUS;y<=VERTICAL_RADIUS;y++) {
                BlockPos pos=origin.offset(x,y,z);
                if(bot.serverLevel().isOutsideBuildHeight(pos)) continue;
                var chunk=bot.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
                if(chunk==null) continue;
                BlockState state=chunk.getBlockState(pos);
                if(!bed(state)||state.getValue(BedBlock.PART)!=BedPart.HEAD||state.getValue(BedBlock.OCCUPIED)) continue;
                double distance=Vec3.atCenterOf(pos).distanceToSqr(center);
                if(distance<bestDistance) {best=pos.immutable();bestDistance=distance;}
            }
        }
        return best;
    }
    static boolean bed(BlockState state) {
        return state.getBlock() instanceof BedBlock&&state.hasProperty(BedBlock.PART)&&state.hasProperty(BedBlock.OCCUPIED)&&state.hasProperty(BedBlock.FACING);
    }
    /** The bed is still there, still free; checked on every tick of the walk and again before lying down. */
    static BlockState requireFreeBed(ServerPlayer bot,BlockPos head) {
        if(!bot.serverLevel().hasChunkAt(head)) throw error("STALE_TARGET","Bed chunk is no longer loaded");
        BlockState state=bot.serverLevel().getBlockState(head);
        if(!bed(state)||state.getValue(BedBlock.PART)!=BedPart.HEAD) throw error("STALE_TARGET","The bed is gone");
        if(state.getValue(BedBlock.OCCUPIED)) throw error("BED_OCCUPIED","Someone else is in that bed");
        return state;
    }
    /** Vanilla's bedInRange is three blocks across and two up from either half; stop a little inside it. */
    static boolean inReach(Vec3 feet,BlockPos head,BlockState state) {
        Direction foot=state.getValue(BedBlock.FACING).getOpposite();
        return near(feet,head)||near(feet,head.relative(foot));
    }
    private static boolean near(Vec3 feet,BlockPos half) {
        Vec3 bottom=Vec3.atBottomCenterOf(half);
        return Math.abs(feet.x-bottom.x)<=2.5&&Math.abs(feet.y-bottom.y)<=1.5&&Math.abs(feet.z-bottom.z)<=2.5;
    }
    static JsonObject lieDown(ServerPlayer bot,BlockPos head) {
        BlockState state=requireFreeBed(bot,head);
        var outcome=bot.startSleepInBed(head);
        if(outcome.left().isPresent()) {
            Player.BedSleepingProblem problem=outcome.left().get();
            throw switch(problem) {
                case NOT_POSSIBLE_HERE -> error("BED_NOT_POSSIBLE_HERE","Beds do not work in this dimension");
                case NOT_POSSIBLE_NOW -> error("NOT_NIGHT","You can sleep only at night or during thunderstorms");
                case TOO_FAR_AWAY -> error("OUT_OF_REACH","The bed is too far away");
                case OBSTRUCTED -> error("BED_OBSTRUCTED","Something blocks the space above the bed");
                case NOT_SAFE -> error("NOT_SAFE","Monsters are nearby; you may not rest now");
                default -> error("BED_REFUSED","The game refused sleeping in this bed");
            };
        }
        if(!bot.isSleeping()) throw error("UNKNOWN","Sleep was accepted but the body is not asleep");
        return obj("bed",obj("x",head.getX(),"y",head.getY(),"z",head.getZ()),"id",BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),"sleeping",true,"respawnSet",true);
    }
    static JsonObject wake(ServerPlayer bot) {
        boolean was=bot.isSleeping();
        if(was) bot.stopSleepInBed(true,true);
        return obj("wasSleeping",was,"sleeping",bot.isSleeping());
    }
}
