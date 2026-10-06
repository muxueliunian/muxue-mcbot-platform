package com.mcbot.addon.kaleidoscopecookery;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * Example MCBOT add-on. Registers the pot interactions with MCBOT; they report themselves as installed only when
 * Kaleidoscope Cookery 1.6.0-neoforge+mc1.21.1 is present, so the add-on is harmless on servers without it.
 */
@Mod("mcbot_kaleidoscope_cookery")
public final class McbotKaleidoscopeCookery {
    public McbotKaleidoscopeCookery() {
        PotInteractions.all().forEach(McbotApi::registerInteraction);
    }
}
