package com.mcbot.addon.sophisticatedbackpacks;

import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.items.IItemHandler;

/**
 * Identity of one backpack's storage for MCBOT's slot ownership and target checks. Backpack slots are item-handler slots,
 * so there is no real {@link Container} behind them; this read-only view stands in for it. Writes always go through the
 * native menu clicks, never through this object.
 */
final class BackpackStorage implements Container {
    final Object wrapper;
    final IItemHandler handler;

    BackpackStorage(Object wrapper, IItemHandler handler) { this.wrapper = wrapper; this.handler = handler; }

    @Override public int getContainerSize() { return handler.getSlots(); }
    @Override public boolean isEmpty() {
        for (int i = 0; i < handler.getSlots(); i++) if (!handler.getStackInSlot(i).isEmpty()) return false;
        return true;
    }
    @Override public ItemStack getItem(int slot) { return handler.getStackInSlot(slot); }
    @Override public ItemStack removeItem(int slot, int amount) { throw new UnsupportedOperationException("read-only backpack view"); }
    @Override public ItemStack removeItemNoUpdate(int slot) { throw new UnsupportedOperationException("read-only backpack view"); }
    @Override public void setItem(int slot, ItemStack stack) { throw new UnsupportedOperationException("read-only backpack view"); }
    @Override public void setChanged() {}
    @Override public boolean stillValid(Player player) { return true; }
    @Override public void clearContent() { throw new UnsupportedOperationException("read-only backpack view"); }
}
