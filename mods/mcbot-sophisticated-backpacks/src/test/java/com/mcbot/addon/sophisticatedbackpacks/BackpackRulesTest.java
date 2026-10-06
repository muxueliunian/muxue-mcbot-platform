package com.mcbot.addon.sophisticatedbackpacks;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Offline checks of the backpack layout, upgrade and storage-id rules; no Minecraft launch. */
final class BackpackRulesTest {
    private static int checks;
    private static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }

    private static List<BackpackRules.SlotView> layout(Object handler, int size, Object inventory) {
        List<BackpackRules.SlotView> slots = new ArrayList<>();
        Object placeholder = new Object();
        for (int i = 0; i < size; i++) slots.add(new BackpackRules.SlotView(BackpackAccess.STORAGE_SLOT, handler, placeholder, i));
        for (int i = 9; i < 36; i++) slots.add(new BackpackRules.SlotView("net.minecraft.world.inventory.Slot", null, inventory, i));
        for (int i = 0; i < 9; i++) slots.add(new BackpackRules.SlotView(i == 3 ? "net.p3pp3rf1y.sophisticatedcore.common.gui.StorageContainerMenuBase$2" : "net.minecraft.world.inventory.Slot", null, inventory, i));
        slots.add(new BackpackRules.SlotView("net.p3pp3rf1y.sophisticatedbackpacks.common.gui.BackpackContainer$BackpackUpgradeSlot", new Object(), placeholder, 0));
        return slots;
    }
    private static JsonObject snapshot(String... stacks) {
        JsonArray inventory = new JsonArray();
        for (String stack : stacks) inventory.add(JsonParser.parseString(stack));
        JsonObject snapshot = new JsonObject();
        snapshot.add("inventory", inventory);
        return snapshot;
    }

    public static void main(String[] args) {
        Object handler = new Object(), inventory = new Object();
        check(BackpackRules.layout(layout(handler, 27, inventory), handler, 27, inventory), "storage slots, player slots (with the locked backpack slot) and trailing upgrade slots form the verified layout");
        check(!BackpackRules.layout(layout(handler, 27, inventory), new Object(), 27, inventory), "another handler is not this backpack");
        check(!BackpackRules.layout(layout(handler, 27, inventory), handler, 36, inventory), "a different storage size is refused");
        check(!BackpackRules.layout(layout(handler, 27, inventory), handler, 27, new Object()), "player slots must wrap this player's inventory");
        var swapped = layout(handler, 27, inventory);
        var first = swapped.get(0);
        swapped.set(0, swapped.get(1)); swapped.set(1, first);
        check(!BackpackRules.layout(swapped, handler, 27, inventory), "storage slots out of native order are refused");
        var foreign = layout(handler, 27, inventory);
        foreign.set(5, new BackpackRules.SlotView("net.neoforged.neoforge.items.SlotItemHandler", handler, new Object(), 5));
        check(!BackpackRules.layout(foreign, handler, 27, inventory), "a storage slot of another class is refused");
        var duplicate = layout(handler, 27, inventory);
        duplicate.set(28, duplicate.get(27));
        check(!BackpackRules.layout(duplicate, handler, 27, inventory), "a player slot mapped twice is refused");
        check(!BackpackRules.layout(layout(handler, 27, inventory).subList(0, 40), handler, 27, inventory), "a truncated menu is refused");
        check(!BackpackRules.layout(layout(handler, 0, inventory), handler, 0, inventory), "an empty storage is not a container");

        check(BackpackRules.refusal(Set.of()) == null, "no unverified upgrades: allowed");
        String refused = BackpackRules.refusal(Set.of("sophisticatedbackpacks:void_upgrade"));
        check(refused != null && refused.contains("void_upgrade"), "an unverified upgrade is named in the refusal");
        check(BackpackAccess.VERIFIED_UPGRADES.equals(Set.of("sophisticatedbackpacks:pickup_upgrade", "sophisticatedbackpacks:advanced_pickup_upgrade")), "only the pickup upgrades are verified");

        String fresh = "{\"slot\":3,\"id\":\"sophisticatedbackpacks:backpack\",\"count\":1,\"components\":{}}";
        String opened = "{\"slot\":3,\"id\":\"sophisticatedbackpacks:backpack\",\"count\":1,\"components\":{\"sophisticatedcore:storage_uuid\":{\"type\":\"uuid\",\"value\":\"a\"}}}";
        String other = "{\"slot\":3,\"id\":\"sophisticatedbackpacks:backpack\",\"count\":1,\"components\":{\"sophisticatedcore:storage_uuid\":{\"type\":\"uuid\",\"value\":\"b\"}}}";
        String dirt = "{\"slot\":5,\"id\":\"minecraft:dirt\",\"count\":4,\"components\":{}}";
        check(BackpackRules.openKeepsStorageIds(snapshot(fresh, dirt), snapshot(opened, dirt)), "first open may assign the storage id");
        check(BackpackRules.openKeepsStorageIds(snapshot(opened, dirt), snapshot(opened, dirt)), "reopening changes nothing");
        String bookkept = "{\"slot\":3,\"id\":\"sophisticatedbackpacks:backpack\",\"count\":1,\"components\":{\"sophisticatedcore:storage_uuid\":{\"type\":\"uuid\",\"value\":\"a\"},\"sophisticatedcore:number_of_inventory_slots\":{\"type\":\"int\",\"value\":27},\"sophisticatedcore:render_info_tag\":{\"type\":\"compound\",\"value\":{}}}}";
        check(BackpackRules.openKeepsStorageIds(snapshot(fresh), snapshot(bookkept)), "first open may also write slot counts and the render cache");
        check(BackpackRules.openKeepsStorageIds(snapshot(bookkept), snapshot(opened)), "reopening may refresh the bookkeeping while the storage id stays");
        check(!BackpackRules.openKeepsStorageIds(snapshot(fresh), snapshot(bookkept.replace("\"sophisticatedcore:storage_uuid\":{\"type\":\"uuid\",\"value\":\"a\"},", ""))), "bookkeeping alone without a storage id is not an open");
        check(!BackpackRules.openKeepsStorageIds(snapshot(opened), snapshot(other)), "an existing storage id must never change");
        check(!BackpackRules.openKeepsStorageIds(snapshot(opened), snapshot(fresh)), "a storage id must never disappear");
        String renamed = "{\"slot\":3,\"id\":\"sophisticatedbackpacks:backpack\",\"count\":1,\"components\":{\"sophisticatedcore:storage_uuid\":{\"type\":\"uuid\",\"value\":\"a\"},\"minecraft:custom_name\":{\"type\":\"string\",\"value\":\"x\"}}}";
        check(!BackpackRules.openKeepsStorageIds(snapshot(fresh), snapshot(renamed)), "other components may not change with the storage id");
        check(!BackpackRules.openKeepsStorageIds(snapshot(fresh, dirt), snapshot(opened)), "a vanished stack is not a storage id change");
        check(!BackpackRules.openKeepsStorageIds(snapshot(dirt), snapshot("{\"slot\":5,\"id\":\"minecraft:dirt\",\"count\":4,\"components\":{\"sophisticatedcore:storage_uuid\":{\"type\":\"uuid\",\"value\":\"a\"}}}")), "only backpacks may gain a storage id");

        System.out.println("BackpackRulesTest: " + checks + " checks passed (layout, upgrades, storage ids; no Minecraft launch)");
    }
}
