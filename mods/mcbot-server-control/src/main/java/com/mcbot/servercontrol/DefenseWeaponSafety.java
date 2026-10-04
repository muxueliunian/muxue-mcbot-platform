package com.mcbot.servercontrol;

import net.minecraft.core.component.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.*;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Deliberately excludes enchantments and altered behavior components until a verified adapter exists. */
final class DefenseWeaponSafety {
    private static final Set<String> ITEMS=Set.of("wooden_sword","stone_sword","iron_sword","golden_sword","diamond_sword","netherite_sword","wooden_axe","stone_axe","iron_axe","golden_axe","diamond_axe","netherite_axe");
    static void require(ItemStack stack,int attacks) {
        if(stack.isEmpty())return;
        Class<?> type=stack.getItem().getClass();
        var id=BuiltInRegistries.ITEM.getKey(stack.getItem());
        if(!id.getNamespace().equals("minecraft")||!ITEMS.contains(id.getPath())||(type!=SwordItem.class&&type!=AxeItem.class))throw error("UNSUPPORTED","UNVERIFIED_WEAPON_IMPLEMENTATION");
        for(var entry:stack.getComponentsPatch().entrySet()) {
            DataComponentType<?> component=entry.getKey();
            if(component!=DataComponents.DAMAGE&&component!=DataComponents.CUSTOM_NAME&&component!=DataComponents.LORE&&component!=DataComponents.REPAIR_COST)
                throw error("UNSUPPORTED","UNVERIFIED_WEAPON_COMPONENT");
        }
        if(stack.isDamageableItem()&&stack.getMaxDamage()-stack.getDamageValue()<=attacks)throw error("UNSUPPORTED","WEAPON_DURABILITY_RESERVE");
    }
}
