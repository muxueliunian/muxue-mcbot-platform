package com.mcbot.addon.sophisticatedbackpacks;

import com.mcbot.servercontrol.api.McbotApi;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.items.IItemHandler;

/**
 * Reflective view of Sophisticated Backpacks. Every name below was checked against Sophisticated Backpacks 3.25.77 with
 * Sophisticated Core 1.4.86; if any is missing the adapter reports itself as not installed rather than guessing.
 */
final class BackpackAccess {
    private BackpackAccess() {}
    static final String MOD = "sophisticatedbackpacks", VERSION = "3.25.77", CORE = "sophisticatedcore", CORE_VERSION = "1.4.86";
    private static final String PACKAGE = "net.p3pp3rf1y.sophisticatedbackpacks.";
    static final String BLOCK_CLASS = PACKAGE + "backpack.BackpackBlock", ENTITY_CLASS = PACKAGE + "backpack.BackpackBlockEntity",
        ITEM_CLASS = PACKAGE + "backpack.BackpackItem", MENU_CLASS = PACKAGE + "common.gui.BackpackContainer",
        ITEM_CONTEXT = PACKAGE + "common.gui.BackpackContext$Item", BLOCK_CONTEXT = PACKAGE + "common.gui.BackpackContext$Block",
        WRAPPER_CLASS = PACKAGE + "backpack.wrapper.BackpackWrapper",
        STORAGE_SLOT = "net.p3pp3rf1y.sophisticatedcore.common.gui.StorageContainerMenuBase$1",
        MENU_BASE = "net.p3pp3rf1y.sophisticatedcore.common.gui.StorageContainerMenuBase";
    /** The six backpack tiers; the same ids name the item and the placed block. */
    static final Set<String> BACKPACKS = Set.of("sophisticatedbackpacks:backpack", "sophisticatedbackpacks:copper_backpack",
        "sophisticatedbackpacks:iron_backpack", "sophisticatedbackpacks:gold_backpack", "sophisticatedbackpacks:diamond_backpack",
        "sophisticatedbackpacks:netherite_backpack");
    /**
     * Upgrades whose effect MCBOT can account for. Stack upgrades change slot limits, void/compacting/feeding/magnet and
     * the rest act on their own; a backpack holding any of them is refused.
     */
    static final Set<String> VERIFIED_UPGRADES = Set.of("sophisticatedbackpacks:pickup_upgrade", "sophisticatedbackpacks:advanced_pickup_upgrade");
    static final String STORAGE_UUID = "sophisticatedcore:storage_uuid";
    /** Derived bookkeeping Sophisticated Core writes onto the stack when the backpack is opened (slot counts, render cache). */
    static final Set<String> BOOKKEEPING = Set.of("sophisticatedcore:number_of_inventory_slots", "sophisticatedcore:number_of_upgrade_slots", "sophisticatedcore:render_info_tag");

    private record Members(Method context, Method menuWrapper, Method entityWrapper, Method existingData, Method inventory,
                           Method upgrades, Method contentsUuid, Method slotIndex, Field handlerName, Field menuPlayer,
                           Constructor<?> blockContext, Constructor<?> menu) {}
    private static volatile Members members;
    private static volatile boolean broken;

    static boolean installed() { return McbotApi.versionsMatch(MOD, VERSION) && McbotApi.versionsMatch(CORE, CORE_VERSION) && !broken && members() != null; }

    private static Members members() {
        Members known = members;
        if (known != null || broken) return known;
        try {
            Class<?> menu = Class.forName(MENU_CLASS), base = Class.forName(MENU_BASE), entity = Class.forName(ENTITY_CLASS),
                wrapper = Class.forName(WRAPPER_CLASS), storage = Class.forName("net.p3pp3rf1y.sophisticatedcore.api.IStorageWrapper"),
                context = Class.forName(PACKAGE + "common.gui.BackpackContext"), item = Class.forName(ITEM_CONTEXT), block = Class.forName(BLOCK_CONTEXT);
            Field handlerName = item.getDeclaredField("handlerName"), player = base.getDeclaredField("player");
            handlerName.setAccessible(true); player.setAccessible(true);
            known = new Members(menu.getMethod("getBackpackContext"), base.getMethod("getStorageWrapper"), entity.getMethod("getBackpackWrapper"),
                wrapper.getMethod("fromExistingData", ItemStack.class), storage.getMethod("getInventoryHandler"), storage.getMethod("getUpgradeHandler"),
                storage.getMethod("getContentsUuid"), item.getMethod("getBackpackSlotIndex"), handlerName, player, block.getConstructor(BlockPos.class),
                menu.getConstructor(int.class, Player.class, context));
            members = known;
            return known;
        } catch (ReflectiveOperationException | LinkageError | RuntimeException changed) {
            broken = true;
            return null;
        }
    }
    private static Members require() {
        Members known = members();
        if (known == null) throw new IllegalStateException("Sophisticated Backpacks members changed");
        return known;
    }
    private static Object call(Method method, Object target, Object... args) {
        try { return method.invoke(target, args); }
        catch (ReflectiveOperationException failed) { throw new IllegalStateException("Sophisticated Backpacks call failed: " + method.getName(), failed); }
    }

