package com.mcbot.addon.kaleidoscopecookery;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.ItemInteraction.Expected;
import java.util.List;
import java.util.Set;

/**
 * The pot's rules as verified against Kaleidoscope Cookery 1.6.0 (PotBlock#useItemOn, PotBlockEntity), on plain
 * summaries so they can be checked without a running game. Summary fields:
 * status, inputs, capacity, stirsLeft, secondsLeft, result, resultCount, carrier, heat, hasOil.
 */
final class PotRules {
    private PotRules() {}
    static final String PUT_INGREDIENT = "put_ingredient", COOKING = "cooking", FINISHED = "finished", BURNT = "burnt";

    static String statusName(int status) {
        return switch(status) { case 0 -> PUT_INGREDIENT; case 1 -> COOKING; case 2 -> FINISHED; case 3 -> BURNT; default -> "unknown"; };
    }

    static JsonObject summary(int status, List<String> inputs, int capacity, int stirsLeft, int ticksLeft, String result, int resultCount, String carrier, boolean heat, boolean hasOil) {
        JsonObject o = new JsonObject();
        o.addProperty("status", statusName(status));
        JsonArray list = new JsonArray(); inputs.forEach(list::add); o.add("inputs", list);
        o.addProperty("capacity", capacity);
        o.addProperty("stirsLeft", stirsLeft);
        o.addProperty("secondsLeft", (ticksLeft + 19) / 20);
        o.addProperty("result", result);
        o.addProperty("resultCount", resultCount);
        o.addProperty("carrier", carrier);
        o.addProperty("heat", heat);
        o.addProperty("hasOil", hasOil);
        return o;
    }

    private static String status(JsonObject s) { return s.get("status").getAsString(); }
    private static int inputs(JsonObject s) { return s.getAsJsonArray("inputs").size(); }
    private static int stirs(JsonObject s) { return s.get("stirsLeft").getAsInt(); }
    private static boolean heat(JsonObject s) { return s.get("heat").getAsBoolean(); }
    private static boolean oil(JsonObject s) { return s.get("hasOil").getAsBoolean(); }

    // --- Preconditions: why the pot is not ready for this step, or null. Mirrors the order in PotBlock#useItemOn. ---

    static String addOilRefusal(JsonObject s) {
        if (!status(s).equals(PUT_INGREDIENT)) return "The pot is " + status(s) + "; take the dish out first";
        if (oil(s)) return "The pot already has oil; add ingredients next";
        if (!heat(s)) return "The pot needs a lit heat source below it (lit stove or campfire, fire, lava, magma block)";
        return null;
    }
    static String addIngredientRefusal(JsonObject s) {
        if (!status(s).equals(PUT_INGREDIENT)) return "The pot is " + status(s) + "; ingredients can only be added before stirring starts";
        if (!heat(s)) return "The pot needs a lit heat source below it";
        if (!oil(s)) return "Add oil first";
        if (inputs(s) >= s.get("capacity").getAsInt()) return "The pot is full; stir to start cooking";
        return null;
    }
    static String stirRefusal(JsonObject s) {
        if (!heat(s)) return "The pot needs a lit heat source below it";
        if (!oil(s)) return "Add oil first";
        if (status(s).equals(PUT_INGREDIENT) && inputs(s) == 0) return "The pot is empty; add ingredients first";
        if (status(s).equals(COOKING) && stirs(s) == 0) return "No stirring left; wait " + s.get("secondsLeft").getAsInt() + "s, then take the dish out";
        if (status(s).equals(FINISHED) || status(s).equals(BURNT)) return "Cooking is over; take the dish out";
        return null;
    }
    /** Only the finished dish is taken out with its carrier; burnt food and carrier-less dishes are not this interaction. */
    static String takeOutRefusal(JsonObject s, boolean carrierMatches, int heldCount) {
        if (status(s).equals(COOKING)) return "Still cooking: " + s.get("secondsLeft").getAsInt() + "s left" + (stirs(s) > 0 ? ", and " + stirs(s) + " stirs still needed" : "");
        if (status(s).equals(BURNT)) return "The dish is burnt; this adapter does not take out burnt food";
        if (!status(s).equals(FINISHED)) return "Nothing is cooked yet";
        if (s.get("carrier").getAsString().isEmpty()) return "This dish is taken out by sneaking with the kitchen shovel, which this adapter does not support";
        if (!carrierMatches) return "Hold " + s.get("carrier").getAsString() + " to take the dish out";
        if (heldCount < s.get("resultCount").getAsInt()) return "Need " + s.get("resultCount").getAsInt() + " " + s.get("carrier").getAsString();
        return null;
    }

    // --- Effect envelopes (secondsLeft is a countdown and may differ between the two snapshots) ---

    static final Expected ADD_OIL = new Expected(1, 1, false, Set.of("has_oil", "show_oil"), Set.of("hasOil", "secondsLeft"), Set.of(), false);
    static final Expected ADD_INGREDIENT = new Expected(1, 1, false, Set.of(), Set.of("inputs", "secondsLeft"), Set.of(), false);
    /** A stir may start cooking (status, dish, carrier, timer) and wears the shovel by chance. */
    static final Expected STIR = new Expected(0, 0, true, Set.of(), Set.of("status", "stirsLeft", "secondsLeft", "result", "resultCount", "carrier"), Set.of(), false);
    static Expected takeOut(JsonObject before) {
        int count = before.get("resultCount").getAsInt();
        return new Expected(count, count, false, Set.of("has_oil", "show_oil"),
            Set.of("status", "inputs", "stirsLeft", "secondsLeft", "result", "resultCount", "carrier", "hasOil"), Set.of(before.get("result").getAsString()), false);
    }

    // --- Value checks on the two summaries ---

    static boolean addIngredientConsistent(JsonObject b, JsonObject a) { return inputs(a) == inputs(b) + 1 && status(a).equals(PUT_INGREDIENT); }
    static boolean stirConsistent(JsonObject b, JsonObject a) {
        if (status(b).equals(PUT_INGREDIENT)) return status(a).equals(COOKING) && stirs(a) >= 0;
        return status(b).equals(COOKING) && status(a).equals(COOKING) && stirs(a) == stirs(b) - 1;
    }
    static boolean takeOutConsistent(JsonObject b, JsonObject a) { return status(a).equals(PUT_INGREDIENT) && inputs(a) == 0 && a.get("result").getAsString().isEmpty(); }
}
