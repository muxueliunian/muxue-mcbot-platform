package com.mcbot.servercontrol.api;

import net.minecraft.server.level.ServerPlayer;

/**
 * Body animations another mod provides, such as a player-model mod's animations. The agent plays one with the
 * {@code emote} action by naming this source and an animation.
 *
 * <p>MCBOT calls {@link #play} on the server thread when the action starts and {@link #stop} when the requested time is
 * up, when the body starts another action, or when control ends, so a looping animation never keeps playing while the
 * body walks away. Names reach {@link #accepts} only after MCBOT checked them against {@code [A-Za-z0-9_.:-]{1,64}}.</p>
 */
public interface EmoteSource {
    /** Stable id the agent passes as {@code source}, e.g. {@code yes_steve_model:animation}. */
    String id();

    /** True only when the adapted mod is present at exactly the verified version ({@link McbotApi#versionsMatch}). */
    boolean installed();

    /** One short line for the agent: what this source plays and which names are worth trying. */
    default String hint() { return ""; }

    /** Whether this animation name can be played at all. A source that cannot list its animations may accept any name. */
    boolean accepts(String name);

    /** Starts the animation on the body. Throw {@link McbotApi#refuse} to report why it cannot play. */
    void play(ServerPlayer body, String name);

    /** Ends whatever this source is playing on the body. Must be safe to call when nothing plays. */
    void stop(ServerPlayer body);
}
