package com.mcbot.addon.kaleidoscopecookery;

import java.util.Set;

/**
 * Which Kaleidoscope Cookery blocks and entities are seats, as plain names so it can be checked without Minecraft.
 * Verified against 1.6.0-neoforge+mc1.21.1 (decompiled class names): ChairBlock sits in useItemOn and CookStoolBlock in
 * useWithoutItem, both spawning a SitEntity the player then rides. The tag kaleidoscope_cookery:sittable also lists
 * long_bench and trash_can; those are not claimed here because their classes were not read.
 */
final class SeatRules {
    private SeatRules() {}
    static final String PACKAGE = "com.github.ysbbbbbb.kaleidoscopecookery.";
    static final String CHAIR_CLASS = PACKAGE + "block.decoration.ChairBlock", STOOL_CLASS = PACKAGE + "block.decoration.CookStoolBlock";
    static final String SIT_ENTITY_CLASS = PACKAGE + "entity.SitEntity";
    static final Set<String> SEAT_BLOCK_CLASSES = Set.of(CHAIR_CLASS, STOOL_CLASS);

    /** A block of this registry namespace and exact class is a chair or stool; subclasses and lookalikes in other mods are not. */
    static boolean seatBlock(String blockId, String className) {
        return blockId != null && blockId.startsWith(SeatAccess.MOD + ":") && SEAT_BLOCK_CLASSES.contains(className);
    }

    static boolean seatEntity(String className) { return SIT_ENTITY_CLASS.equals(className); }
}
