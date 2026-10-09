package com.mcbot.servercontrol.platform;

import net.minecraft.world.item.ItemStack;

/**
 * A block's item slots as the loader exposes them to automation (NeoForge: the item handler capability of one side),
 * used without opening a menu. Same contract as NeoForge's {@code IItemHandler}: stacks returned by {@link #get} must
 * not be modified; insert returns the remainder, extract the extracted stack; simulate changes nothing.
 */
public interface ItemSlots {
    int size();

    ItemStack get(int slot);

    int limit(int slot);

    boolean valid(int slot, ItemStack stack);

    ItemStack insert(int slot, ItemStack stack, boolean simulate);

    ItemStack extract(int slot, int amount, boolean simulate);
}
