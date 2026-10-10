package com.mcbot.servercontrol.api;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Seats another mod adds: blocks the player right-clicks to ride a seat entity (a chair, a stool). Vanilla has no
 * sitting, so stairs and slabs are never seats; only blocks an adapter names are. The agent sits with the
 * {@code sit} action and gets up with {@code stand-up}.
 *
 * <p>MCBOT walks the body next to the seat, makes sure the main hand is empty (so nothing in it can change the seat
 * instead, such as a carpet dyeing a chair), sends the same right-click a player would, and then trusts only what
 * it observes: the body must be riding an entity that {@link #seatEntity} confirms. Every check is fail-closed:
 * answer {@code false} whenever the block or entity differs in any way from the version you verified.</p>
 */
public interface SeatAdapter {
    /** Stable id, namespace = the adapted mod, e.g. {@code kaleidoscope_cookery:seat}. */
    String id();

    /** True only when the adapted mod is present at exactly the verified version ({@link McbotApi#versionsMatch}). */
    boolean installed();

    /** Whether this block state is a seat this adapter can sit on in its current state. */
    boolean seat(BlockState state);

    /** Whether somebody already sits on, or the mod already reserved, the seat at this position. Unsure means {@code true}. */
    boolean occupied(ServerLevel level, BlockPos position);

    /** Whether this entity is the seat entity the adapted mod spawns for a sitting player. */
    boolean seatEntity(Entity entity);

    /** One short line for the agent: which blocks can be sat on. */
    default String hint() { return ""; }
}
