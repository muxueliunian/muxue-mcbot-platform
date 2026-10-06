package com.mcbot.addon.sophisticatedbackpacks;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Pure checks behind the adapter, kept free of Minecraft and Sophisticated Backpacks types so they can be tested offline. */
final class BackpackRules {
    private BackpackRules() {}

    /** One menu slot as the layout check sees it. */
    record SlotView(String className, Object handler, Object container, int index) {}

    /**
     * The verified BackpackContainer layout: storage slots 0..size-1 are Sophisticated Core storage slots of exactly this
     * handler in order, followed by the 36 player inventory slots. Upgrade and other extra slots after that are left
     * unknown and never clicked.
     */
    static boolean layout(List<SlotView> slots, Object handler, int size, Object inventory) {
        if (handler == null || size <= 0 || slots.size() < size + 36) return false;
        for (int i = 0; i < size; i++) {
            SlotView slot = slots.get(i);
            if (!BackpackAccess.STORAGE_SLOT.equals(slot.className()) || slot.handler() != handler || slot.index() != i) return false;
        }
        boolean[] seen = new boolean[36];
        for (int i = size; i < size + 36; i++) {
            SlotView slot = slots.get(i);
            if (slot.container() != inventory || slot.index() < 0 || slot.index() >= 36 || seen[slot.index()]) return false;
            seen[slot.index()] = true;
        }
        return true;
    }

    /** Why a backpack may not be opened or used as a container, or null when it may. */
    static String refusal(Set<String> unverifiedUpgrades) {
        if (!unverifiedUpgrades.isEmpty()) return "背包装了 MCBOT 没验证过的升级：" + String.join(", ", unverifiedUpgrades) + "（只支持拾取升级）";
        return null;
    }

    /**
     * Opening may give a backpack its storage id the first time and refresh the derived bookkeeping components; it must
     * never change an existing storage id or touch any other stack. Snapshots are whole interaction snapshots
     * ({@code inventory} entries with {@code slot}, {@code id},
     * {@code components}).
     */
    static boolean openKeepsStorageIds(JsonObject before, JsonObject after) {
        Map<Integer, JsonObject> b = slots(before), a = slots(after);
        if (!b.keySet().equals(a.keySet())) return false;
        for (int slot : b.keySet()) {
            JsonObject x = b.get(slot), y = a.get(slot);
            if (x.equals(y)) continue;
            if (!Objects.equals(x.get("id"), y.get("id")) || !Objects.equals(x.get("count"), y.get("count"))) return false;
            if (!BackpackAccess.BACKPACKS.contains(x.get("id").getAsString())) return false;
            JsonObject cx = components(x), cy = components(y);
            if (cx.has(BackpackAccess.STORAGE_UUID) ? !cx.get(BackpackAccess.STORAGE_UUID).equals(cy.get(BackpackAccess.STORAGE_UUID)) : !cy.has(BackpackAccess.STORAGE_UUID)) return false;
            JsonObject restBefore = cx.deepCopy(), restAfter = cy.deepCopy();
            for (String key : BackpackAccess.BOOKKEEPING) { restBefore.remove(key); restAfter.remove(key); }
            restBefore.remove(BackpackAccess.STORAGE_UUID); restAfter.remove(BackpackAccess.STORAGE_UUID);
            if (!restBefore.equals(restAfter)) return false;
        }
        return true;
    }
    private static JsonObject components(JsonObject stack) {
        JsonElement value = stack.get("components");
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : new JsonObject();
    }
    private static Map<Integer, JsonObject> slots(JsonObject snapshot) {
        Map<Integer, JsonObject> result = new HashMap<>();
        for (JsonElement entry : snapshot.getAsJsonArray("inventory")) {
            JsonObject stack = entry.getAsJsonObject();
            result.put(stack.get("slot").getAsInt(), stack);
        }
        return result;
    }
}
