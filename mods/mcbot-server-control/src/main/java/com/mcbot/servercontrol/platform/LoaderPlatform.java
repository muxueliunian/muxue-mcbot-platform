package com.mcbot.servercontrol.platform;

import java.util.Objects;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.item.crafting.RecipeType;

/**
 * The few things the server body needs from the mod loader. Everything else in the mod uses vanilla classes only
 * (enforced by the loaderNeutralCheck build task), so a Fabric build only has to supply this and the event bridge.
 * The loader entry point installs its implementation before any server starts.
 */
public interface LoaderPlatform {
    /** Loader name: "neoforge", "fabric". */
    String loader();

    /** Mod id under which the loader reports its own version ("neoforge", "fabricloader"). */
    String loaderModId();

    /** Installed version of a mod, or "" when it is absent. */
    String modVersion(String modId);

    /** Burn time of a fuel stack in ticks for a cooking recipe type; 0 when it is not a fuel. */
    int burnTime(ItemStack stack, RecipeType<?> type);

    /** A block's item slots seen from a side (null = unsided), or null when the block exposes none there. */
    default ItemSlots itemSlots(ServerLevel level, BlockPos position, BlockState state, BlockEntity entity, Direction side) { return null; }

    /**
     * Whether the server lets this player use (right-click) the block at the hit, as protection mods decide through
     * the loader's right-click event; false when the event is cancelled or denies using the block. Fails closed.
     */
    default boolean mayUseBlock(ServerPlayer player, BlockHitResult hit) { return false; }

    static LoaderPlatform get() {
        LoaderPlatform platform = Holder.current;
        if (platform == null) throw new IllegalStateException("No loader platform installed");
        return platform;
    }

    /** Null before the loader entry point ran (early add-on constructors, offline tests). */
    static LoaderPlatform installedOrNull() { return Holder.current; }

    static void install(LoaderPlatform platform) { Holder.current = Objects.requireNonNull(platform, "platform"); }

    final class Holder {
        private static volatile LoaderPlatform current;
        private Holder() {}
    }
}
