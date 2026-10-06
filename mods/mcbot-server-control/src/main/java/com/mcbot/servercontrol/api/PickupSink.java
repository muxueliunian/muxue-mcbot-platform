package com.mcbot.servercontrol.api;

import java.util.Map;
import net.minecraft.server.level.ServerPlayer;

/**
 * Accounts for items that another mod moves straight from the ground into storage the bot carries (e.g. a backpack's
 * pickup upgrade), cancelling the vanilla pickup so no native pickup event fires.
 *
 * <p>MCBOT reads {@link #stored} before and after the other mods handle the pickup. The absorbed items count as picked
 * up into this sink only when the only change across all sinks is exactly the absorbed item id growing by exactly the
 * absorbed count. Anything else leaves the pickup unconfirmed. Item ids are compared, not components.</p>
 */
public interface PickupSink {
    /** Stable id reported to the agent as the destination, e.g. {@code sophisticatedbackpacks:backpack}. */
    String id();

    /** True only when the adapted mod is present at exactly the verified version ({@link McbotApi#versionsMatch}). */
    boolean installed();

    /** Read-only item id to total count held in the player's carried storage of this kind. Must not change anything. */
    Map<String, Integer> stored(ServerPlayer player);
}
