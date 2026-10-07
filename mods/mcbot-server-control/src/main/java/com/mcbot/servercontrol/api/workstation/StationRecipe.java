package com.mcbot.servercontrol.api.workstation;

import java.util.List;
import java.util.Objects;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;

/**
 * One way a station turns ingredients into a result, as the core needs it.
 *
 * <p>For a grid the {@code cells} are the shape row-major in {@code width x height}, {@link Ingredient#EMPTY} for
 * a cell that stays empty; a shapeless recipe is laid out in the smallest box that holds it. For a processor the
 * single cell is its input. {@code ticks} is the processing time (0 for an instant craft), {@code experience} what
 * vanilla would award, both only for the receipt. The station's own result slot stays the authority: the core
 * checks it shows {@code result} before taking anything.</p>
 */
public record StationRecipe(ResourceLocation id, ItemStack result, int width, int height, List<Ingredient> cells, int ticks, float experience) {
    public StationRecipe {
        Objects.requireNonNull(id, "id");
        result = Objects.requireNonNull(result, "result").copy();
        cells = List.copyOf(cells);
        if (width < 1 || height < 1 || cells.size() != width * height) throw new IllegalArgumentException("cells must fill " + width + "x" + height);
    }

    /** A single-input processing recipe. */
    public static StationRecipe processing(ResourceLocation id, ItemStack result, Ingredient input, int ticks, float experience) {
        return new StationRecipe(id, result, 1, 1, List.of(input), ticks, experience);
    }

    public ItemStack result() { return result.copy(); }

    /** Whether the shape fits a grid of this size. */
    public boolean fits(int gridWidth, int gridHeight) { return width <= gridWidth && height <= gridHeight; }
}
