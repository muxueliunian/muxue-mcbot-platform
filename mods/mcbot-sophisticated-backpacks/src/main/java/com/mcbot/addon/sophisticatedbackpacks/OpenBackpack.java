package com.mcbot.addon.sophisticatedbackpacks;

import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Right-click in the air with a backpack in the hotbar: Sophisticated Backpacks opens its menu. Nothing is consumed; a
 * backpack opened for the first time gets its storage id, and Sophisticated Core refreshes its slot counts and render
 * cache on the stack. Those are the only changes allowed on the held stack.
 */
final class OpenBackpack implements ItemInteraction {
    static final OpenBackpack INSTANCE = new OpenBackpack();
    static final Expected OPENS = new Expected(0, 0, false, Set.of(), Set.of(), Set.of(), true, held());
    private static Set<String> held() { Set<String> keys = new java.util.HashSet<>(BackpackAccess.BOOKKEEPING); keys.add(BackpackAccess.STORAGE_UUID); return Set.copyOf(keys); }
    private OpenBackpack() {}

    @Override public String id() { return "sophisticatedbackpacks:backpack/open"; }
    @Override public String kind() { return ITEM; }
    @Override public boolean installed() { return BackpackAccess.installed(); }
    @Override public boolean emptyHand() { return false; }
    @Override public boolean accepts(ItemStack held) { return BackpackAccess.isBackpack(held) && held.getCount() == 1; }

    @Override public void precondition(ServerPlayer player, BlockPos position, BlockState state, ItemStack held) {
        if (player.isShiftKeyDown()) throw McbotApi.refuse("INTERACTION_NOT_READY", "潜行时右键背包不会打开，先站起来");
        var wrapper = BackpackAccess.stackWrapper(held);
        if (wrapper.isEmpty()) return; // never opened: no contents and no upgrades yet
        String refusal = BackpackRules.refusal(BackpackAccess.unverifiedUpgrades(wrapper.get()));
        if (refusal != null) throw McbotApi.refuse("UNSUPPORTED", refusal);
    }

    @Override public Expected expected() { return OPENS; }

    @Override public boolean consistent(JsonObject before, JsonObject after) { return BackpackRules.openKeepsStorageIds(before, after); }

    @Override public boolean menu(AbstractContainerMenu menu) {
        return BackpackContainerAdapter.INSTANCE.menu(menu) && "item".equals(BackpackAccess.contextKind(menu))
            && BackpackContainerAdapter.INSTANCE.storage(menu, BackpackAccess.menuPlayer(menu).getInventory()) != null;
    }
}
