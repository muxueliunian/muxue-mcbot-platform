package com.mcbot.addon.kaleidoscopecookery;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * Example MCBOT add-on. Registers the pot interactions with MCBOT; they report themselves as installed only when
 * Kaleidoscope Cookery 1.6.0-neoforge+mc1.21.1 is present, so the add-on is harmless on servers without it.
 */
@Mod("mcbot_kaleidoscope_cookery")
public final class McbotKaleidoscopeCookery {
    /** Usage note for the agent, sent in hello.hints while the pot interactions are installed (the flow PotRulesTest and the cooking smoke cover). */
    static final String HINT = "Kaleidoscope Cookery wok (kaleidoscope_cookery:pot, needs heat below), with interact-block in this order: "
        + "pot/add_oil holding oil; pot/add_ingredient holding each ingredient, one call per item; pot/stir holding a kitchen shovel with "
        + "repeatUntil {field: stirsLeft, equals: 0} (one call stirs in time); pot/take_out holding the dish's container, e.g. a bowl. "
        + "Receipt summaries show stage, ingredients, stirsLeft, seconds left, result and container; INTERACTION_NOT_READY says what is missing. "
        + "Not supported: burnt dishes, dishes taken out without a container, ingredients that give back a container.";

    public McbotKaleidoscopeCookery() {
        PotInteractions.all().forEach(McbotApi::registerInteraction);
        McbotApi.registerSeat(SeatAccess.INSTANCE);
        McbotApi.registerHint("kaleidoscope_cookery:hint", HINT);
    }
}
