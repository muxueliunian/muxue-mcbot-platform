package com.mcbot.servercontrol.api.workstation;

import java.util.Objects;
import net.minecraft.world.item.ItemStack;

/**
 * A choice an opened station offers right now, pressed with menu button {@code button}: a stonecutter recipe, a loom
 * pattern, an enchanting table slot. {@code id} names it for the agent (recipe id, pattern id, "slot1"); {@code
 * preview} is the result when the menu shows one before choosing (empty otherwise); {@code levels} is the level
 * requirement shown (0 when none); {@code hint} is what the game itself shows the player (an enchantment clue), never
 * hidden information.
 */
public record StationOption(int button, String id, ItemStack preview, int levels, String hint) {
    public StationOption {
        Objects.requireNonNull(id, "id");
        preview = preview == null ? ItemStack.EMPTY : preview.copy();
        hint = hint == null ? "" : hint;
    }
}
