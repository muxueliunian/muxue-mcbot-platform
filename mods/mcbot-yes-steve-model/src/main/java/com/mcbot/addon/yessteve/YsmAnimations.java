package com.mcbot.addon.yessteve;

import com.mcbot.servercontrol.api.EmoteSource;
import com.mcbot.servercontrol.api.McbotApi;
import net.minecraft.server.level.ServerPlayer;

/**
 * The current YSM model's animations, played with {@code ysm play}. YSM cannot tell which animations a model has
 * (and says nothing when one is missing), so any well-formed name is tried; {@code idle} ends a looping one.
 */
final class YsmAnimations implements EmoteSource {
    static final YsmAnimations INSTANCE = new YsmAnimations();

    @Override public String id() { return "yes_steve_model:animation"; }
    @Override public boolean installed() { return McbotApi.versionsMatch(YsmCommands.MOD, YsmCommands.VERSION); }
    @Override public String hint() {
        return "Yes Steve Model animations of the body's current model; the emote wheel ones are usually extra0..extra7. A missing animation just shows nothing.";
    }
    @Override public boolean accepts(String name) { return YsmCommands.animation(name); }
    @Override public void play(ServerPlayer body, String name) {
        Ysm.run(body.getServer(), YsmCommands.play(body.getGameProfile().getName(), name));
    }
    @Override public void stop(ServerPlayer body) {
        if (body.getServer() != null) Ysm.run(body.getServer(), YsmCommands.play(body.getGameProfile().getName(), "idle"));
    }
}