    static boolean isBlock(BlockState state) {
        return BACKPACKS.contains(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString()) && BLOCK_CLASS.equals(state.getBlock().getClass().getName());
    }
    static boolean isEntity(BlockEntity entity) { return entity != null && ENTITY_CLASS.equals(entity.getClass().getName()); }
    static boolean isBackpack(ItemStack stack) {
        return !stack.isEmpty() && BACKPACKS.contains(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString()) && ITEM_CLASS.equals(stack.getItem().getClass().getName());
    }
    static boolean isMenu(AbstractContainerMenu menu) { return menu != null && MENU_CLASS.equals(menu.getClass().getName()); }

    /** "item" (opened from a hotbar slot), "block" (placed) or null for anything else, e.g. a backpack inside a backpack. */
    static String contextKind(AbstractContainerMenu menu) {
        Members m = require();
        Object context = call(m.context(), menu);
        if (context == null) return null;
        String type = context.getClass().getName();
        if (BLOCK_CONTEXT.equals(type)) return "block";
        if (!ITEM_CONTEXT.equals(type)) return null;
        try {
            int slot = (int) call(m.slotIndex(), context);
            return "main".equals(m.handlerName().get(context)) && slot >= 0 && slot <= 8 ? "item" : null;
        } catch (IllegalAccessException failed) { throw new IllegalStateException(failed); }
    }
    static Player menuPlayer(AbstractContainerMenu menu) {
        try { return (Player) require().menuPlayer().get(menu); }
        catch (IllegalAccessException failed) { throw new IllegalStateException(failed); }
    }
    static Object menuWrapper(AbstractContainerMenu menu) { return call(require().menuWrapper(), menu); }
    static Object entityWrapper(BlockEntity entity) { return call(require().entityWrapper(), entity); }
    /** The wrapper of a backpack stack that already has storage; empty for a backpack never opened (no contents yet). */
    static Optional<?> stackWrapper(ItemStack stack) { return (Optional<?>) call(require().existingData(), null, stack); }
    static IItemHandler inventory(Object wrapper) { return (IItemHandler) call(require().inventory(), wrapper); }
    static IItemHandler upgrades(Object wrapper) { return (IItemHandler) call(require().upgrades(), wrapper); }
    /** The storage id shared by every wrapper of the same backpack contents; empty when it has none yet. */
    static Optional<?> contentsUuid(Object wrapper) { return (Optional<?>) call(require().contentsUuid(), wrapper); }

    /** Installed upgrade ids that MCBOT has not verified; empty when every upgrade slot is empty or verified. */
    static Set<String> unverifiedUpgrades(Object wrapper) {
        IItemHandler upgrades = upgrades(wrapper);
        Set<String> result = new java.util.TreeSet<>();
        for (int i = 0; i < upgrades.getSlots(); i++) {
            ItemStack upgrade = upgrades.getStackInSlot(i);
            if (upgrade.isEmpty()) continue;
            String id = BuiltInRegistries.ITEM.getKey(upgrade.getItem()).toString();
            if (!VERIFIED_UPGRADES.contains(id)) result.add(id);
        }
        return result;
    }

    /** Item id to total count across the storage of one wrapper. */
    static void count(Object wrapper, Map<String, Integer> into) {
        IItemHandler inventory = inventory(wrapper);
        for (int i = 0; i < inventory.getSlots(); i++) {
            ItemStack stack = inventory.getStackInSlot(i);
            if (!stack.isEmpty()) into.merge(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), stack.getCount(), Integer::sum);
        }
    }
    static Map<String, Integer> counts(Iterable<ItemStack> carried) {
        Map<String, Integer> result = new HashMap<>();
        for (ItemStack stack : carried) if (isBackpack(stack)) stackWrapper(stack).ifPresent(wrapper -> count(wrapper, result));
        return result;
    }

    /** The native menu Sophisticated Backpacks itself opens for a placed backpack. */
    static AbstractContainerMenu blockMenu(int id, Player player, BlockPos position) {
        Members m = require();
        try { return (AbstractContainerMenu) m.menu().newInstance(id, player, m.blockContext().newInstance(position)); }
        catch (ReflectiveOperationException failed) { throw new IllegalStateException("Sophisticated Backpacks menu could not be created", failed); }
    }
}
