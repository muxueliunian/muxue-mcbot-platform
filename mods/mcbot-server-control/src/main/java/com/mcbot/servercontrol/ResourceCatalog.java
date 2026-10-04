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

/** Explicit finite resources. This is an allowlist, never a claim that a block is not player-built. */
final class ResourceCatalog {
    // Version-pinned vanilla ordinary outputs, not a prediction of server loot tables or yield.
    static final Map<String,String> ORE_DROPS=Map.of(
        "minecraft:coal_ore","minecraft:coal","minecraft:deepslate_coal_ore","minecraft:coal",
        "minecraft:iron_ore","minecraft:raw_iron","minecraft:deepslate_iron_ore","minecraft:raw_iron",
        "minecraft:copper_ore","minecraft:raw_copper","minecraft:deepslate_copper_ore","minecraft:raw_copper");
    static final Set<String> IDS=Set.of("minecraft:stone","minecraft:deepslate","minecraft:granite","minecraft:diorite","minecraft:andesite",
        "minecraft:oak_log","minecraft:spruce_log","minecraft:birch_log","minecraft:jungle_log","minecraft:acacia_log","minecraft:dark_oak_log","minecraft:mangrove_log","minecraft:cherry_log",
        "minecraft:coal_ore","minecraft:deepslate_coal_ore","minecraft:iron_ore","minecraft:deepslate_iron_ore","minecraft:copper_ore","minecraft:deepslate_copper_ore");
    static boolean allowed(String id) {return IDS.contains(id);}
    static boolean ore(String id) {return ORE_DROPS.containsKey(id);}
    static ToolAssessment.Policy discoveryPolicy(String id) {
        return ore(id)?new ToolAssessment.Policy("fastest_valid",2,"no_silk_touch"):ToolAssessment.Policy.defaults();
    }
    static void requireOrdinaryOreTool(String id,ToolAssessment.Candidate tool) {
        if(!ore(id))return;
        if(!Boolean.TRUE.equals(tool.eligible()))throw error(tool.eligible()==null?"UNKNOWN":"MISSING_TOOL","Ordinary ore harvesting requires known native tool eligibility");
        if(!tool.componentsComplete()||!tool.dropEffectsKnown())throw error("UNKNOWN","Ore tool components or drop effects cannot be assessed safely");
        if(tool.silkTouch()>0)throw error("UNSUPPORTED","Finite ore gathering only supports ordinary coal/raw iron/raw copper drops; silk touch ore blocks are not supported");
    }
    static void requireSafe(ServerPlayer body,BlockPos pos,FlatApproach geometry) {
        if(!atOrAboveFeet(pos,body.position()))throw error("BLOCKED","First-batch gathering cannot excavate below the body's feet plane");
        BlockState state=geometry.requireLoaded(pos);
        String id=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if(!allowed(id)||state.hasBlockEntity()||FlatApproach.hazard(state)) throw error("UNSUPPORTED","Resource is outside the explicit stone/log/coal/iron/copper catalog");
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
