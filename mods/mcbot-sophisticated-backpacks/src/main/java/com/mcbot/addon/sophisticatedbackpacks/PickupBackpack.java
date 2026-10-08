package com.mcbot.addon.sophisticatedbackpacks;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Sneak and right-click a placed backpack with an empty hand: Sophisticated Backpacks puts it, contents and all, into the
 * hand and removes the block. Wearing it afterwards is the ordinary equip-item (a backpack is worn in the chest slot).
 * A backpack holding upgrades MCBOT has not verified is refused, as for opening: worn or carried they act on their own.
 */
final class PickupBackpack implements ItemInteraction {
    static final PickupBackpack INSTANCE = new PickupBackpack();
    static final Expected TAKES = new Expected(0, 0, false, Set.of(), Set.of(), BackpackAccess.BACKPACKS, false, Set.of(), true);
    private PickupBackpack() {}

    @Override public String id() { return "sophisticatedbackpacks:backpack/take"; }
    @Override public String kind() { return BLOCK; }
    @Override public boolean installed() { return BackpackAccess.installed(); }
    @Override public boolean block(BlockState state) { return BackpackAccess.isBlock(state); }
    @Override public boolean emptyHand() { return true; }
    @Override public boolean sneaking() { return true; }
    @Override public boolean accepts(ItemStack held) { return false; }

    @Override public void precondition(ServerPlayer player, BlockPos position, BlockState state, ItemStack held) {
        var entity = player.serverLevel().getBlockEntity(position);
        if (!BackpackAccess.isEntity(entity)) throw McbotApi.refuse("INTERACTION_NOT_READY", "这里没有放着的背包");
        String refusal = BackpackRules.refusal(BackpackAccess.unverifiedUpgrades(BackpackAccess.entityWrapper(entity)));
        if (refusal != null) throw McbotApi.refuse("UNSUPPORTED", refusal);
    }

    @Override public Expected expected() { return TAKES; }

    /** The backpack that turned up in a slot that was empty is the same tier as the block that went away. */
    @Override public boolean consistent(JsonObject before, JsonObject after) {
        String placed = before.getAsJsonObject("block").get("id").getAsString();
        Map<Integer, String> was = ids(before);
        for (var entry : ids(after).entrySet())
            if (!entry.getValue().equals(was.getOrDefault(entry.getKey(), "minecraft:air")) && entry.getValue().equals(placed)) return true;
        return false;
    }
    private static Map<Integer, String> ids(JsonObject snapshot) {
        Map<Integer, String> result = new HashMap<>();
        for (JsonElement entry : snapshot.getAsJsonArray("inventory")) {
            JsonObject stack = entry.getAsJsonObject();
            result.put(stack.get("slot").getAsInt(), stack.get("count").getAsInt() == 0 ? "minecraft:air" : stack.get("id").getAsString());
        }
        return result;
    }
}
