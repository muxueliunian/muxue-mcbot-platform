package com.mcbot.addon.sophisticatedbackpacks;

import com.mcbot.servercontrol.api.ContainerAdapter;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.MenuProvider;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.items.SlotItemHandler;

/**
 * Backpack menus, whether the backpack is placed (opened with an empty hand) or held (opened through
 * {@link OpenBackpack}). Only the storage slots and the player inventory are claimed; upgrade and settings slots stay
 * unknown. A backpack with upgrades MCBOT has not verified is refused as a whole.
 */
final class BackpackContainerAdapter implements ContainerAdapter {
    static final BackpackContainerAdapter INSTANCE = new BackpackContainerAdapter();
    private BackpackContainerAdapter() {}

    @Override public String id() { return "sophisticatedbackpacks:backpack"; }
    @Override public boolean installed() { return BackpackAccess.installed(); }
    @Override public boolean block(BlockState state) { return BackpackAccess.isBlock(state); }
    @Override public boolean entity(BlockEntity entity) { return BackpackAccess.isEntity(entity); }

    @Override public MenuProvider provider(ServerPlayer player, BlockPos position, BlockState state) {
        if (!BackpackAccess.isBlock(state)) return null;
        // A placed backpack with unverified upgrades is refused before any right-click.
        BlockEntity entity = player.serverLevel().getChunkAt(position).getBlockEntity(position);
        if (!BackpackAccess.isEntity(entity) || BackpackRules.refusal(BackpackAccess.unverifiedUpgrades(BackpackAccess.entityWrapper(entity))) != null) return null;
        BlockPos at = position.immutable();
        return new SimpleMenuProvider((id, inventory, opener) -> BackpackAccess.blockMenu(id, opener, at), Component.translatable(state.getBlock().getDescriptionId()));
    }

    @Override public boolean menu(AbstractContainerMenu menu) {
        return BackpackAccess.isMenu(menu) && BackpackAccess.contextKind(menu) != null
            && BackpackRules.refusal(BackpackAccess.unverifiedUpgrades(BackpackAccess.menuWrapper(menu))) == null;
    }

    @Override public Container storage(AbstractContainerMenu menu, Inventory inventory) {
        if (!menu(menu)) return null;
        Object wrapper = BackpackAccess.menuWrapper(menu);
        var handler = BackpackAccess.inventory(wrapper);
        List<BackpackRules.SlotView> slots = new ArrayList<>();
        for (Slot slot : menu.slots)
            slots.add(new BackpackRules.SlotView(slot.getClass().getName(), slot instanceof SlotItemHandler items ? items.getItemHandler() : null, slot.container, slot.getContainerSlot()));
        return BackpackRules.layout(slots, handler, handler.getSlots(), inventory) ? new BackpackStorage(wrapper, handler) : null;
    }

    @Override public boolean storageSlot(Slot slot, Container storage) {
        return storage instanceof BackpackStorage backpack && BackpackAccess.STORAGE_SLOT.equals(slot.getClass().getName())
            && slot instanceof SlotItemHandler items && items.getItemHandler() == backpack.handler
            && slot.getContainerSlot() >= 0 && slot.getContainerSlot() < backpack.handler.getSlots();
    }

    @Override public boolean storageOf(Container storage, BlockEntity entity) {
        if (!(storage instanceof BackpackStorage backpack) || !BackpackAccess.isEntity(entity)) return false;
        // Wrappers are recreated freely; the contents id names the one storage both the block and the menu use.
        var placed = BackpackAccess.contentsUuid(BackpackAccess.entityWrapper(entity));
        return placed.isPresent() && placed.equals(BackpackAccess.contentsUuid(backpack.wrapper));
    }
}
