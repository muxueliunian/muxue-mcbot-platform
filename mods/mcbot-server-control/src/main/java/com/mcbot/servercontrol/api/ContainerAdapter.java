package com.mcbot.servercontrol.api;

import java.util.OptionalInt;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.MenuProvider;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Lets the bot find, open and move items in another mod's storage or machine block through its native menu.
 *
 * <p>Every check is fail-closed: answer {@code false}/{@code null} whenever the block, entity or menu differs in any
 * way from the version you verified. The bot only clicks slots whose owner is proven: slots backed by
 * {@link #storage} count as container slots, slots backed by the player's own inventory (or reported by
 * {@link #playerSlot}) as player slots; anything else is shown to the agent as "unknown" and never touched.</p>
 */
public interface ContainerAdapter {
    /** Stable id, namespace = the adapted mod, e.g. {@code ironfurnaces:iron_furnace}. */
    String id();

    /** True only when the adapted mod is present at exactly the verified version ({@link McbotApi#versionsMatch}). */
    boolean installed();

    /** Whether this block state is one this adapter supports in its current mode (e.g. idle, not a variant). */
    boolean block(BlockState state);

    /** Extra identity check of the block entity behind a supported block. */
    default boolean entity(BlockEntity entity) { return true; }

    /** Menu provider when the block does not expose one through {@code BlockState#getMenuProvider}; null otherwise. */
    default MenuProvider provider(ServerPlayer player, BlockPos position, BlockState state) { return null; }

    /** Whether an open menu is exactly the verified menu of a supported block. */
    boolean menu(AbstractContainerMenu menu);

    /** The block's real storage behind the menu's machine slots, after verifying the full slot layout; null if it changed. */
    Container storage(AbstractContainerMenu menu, Inventory inventory);

    /** Native player-inventory index for a menu slot that wraps the player inventory indirectly (e.g. item handlers). */
    default OptionalInt playerSlot(Slot slot, Inventory inventory) { return OptionalInt.empty(); }
}
