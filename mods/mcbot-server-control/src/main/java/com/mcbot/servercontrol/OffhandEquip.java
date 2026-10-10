package com.mcbot.servercontrol;

import net.minecraft.world.entity.EquipmentSlot;

/**
 * equip-item with hand:"offhand": any stack goes into the off hand, not only what vanilla would wear there. Only the
 * decisions are here; the native clicks and the binding-curse refusal are in {@link SurvivalActions}.
 */
final class OffhandEquip {
    /** The only value the optional hand argument takes; absent keeps vanilla's choice of slot. */
    static final String HAND = "offhand";
    private OffhandEquip() {}
    /** The slot a request targets: the off hand when asked for it, otherwise the slot vanilla picks for the item. */
    static EquipmentSlot target(boolean offhandAsked, EquipmentSlot natural) { return offhandAsked ? EquipmentSlot.OFFHAND : natural; }
    /**
     * Whether the stack can be put on at all. Without hand: armour or the off hand (shields), as before. With hand: any
     * non-empty stack. An empty stack is never supported.
     */
    static boolean supported(boolean offhandAsked, EquipmentSlot target, boolean empty) {
        if (empty) return false;
        return offhandAsked || target == EquipmentSlot.OFFHAND || target.getType() == EquipmentSlot.Type.HUMANOID_ARMOR;
    }
}
