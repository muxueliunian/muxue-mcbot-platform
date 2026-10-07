package com.mcbot.servercontrol.api.workstation;

import java.util.List;
import java.util.Optional;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

/**
 * Where a station's recipes come from: the recipe manager, a computed rule (brewing, anvil) or a mod's own table.
 * Implementations read live server data on every call (data packs can reload) and never change the world.
 * Matching is the server's own ({@code Ingredient.test} or the mod's matcher); listed items only explain.
 */
public interface RecipeSource {
    /** Ways to make {@code wanted}, simplest first (grid crafters). */
    default List<StationRecipe> producing(ServerPlayer player, Item wanted) { return List.of(); }

    /** The recipe the station would run for this input (processors). */
    default Optional<StationRecipe> forInput(ServerPlayer player, ItemStack input) { return Optional.empty(); }

    /** Whether this item can be the {@link Port#INGREDIENT} of an in-place stage (brewing reagents). */
    default boolean isIngredient(ServerPlayer player, ItemStack ingredient) { return false; }

    /** What one in-place stage turns {@code subject} into with {@code ingredient} (brewing), or empty when it does nothing. */
    default Optional<ItemStack> transform(ServerPlayer player, ItemStack subject, ItemStack ingredient) { return Optional.empty(); }
}
