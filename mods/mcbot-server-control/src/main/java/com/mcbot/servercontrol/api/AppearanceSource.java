package com.mcbot.servercontrol.api;

import java.util.List;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * A way to change how the body looks, such as a player-model mod's models. The person hosting the bot picks one of
 * {@link #choices}; the agent cannot change it. MCBOT applies the pick with the {@code set-appearance} action each
 * time a hosted runtime takes control.
 */
public interface AppearanceSource {
    /** Stable id, e.g. {@code yes_steve_model:model}. */
    String id();

    /** True only when the adapted mod is present at exactly the verified version ({@link McbotApi#versionsMatch}). */
    boolean installed();

    /** What the server owner made available (for example model files in the mod's config folder). Read-only. */
    List<String> choices(MinecraftServer server);

    /** Applies one of {@link #choices} to the body, which is online. Throw {@link McbotApi#refuse} to report a failure. */
    void apply(ServerPlayer body, String choice);
}
