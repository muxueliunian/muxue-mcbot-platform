package com.mcbot.addon.yessteve;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * Example MCBOT add-on for Yes Steve Model: the hosting person picks the bot's model, and the agent plays the model's
 * animations through the emote action. Both report themselves as installed only with Yes Steve Model 2.6.5, so the
 * add-on is harmless on servers without it.
 */
@Mod("mcbot_yes_steve_model")
public final class McbotYesSteveModel {
    public McbotYesSteveModel() {
        McbotApi.registerAppearance(YsmModels.INSTANCE);
        McbotApi.registerEmotes(YsmAnimations.INSTANCE);
    }
}