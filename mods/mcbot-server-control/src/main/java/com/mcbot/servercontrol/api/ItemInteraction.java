package com.mcbot.servercontrol.api;

import com.google.gson.JsonObject;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/**
 * A right-click the bot may perform with its held item, on a block ({@link #BLOCK}) or in the air ({@link #ITEM}).
 *
 * <p>MCBOT snapshots the block, the bot's inventory, its open menu, nearby drops and {@link #summary} before and after
 * the native click. The receipt is "succeeded" only when every difference lies inside {@link #expected} and
 * {@link #consistent} agrees, "failed" when nothing changed, and "unknown" otherwise (the agent is told not to replay).</p>
 */
public interface ItemInteraction {
    String BLOCK = "block", ITEM = "item";

    /**
     * Effects a succeeded interaction may produce; anything else makes the receipt unknown. {@code heldComponents} names
     * data components of the held stack that may change (e.g. a storage id a backpack assigns on first open); check
     * their values in {@link #consistent}. {@code removesBlock} lets the target block become air (picking a placed
     * block up into the hand).
     */
    record Expected(int minConsumed, int maxConsumed, boolean heldDamageAllowed, Set<String> properties,
                    Set<String> summaryFields, Set<String> gainedItems, boolean opensMenu, Set<String> heldComponents,
                    boolean removesBlock) {
        public Expected { heldComponents = heldComponents == null ? Set.of() : Set.copyOf(heldComponents); }

        public Expected(int minConsumed, int maxConsumed, boolean heldDamageAllowed, Set<String> properties,
                        Set<String> summaryFields, Set<String> gainedItems, boolean opensMenu, Set<String> heldComponents) {
            this(minConsumed, maxConsumed, heldDamageAllowed, properties, summaryFields, gainedItems, opensMenu, heldComponents, false);
        }

        public Expected(int minConsumed, int maxConsumed, boolean heldDamageAllowed, Set<String> properties,
                        Set<String> summaryFields, Set<String> gainedItems, boolean opensMenu) {
            this(minConsumed, maxConsumed, heldDamageAllowed, properties, summaryFields, gainedItems, opensMenu, Set.of(), false);
        }
    }

    /** Stable id the agent passes back, e.g. {@code minecraft:composter/add}. */
    String id();

    /** {@link #BLOCK} or {@link #ITEM}. */
    String kind();

    /** True only when the adapted mod is present at exactly the verified version ({@link McbotApi#versionsMatch}). */
    boolean installed();

    /** Block interactions only; item interactions are never matched against a block. */
    default boolean block(BlockState state) { return false; }

    /** True when this interaction must be performed with an empty main hand. Empty hand is never a fallback. */
    boolean emptyHand();

    /** True when the right-click is done while sneaking (e.g. picking a placed backpack up); the sneak is released right after. */
    default boolean sneaking() { return false; }

    boolean accepts(ItemStack held);

    /** Read-only check before any native packet; throw {@link McbotApi#refuse} when the target is not ready. */
    default void precondition(ServerPlayer player, BlockPos position, BlockState state, ItemStack held) {}

    /** Read-only adapter facts taken before and after the native call (e.g. contents of a cooking pot). */
    default JsonObject summary(ServerPlayer player, BlockPos position) { return new JsonObject(); }

    Expected expected();

    /**
     * The envelope for one concrete use, given the {@link #summary} taken just before the native call. Override when the
     * allowed effects depend on the target's state (e.g. which dish comes out of a pot); defaults to {@link #expected()}.
     */
    default Expected expectedFor(JsonObject beforeSummary) { return expected(); }

    /**
     * Adapter-specific value check on the two whole snapshots, in addition to the generic effect envelope. Each snapshot
     * has {@code summary} (your {@link #summary}), {@code block} ({@code id}, {@code properties}), {@code inventory},
     * {@code menu} and {@code drops}.
     */
    default boolean consistent(JsonObject before, JsonObject after) { return true; }

    /** Item interactions that open a menu must verify it here. */
    default boolean menu(AbstractContainerMenu menu) { return false; }
}
