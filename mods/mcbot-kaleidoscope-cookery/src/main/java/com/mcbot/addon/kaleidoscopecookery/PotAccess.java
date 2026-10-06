package com.mcbot.addon.kaleidoscopecookery;

import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.McbotApi;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.TagKey;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

/**
 * Read-only reflective view of a Kaleidoscope Cookery pot. Every name below was checked against 1.6.0-neoforge+mc1.21.1;
 * if any of them is missing the adapter reports itself as not installed rather than guessing.
 */
final class PotAccess {
    private PotAccess() {}
    static final String MOD = "kaleidoscope_cookery", VERSION = "1.6.0-neoforge+mc1.21.1";
    static final String BLOCK_ID = "kaleidoscope_cookery:pot";
    static final String BLOCK_CLASS = "com.github.ysbbbbbb.kaleidoscopecookery.block.kitchen.PotBlock";
    static final String ENTITY_CLASS = "com.github.ysbbbbbb.kaleidoscopecookery.blockentity.kitchen.PotBlockEntity";
    static final TagKey<Item> OIL = tag("oil"), SHOVEL = tag("kitchen_shovel"), BLOCKLIST = tag("ingredient_blocklist"), CONTAINER = tag("ingredient_container");

    private record Members(Method status, Method heat, Method inputs, Method result, Method ticks, Field stirs, Field carrier) {}
    private static volatile Members members;
    private static volatile boolean broken;

    private static TagKey<Item> tag(String path) { return TagKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath(MOD, path)); }

    static boolean installed() { return McbotApi.versionsMatch(MOD, VERSION) && !broken; }

    /** The pot block of the verified class; anything else is not ours. */
    static boolean isPot(BlockState state) {
        return BLOCK_ID.equals(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString()) && BLOCK_CLASS.equals(state.getBlock().getClass().getName());
    }

    static boolean hasOil(BlockState state) {
        for (Property<?> property : state.getProperties())
            if (property.getName().equals("has_oil")) return Boolean.TRUE.equals(state.getValue(property));
        throw new IllegalStateException("pot has no has_oil property");
    }

    private static Members members(Class<?> type) throws ReflectiveOperationException {
        Members known = members;
        if (known != null) return known;
        Field stirs = type.getDeclaredField("stirFryCount"), carrier = type.getDeclaredField("carrier");
        stirs.setAccessible(true); carrier.setAccessible(true);
        known = new Members(type.getMethod("getStatus"), type.getMethod("hasHeatSource", Level.class), type.getMethod("getInputs"),
            type.getMethod("getResult"), type.getMethod("getCurrentTick"), stirs, carrier);
        members = known;
        return known;
    }

    /** Snapshot of the pot at this position as a summary, or an exception when it cannot be read exactly. */
    static JsonObject read(ServerLevel level, BlockPos position) {
        BlockState state = level.getBlockState(position);
        if (!isPot(state)) throw new IllegalStateException("not a Kaleidoscope Cookery pot");
        BlockEntity entity = level.getChunkAt(position).getBlockEntity(position);
        if (entity == null || !ENTITY_CLASS.equals(entity.getClass().getName())) throw new IllegalStateException("pot block entity missing or changed");
        try {
            Members m = members(entity.getClass());
            int status = (int) m.status().invoke(entity);
            boolean heat = (boolean) m.heat().invoke(entity, level);
            @SuppressWarnings("unchecked") List<ItemStack> stacks = (List<ItemStack>) m.inputs().invoke(entity);
            List<String> inputs = new ArrayList<>();
            for (ItemStack stack : stacks) if (!stack.isEmpty()) inputs.add(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
            ItemStack result = (ItemStack) m.result().invoke(entity);
            Ingredient carrier = (Ingredient) m.carrier().get(entity);
            String carrierId = carrier.isEmpty() || carrier.getItems().length == 0 ? "" : BuiltInRegistries.ITEM.getKey(carrier.getItems()[0].getItem()).toString();
            return PotRules.summary(status, inputs, stacks.size(), m.stirs().getInt(entity), (int) m.ticks().invoke(entity),
                result.isEmpty() ? "" : BuiltInRegistries.ITEM.getKey(result.getItem()).toString(), result.isEmpty() ? 0 : result.getCount(),
                carrierId, heat, hasOil(state));
        } catch (ReflectiveOperationException | ClassCastException | SecurityException changed) {
            broken = true;
            throw new IllegalStateException("Kaleidoscope Cookery pot internals changed", changed);
        }
    }

    /** Whether the held stack is the pot's carrier for the finished dish. */
    static boolean carrierMatches(ServerLevel level, BlockPos position, ItemStack held) {
        BlockEntity entity = level.getChunkAt(position).getBlockEntity(position);
        try {
            Ingredient carrier = (Ingredient) members(entity.getClass()).carrier().get(entity);
            return !carrier.isEmpty() && carrier.test(held);
        } catch (ReflectiveOperationException | RuntimeException changed) { return false; }
    }

    /** Ingredients the pot accepts in 1.6.0, minus anything that hands back a container item (kept out of the envelope). */
    static boolean plainIngredient(ItemStack held) {
        if (held.isEmpty() || held.is(BLOCKLIST) || held.is(CONTAINER) || held.is(SHOVEL) || held.is(OIL)) return false;
        if (held.hasCraftingRemainingItem()) return false;
        var food = held.get(net.minecraft.core.component.DataComponents.FOOD);
        return food == null || food.usingConvertsTo().isEmpty();
    }
}
