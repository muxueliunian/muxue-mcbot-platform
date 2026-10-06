package com.mcbot.addon.sophisticatedbackpacks;

import com.mcbot.servercontrol.api.PickupSink;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;

/**
 * A backpack with a pickup upgrade in the bot's inventory takes matching drops before vanilla pickup runs and cancels
 * it. MCBOT compares these counts before and after, so those items are reported as picked up into the backpack instead
 * of being lost as an unexplained disappearance.
 */
final class BackpackPickupSink implements PickupSink {
    static final BackpackPickupSink INSTANCE = new BackpackPickupSink();
    private BackpackPickupSink() {}

    @Override public String id() { return "sophisticatedbackpacks:backpack/pickup"; }
    @Override public boolean installed() { return BackpackAccess.installed(); }

    @Override public Map<String, Integer> stored(ServerPlayer player) {
        var inventory = player.getInventory();
        List<ItemStack> carried = new ArrayList<>();
        for (int i = 0; i < inventory.getContainerSize(); i++) carried.add(inventory.getItem(i));
        return BackpackAccess.counts(carried);
    }
}
