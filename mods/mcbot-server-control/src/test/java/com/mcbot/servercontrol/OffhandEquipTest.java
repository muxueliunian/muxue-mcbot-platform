package com.mcbot.servercontrol;

import net.minecraft.world.entity.EquipmentSlot;

/** The offhand rule of equip-item as plain values: where a request goes, and which stacks it accepts. */
final class OffhandEquipTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}

    static void run() {
        EquipmentSlot none = EquipmentSlot.MAINHAND;
        check(OffhandEquip.target(true,none)==EquipmentSlot.OFFHAND,"hand offhand sends a torch (main hand by vanilla) to the off hand");
        check(OffhandEquip.target(false,none)==EquipmentSlot.MAINHAND,"without hand the vanilla slot is kept");
        check(OffhandEquip.target(false,EquipmentSlot.HEAD)==EquipmentSlot.HEAD,"without hand armour keeps its armour slot");
        check(OffhandEquip.target(true,EquipmentSlot.HEAD)==EquipmentSlot.OFFHAND,"hand offhand wins over armour");

        check(OffhandEquip.supported(true,EquipmentSlot.OFFHAND,false),"hand offhand accepts a shield");
        check(OffhandEquip.supported(true,EquipmentSlot.OFFHAND,false)&&OffhandEquip.supported(true,none,false),"hand offhand accepts any non-empty stack, torch included");
        check(!OffhandEquip.supported(true,EquipmentSlot.OFFHAND,true),"hand offhand refuses an empty stack");
        check(!OffhandEquip.supported(false,none,false),"without hand a torch is still unsupported");
        check(OffhandEquip.supported(false,EquipmentSlot.HEAD,false),"without hand armour is supported");
        check(OffhandEquip.supported(false,EquipmentSlot.OFFHAND,false),"without hand a shield (offhand by vanilla) is supported");
        check(!OffhandEquip.supported(false,EquipmentSlot.HEAD,true),"without hand an empty stack is refused");
        check(OffhandEquip.HAND.equals("offhand"),"the wire value is offhand");
        System.out.println("OffhandEquipTest: "+checks+" checks passed");
    }
}
