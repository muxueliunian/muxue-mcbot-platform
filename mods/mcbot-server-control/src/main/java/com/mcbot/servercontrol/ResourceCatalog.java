package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.loot.LootParams;
import net.minecraft.world.level.storage.loot.parameters.LootContextParams;
import net.minecraft.world.phys.*;
import net.neoforged.neoforge.common.Tags;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Finite natural resources, recognised by block tags so modded trees, ores and stones count too: logs
 * (`#minecraft:logs`, not stripped logs or bark-only wood), ores (`#c:ores`) and stones (`#c:stones` plus
 * the vanilla stones of the first batch). Never a claim that a block is not player-built. Blocks with a
 * block entity are never resources.
 */
final class ResourceCatalog {
    enum Kind { LOG, ORE, STONE;
        String wire(){return name().toLowerCase(Locale.ROOT);}
    }
    static final Set<String> FIRST_STONES=Set.of("minecraft:stone","minecraft:deepslate","minecraft:granite","minecraft:diorite","minecraft:andesite");
    /** A requested resource: an explicit block ID or a block tag (`#c:ores`). Only syntax here; the live tag decides at scan time. */
    static boolean selector(String value) {
        String id=value.startsWith("#")?value.substring(1):value;
        return id.matches("[a-z0-9_.-]+:[a-z0-9_/.-]+");
    }
    static Kind kind(BlockState state) {
        if(state.hasBlockEntity()) return null;
        ResourceLocation key=BuiltInRegistries.BLOCK.getKey(state.getBlock());
        String path=key.getPath();
        if(state.is(BlockTags.LOGS)) return path.contains("stripped")||path.endsWith("_wood")||path.endsWith("_hyphae")?null:Kind.LOG;
        if(state.is(Tags.Blocks.ORES)) return Kind.ORE;
        if(state.is(Tags.Blocks.STONES)||FIRST_STONES.contains(key.toString())) return Kind.STONE;
        return null;
    }
    static String id(BlockState state){return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();}
    static boolean ore(BlockState state){return kind(state)==Kind.ORE;}
    /** Resolved selectors: explicit blocks must be catalog resources; tags only narrow the catalog. */
    record Selection(Set<Block> blocks,List<TagKey<Block>> tags) {
        boolean matches(BlockState state){
            if(blocks.contains(state.getBlock()))return true;
            for(var tag:tags)if(state.is(tag))return true;
            return false;
        }
    }
    static Selection select(Set<String> selectors) {
        Set<Block> blocks=new HashSet<>();List<TagKey<Block>> tags=new ArrayList<>();
        for(String value:selectors) {
            if(value.startsWith("#")){tags.add(TagKey.create(Registries.BLOCK,ResourceLocation.parse(value.substring(1))));continue;}
            var block=BuiltInRegistries.BLOCK.getOptional(ResourceLocation.parse(value)).orElse(null);
            if(block==null||kind(block.defaultBlockState())==null)throw error("UNSUPPORTED","Resource "+value+" is not a natural log, ore or stone (by block tags)");
            blocks.add(block);
        }
        return new Selection(blocks,tags);
    }
    static ToolAssessment.Policy discoveryPolicy(boolean ore) {
        return ore?new ToolAssessment.Policy("fastest_valid",2,"no_silk_touch"):ToolAssessment.Policy.defaults();
    }
    static void requireOrdinaryOreTool(boolean ore,ToolAssessment.Candidate tool) {
        if(!ore)return;
        if(!Boolean.TRUE.equals(tool.eligible()))throw error(tool.eligible()==null?"UNKNOWN":"MISSING_TOOL","Ordinary ore harvesting requires known native tool eligibility");
        if(!tool.componentsComplete()||!tool.dropEffectsKnown())throw error("UNKNOWN","Ore tool components or drop effects cannot be assessed safely");
        if(tool.silkTouch()>0)throw error("UNSUPPORTED","Finite ore gathering only supports the ordinary (non silk touch) drops; silk touch ore blocks are not supported");
    }

    /** One item a block drops: whether it needs or forbids silk touch, and the least count seen per block. */
    record Drop(String item,String preference,int least) {
        JsonObject json(){return obj("item",item,"preference",preference,"least",least);}
    }
    static final int ROLLS=12;
    /**
     * What the block really drops on this server, from its loot table: rolled with a plain and a silk touch
     * tool of the top tier (no Fortune). Ores keep only their ordinary drops. Counts are the least seen over
     * the rolls, so a chance drop reads 0; actual yield is still confirmed by native pickup receipts.
     */
    static List<Drop> drops(ServerPlayer body,BlockPos pos,BlockState state) {
        Kind kind=kind(state);
        if(kind==null)return List.of();
        ServerLevel level=body.serverLevel();
        ItemStack plain=new ItemStack(kind==Kind.LOG?Items.NETHERITE_AXE:Items.NETHERITE_PICKAXE),silk=plain.copy();
        silk.enchant(level.registryAccess().registryOrThrow(Registries.ENCHANTMENT).getHolderOrThrow(Enchantments.SILK_TOUCH),1);
        Map<String,Integer> ordinary=roll(body,pos,state,plain),silky=roll(body,pos,state,silk);
        List<Drop> drops=new ArrayList<>();
        ordinary.forEach((item,least)->drops.add(new Drop(item,silky.containsKey(item)?"any":"no_silk_touch",least)));
        if(kind!=Kind.ORE)silky.forEach((item,least)->{if(!ordinary.containsKey(item))drops.add(new Drop(item,"silk_touch",least));});
        return drops;
    }
    private static Map<String,Integer> roll(ServerPlayer body,BlockPos pos,BlockState state,ItemStack tool) {
        Map<String,Integer> least=new LinkedHashMap<>();
        for(int i=0;i<ROLLS;i++) {
            Map<String,Integer> counts=new HashMap<>();
            var params=new LootParams.Builder(body.serverLevel()).withParameter(LootContextParams.ORIGIN,Vec3.atCenterOf(pos)).withParameter(LootContextParams.TOOL,tool).withOptionalParameter(LootContextParams.THIS_ENTITY,body);
            for(ItemStack stack:state.getDrops(params))if(!stack.isEmpty())counts.merge(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),stack.getCount(),Integer::sum);
            for(String item:counts.keySet())least.putIfAbsent(item,i==0?counts.get(item):0);
            for(var entry:least.entrySet())entry.setValue(Math.min(entry.getValue(),counts.getOrDefault(entry.getKey(),0)));
        }
        return least;
    }
    static boolean drops(List<Drop> drops,String item){return drops.stream().anyMatch(drop->drop.item().equals(item));}

    static void requireSafe(ServerPlayer body,BlockPos pos,FlatApproach geometry) {
        if(!atOrAboveFeet(pos,body.position()))throw error("BLOCKED","First-batch gathering cannot excavate below the body's feet plane");
        BlockState state=geometry.requireLoaded(pos);
        if(kind(state)==null||FlatApproach.hazard(state)) throw error("UNSUPPORTED","Resource is not a natural log, ore or stone (by block tags)");
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
