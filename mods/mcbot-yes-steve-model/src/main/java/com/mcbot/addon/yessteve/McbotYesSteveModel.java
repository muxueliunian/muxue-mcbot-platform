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
        McbotApi.registerHint("yes_steve_model:hint", HINT);
    }

    /** Usage note for the agent, sent in hello.hints while the add-on is installed (what YsmCommandsTest and the emote smoke cover). */
    static final String HINT = "Yes Steve Model: emote with source yes_steve_model:animation plays an animation of the body's current model "
        + "(the emote wheel ones are usually extra0..extra7) for seconds (default 6); doing anything else stops it, chatting and looking do not. "
        + "YSM gives no feedback: a wrong name shows nothing and succeeded only means the command was sent, so never say you saw it play. "
        + "Only players with YSM installed see it. The model is chosen by the hosting person; you cannot change it.";
}