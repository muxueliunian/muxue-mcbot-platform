package com.mcbot.addon.sophisticatedbackpacks;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * Example MCBOT add-on for Sophisticated Backpacks: opening a held backpack, placed backpacks as containers, and pickup
 * upgrade accounting. Everything reports itself as installed only with Sophisticated Backpacks 3.25.77 and Sophisticated
 * Core 1.4.86, so the add-on is harmless on servers without them.
 */
@Mod("mcbot_sophisticated_backpacks")
public final class McbotSophisticatedBackpacks {
    public McbotSophisticatedBackpacks() {
        McbotApi.registerContainer(BackpackContainerAdapter.INSTANCE);
        McbotApi.registerInteraction(OpenBackpack.INSTANCE);
        McbotApi.registerPickupSink(BackpackPickupSink.INSTANCE);
    }
}
