package com.mcbot.addon.kaleidoscopecookery;

import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
import java.util.List;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/** The four steps of one stir-fry: add oil, add ingredients, stir, take the dish out with its carrier. */
final class PotInteractions {
    private PotInteractions() {}

    private interface Refusal { String why(JsonObject summary, ServerPlayer player, BlockPos position, ItemStack held); }

    private record Step(String id, Predicate<ItemStack> held, Refusal refusal, Expected fixed, BiPredicate<JsonObject, JsonObject> check) implements ItemInteraction {
        public String kind() { return BLOCK; }
        public boolean installed() { return PotAccess.installed(); }
        public boolean block(BlockState state) { return PotAccess.isPot(state); }
        public boolean emptyHand() { return false; }
        public boolean accepts(ItemStack stack) { return held.test(stack); }
        public void precondition(ServerPlayer player, BlockPos position, BlockState state, ItemStack stack) {
            String why = refusal.why(PotAccess.read(player.serverLevel(), position), player, position, stack);
            if (why != null) throw McbotApi.refuse("INTERACTION_NOT_READY", why);
        }
        public JsonObject summary(ServerPlayer player, BlockPos position) { return PotAccess.read(player.serverLevel(), position); }
        /** Without a concrete pot state nothing is allowed; MCBOT uses {@link #expectedFor} for every real use. */
        public Expected expected() { return fixed != null ? fixed : new Expected(0, 0, false, Set.of(), Set.of(), Set.of(), false); }
        public Expected expectedFor(JsonObject before) { return fixed != null ? fixed : PotRules.takeOut(before); }
        /** MCBOT passes whole snapshots; the pot rules work on the adapter summaries inside them. */
        public boolean consistent(JsonObject before, JsonObject after) { return check.test(before.getAsJsonObject("summary"), after.getAsJsonObject("summary")); }
    }

    static final ItemInteraction ADD_OIL = new Step("kaleidoscope_cookery:pot/add_oil", s -> s.is(PotAccess.OIL),
        (s, p, pos, h) -> PotRules.addOilRefusal(s), PotRules.ADD_OIL, (b, a) -> a.get("hasOil").getAsBoolean());
    static final ItemInteraction ADD_INGREDIENT = new Step("kaleidoscope_cookery:pot/add_ingredient", PotAccess::plainIngredient,
        (s, p, pos, h) -> PotRules.addIngredientRefusal(s), PotRules.ADD_INGREDIENT, PotRules::addIngredientConsistent);
    static final ItemInteraction STIR = new Step("kaleidoscope_cookery:pot/stir", s -> s.is(PotAccess.SHOVEL),
        (s, p, pos, h) -> PotRules.stirRefusal(s), PotRules.STIR, PotRules::stirConsistent);
    /** The dish depends on the recipe, so the envelope (consumed carriers, gained dish) comes from the summary before the click. */
    static final ItemInteraction TAKE_OUT = new Step("kaleidoscope_cookery:pot/take_out", s -> !s.isEmpty(),
        (s, p, pos, h) -> PotRules.takeOutRefusal(s, PotAccess.carrierMatches(p.serverLevel(), pos, h), h.getCount()), null, PotRules::takeOutConsistent);

    static List<ItemInteraction> all() { return List.of(ADD_OIL, ADD_INGREDIENT, STIR, TAKE_OUT); }
}
