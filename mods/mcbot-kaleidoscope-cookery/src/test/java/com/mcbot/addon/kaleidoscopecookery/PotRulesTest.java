package com.mcbot.addon.kaleidoscopecookery;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Set;

/** Offline checks of the pot rules on summaries; no Minecraft launch, no Kaleidoscope Cookery classes. */
final class PotRulesTest {
    private static int checks;
    private static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
    private static JsonObject pot(int status, List<String> inputs, int stirs, int ticks, String result, String carrier, boolean heat, boolean oil) {
        return PotRules.summary(status, inputs, 9, stirs, ticks, result, result.isEmpty() ? 0 : 1, carrier, heat, oil);
    }
    private static final List<String> NONE = List.of(), PORK = List.of("minecraft:sugar", "minecraft:sugar", "minecraft:sugar", "minecraft:porkchop", "minecraft:porkchop", "minecraft:porkchop");

    public static void main(String[] ignored) {
        JsonObject cold = pot(0, NONE, 0, 0, "", "", false, false), empty = pot(0, NONE, 0, 0, "", "", true, false), oiled = pot(0, NONE, 0, 1200, "", "", true, true);
        JsonObject filled = pot(0, PORK, 0, 900, "", "", true, true);
        JsonObject cooking = pot(1, PORK, 2, 180, "kaleidoscope_cookery:sweet_and_sour_pork", "minecraft:bowl", true, true);
        JsonObject stirred = pot(1, PORK, 0, 120, "kaleidoscope_cookery:sweet_and_sour_pork", "minecraft:bowl", true, true);
        JsonObject done = pot(2, PORK, 0, 800, "kaleidoscope_cookery:sweet_and_sour_pork", "minecraft:bowl", true, true);
        JsonObject burnt = pot(3, PORK, 0, 300, "kaleidoscope_cookery:sweet_and_sour_pork", "minecraft:bowl", true, true);

        check(oiled.get("secondsLeft").getAsInt() == 60 && pot(0, NONE, 0, 1, "", "", true, true).get("secondsLeft").getAsInt() == 1, "ticks round up to whole seconds");
        check(PotRules.statusName(2).equals("finished") && PotRules.statusName(9).equals("unknown"), "status names");

        // Oil
        check(PotRules.addOilRefusal(cold).contains("heat source"), "no oil without heat (the pot would refuse anyway)");
        check(PotRules.addOilRefusal(empty) == null, "hot empty pot takes oil");
        check(PotRules.addOilRefusal(oiled).contains("already has oil"), "second oil refused");
        check(PotRules.addOilRefusal(done).contains("finished"), "no oil while a dish waits");
        // Ingredients
        check(PotRules.addIngredientRefusal(empty).contains("oil first"), "ingredients need oil");
        check(PotRules.addIngredientRefusal(oiled) == null && PotRules.addIngredientRefusal(filled) == null, "ingredients go in before stirring");
        check(PotRules.addIngredientRefusal(PotRules.summary(0, PORK, 6, 0, 900, "", 0, "", true, true)).contains("full"), "full pot refused");
        check(PotRules.addIngredientRefusal(cooking).contains("cooking"), "no ingredients once cooking");
        check(PotRules.addIngredientConsistent(oiled, pot(0, List.of("minecraft:sugar"), 0, 1200, "", "", true, true)), "one more input");
        check(!PotRules.addIngredientConsistent(oiled, oiled), "unchanged inputs are not a success");
        // Stirring
        check(PotRules.stirRefusal(oiled).contains("empty"), "stirring an empty pot does nothing");
        check(PotRules.stirRefusal(filled) == null && PotRules.stirRefusal(cooking) == null, "stir starts and continues cooking");
        check(PotRules.stirRefusal(stirred).contains("wait 6s"), "no stirs left: told how long to wait");
        check(PotRules.stirRefusal(done).contains("over"), "no stirring after cooking");
        check(PotRules.stirConsistent(filled, cooking), "first stir starts cooking");
        check(PotRules.stirConsistent(cooking, pot(1, PORK, 1, 170, "kaleidoscope_cookery:sweet_and_sour_pork", "minecraft:bowl", true, true)), "stir counts down by one");
        check(!PotRules.stirConsistent(cooking, cooking), "a stir that changed nothing is not a success");
        check(!PotRules.stirConsistent(cooking, pot(1, PORK, 0, 170, "x", "minecraft:bowl", true, true)), "skipping a count is not a success");
        // Taking out
        check(PotRules.takeOutRefusal(cooking, true, 1).contains("2 stirs still needed"), "still cooking: says what is missing");
        check(PotRules.takeOutRefusal(burnt, true, 1).contains("burnt"), "burnt food is not this interaction");
        check(PotRules.takeOutRefusal(done, false, 1).contains("Hold minecraft:bowl"), "wrong hand: names the carrier");
        check(PotRules.takeOutRefusal(done, true, 1) == null, "finished dish with a bowl");
        check(PotRules.takeOutRefusal(pot(2, PORK, 0, 800, "kaleidoscope_cookery:sticky_candy", "", true, true), true, 1).contains("not support"), "carrier-less dishes refused");
        var envelope = PotRules.takeOut(done);
        check(envelope.minConsumed() == 1 && envelope.maxConsumed() == 1 && envelope.gainedItems().equals(Set.of("kaleidoscope_cookery:sweet_and_sour_pork")), "take-out envelope comes from the dish before the click");
        check(PotRules.takeOutConsistent(done, pot(0, NONE, 0, 0, "", "", true, false)), "pot resets after take-out");
        check(!PotRules.takeOutConsistent(done, done), "pot still full is not a success");
        check(PotRules.STIR.heldDamageAllowed() && !PotRules.ADD_OIL.heldDamageAllowed() && PotRules.ADD_OIL.properties().contains("has_oil"), "fixed envelopes");
        check(McbotKaleidoscopeCookery.HINT.length()<=com.mcbot.servercontrol.api.McbotApi.HINT_MAX&&McbotKaleidoscopeCookery.HINT.chars().noneMatch(Character::isISOControl),"usage hint fits the core limit as plain text");
        check(SeatRules.seatBlock("kaleidoscope_cookery:chair_oak", SeatRules.CHAIR_CLASS) && SeatRules.seatBlock("kaleidoscope_cookery:cook_stool_birch", SeatRules.STOOL_CLASS), "chairs and cook stools are seats");
        check(!SeatRules.seatBlock("kaleidoscope_cookery:pot", PotAccess.BLOCK_CLASS) && !SeatRules.seatBlock("minecraft:oak_stairs", "net.minecraft.world.level.block.StairBlock"), "pots and vanilla stairs are not seats");
        check(!SeatRules.seatBlock("othermod:chair", SeatRules.CHAIR_CLASS) && !SeatRules.seatBlock("kaleidoscope_cookery:chair_oak", SeatRules.CHAIR_CLASS + "Sub") && !SeatRules.seatBlock(null, SeatRules.CHAIR_CLASS), "another namespace or an unverified class is no seat");
        check(SeatRules.seatEntity(SeatRules.SIT_ENTITY_CLASS) && !SeatRules.seatEntity("net.minecraft.world.entity.vehicle.Boat"), "only the verified SitEntity is a seat entity");
        System.out.println("PotRulesTest: " + checks + " checks passed (pot rules on summaries; no Minecraft launch)");
    }
}
