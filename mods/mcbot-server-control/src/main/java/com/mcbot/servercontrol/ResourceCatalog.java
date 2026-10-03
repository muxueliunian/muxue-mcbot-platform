package com.mcbot.servercontrol;

import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Explicit first-batch resources. This is an allowlist, never a claim that a block is not player-built. */
final class ResourceCatalog {
    static final Set<String> IDS=Set.of("minecraft:stone","minecraft:deepslate","minecraft:granite","minecraft:diorite","minecraft:andesite",
        "minecraft:oak_log","minecraft:spruce_log","minecraft:birch_log","minecraft:jungle_log","minecraft:acacia_log","minecraft:dark_oak_log","minecraft:mangrove_log","minecraft:cherry_log");
    static boolean allowed(String id) {return IDS.contains(id);}
    static void requireSafe(ServerPlayer body,BlockPos pos,FlatApproach geometry) {
        if(!atOrAboveFeet(pos,body.position()))throw error("BLOCKED","First-batch gathering cannot excavate below the body's feet plane");
        BlockState state=geometry.requireLoaded(pos);
        String id=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if(!allowed(id)||state.hasBlockEntity()||FlatApproach.hazard(state)) throw error("UNSUPPORTED","Resource is outside the explicit stone/log catalog");
        // Do not excavate the floor supporting any nearby player, or a cell intersecting their body.
        List<Player> players=new ArrayList<>(body.serverLevel().getEntitiesOfClass(Player.class,new AABB(pos).inflate(2)));
        if(!players.contains(body)) players.add(body);
        for(Player player:players) if(protectsPlayer(pos,player.getBoundingBox())) throw error("BLOCKED","Resource intersects a player or supports their feet");
        for(var direction:net.minecraft.core.Direction.values()) {
            BlockState adjacent=geometry.requireLoaded(pos.relative(direction));
            if(FlatApproach.hazard(adjacent)||(direction==net.minecraft.core.Direction.UP&&adjacent.getBlock() instanceof FallingBlock))
                throw error("BLOCKED","Resource neighbours liquid, danger or a falling block");
        }
    }
    static boolean atOrAboveFeet(BlockPos position,Vec3 feet){return position.getY()>=(int)Math.floor(feet.y);}
    static boolean protectsPlayer(BlockPos pos,AABB bounds) {
        AABB block=new AABB(pos);
        return block.intersects(bounds)||block.intersects(new AABB(bounds.minX,bounds.minY-0.05,bounds.minZ,bounds.maxX,bounds.minY,bounds.maxZ));
    }
}
