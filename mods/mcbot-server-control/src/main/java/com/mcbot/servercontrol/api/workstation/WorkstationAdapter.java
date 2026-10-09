package com.mcbot.servercontrol.api.workstation;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Teaches the bot to use a workstation block: which blocks and menus it is, which menu slot plays which
 * {@link Port}, where its recipes come from and which {@link Template} drives it. The core walks to the block,
 * opens it with an ordinary right-click, checks {@link #menu} and {@link #layout} on the opened menu, and does
 * every click itself through the player's own packets, so the game's rules, results, experience and events stay
 * the game's. Register with {@code McbotApi.registerWorkstation}.
 *
 * <p>Fail closed like every adapter: answer {@code false}/{@code null} whenever the block, menu or slot layout
 * differs in any way from the version you verified, and pin that version in {@link #installed}. Vanilla blocks
 * are handled by the built-in adapters only. Methods that throw count as "not this station".</p>
 *
 * <p>Only vanilla and JDK types appear here, so the same adapter logic can serve the NeoForge and Fabric builds;
 * the adapted mod itself usually differs per loader, so keep the version pin per loader.</p>
 */
public interface WorkstationAdapter {
    /** Stable id, namespace = the adapted mod, e.g. {@code examplemod:alloy_kiln}. */
    String id();

    /** True only when the adapted mod is present at exactly the verified version ({@code McbotApi.versionsMatch}). */
    boolean installed();

    Template template();

    /** Whether this block state is a supported station in a supported mode. */
    boolean block(BlockState state);

    /** Whether an opened menu is exactly the verified menu of this station. */
    boolean menu(AbstractContainerMenu menu);

    /** The verified slot layout of an opened menu ({@link #menu} already true), or null when it differs. */
    StationLayout layout(AbstractContainerMenu menu);

    /** Recipes this station (in this state) runs. */
    RecipeSource recipes(BlockState state);

    /** Burn ticks of a fuel stack for this station; 0 when it is not fuel here. Only for stations with a {@link Port#FUEL}. */
    default int burnTicks(BlockState state, ItemStack fuel) { return 0; }

    /** Whether the opened machine is working right now (a lit furnace, a brewing stand mid-brew). */
    default boolean working(AbstractContainerMenu menu) { return false; }

    /** Fuel already inside the machine in its own measure (brewing stand: brews left); 0 when unknown or none. */
    default int fuelLeft(AbstractContainerMenu menu) { return 0; }

    /** The choices the opened menu offers for its current inputs, in button order; empty when it has none. */
    default List<StationOption> options(ServerPlayer player, AbstractContainerMenu menu) { return List.of(); }

    /** Experience levels taking the current result would cost (anvil); 0 when free. */
    default int levelCost(AbstractContainerMenu menu) { return 0; }

    /**
     * Optional: the machine's contents and progress read from the block in a loaded chunk, without opening its menu
     * (for "load it, leave, come back when it is done"). Read only; never change anything here. null when not
     * supported; the core then only estimates by time.
     */
    default StationProgress progress(Level level, BlockPos pos, BlockState state) { return null; }
}
