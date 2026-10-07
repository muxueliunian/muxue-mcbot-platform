package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.alchemy.PotionContents;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Readable item identities that keep the components that matter: a water bottle and a potion of swiftness are both
 * minecraft:potion, a sword before and after enchanting is the same id. Receipts of workstation tools count items
 * by {@link #key}, so changes in place (brewing, enchanting, repairing) show up. Nothing is hashed.
 */
final class ItemDescriptions {
    private ItemDescriptions() {}

    /** Item id, plus the meaningful components in brackets when the stack has any: {@code minecraft:potion[potion=minecraft:swiftness]}. */
    static String key(ItemStack stack) {
        String id=NativeWorkstation.id(stack);
        if(stack.isEmpty()||stack.getComponentsPatch().isEmpty())return id;
        List<String> parts=new ArrayList<>();
        PotionContents potion=stack.get(DataComponents.POTION_CONTENTS);
        if(potion!=null)potion.potion().flatMap(h->h.unwrapKey()).ifPresent(k->parts.add("potion="+k.location()));
        enchantments(stack.get(DataComponents.ENCHANTMENTS),"enchantments",parts);
        enchantments(stack.get(DataComponents.STORED_ENCHANTMENTS),"stored",parts);
        Integer damage=stack.get(DataComponents.DAMAGE);if(damage!=null&&damage>0)parts.add("damage="+damage);
        if(stack.has(DataComponents.CUSTOM_NAME))parts.add("name="+stack.getHoverName().getString());
        Integer repair=stack.get(DataComponents.REPAIR_COST);if(repair!=null&&repair>0)parts.add("repairCost="+repair);
        // Anything else is named by its component type, so two different stacks never look identical.
        for(var entry:stack.getComponentsPatch().entrySet()) {
            var type=entry.getKey();
            if(type==DataComponents.POTION_CONTENTS||type==DataComponents.ENCHANTMENTS||type==DataComponents.STORED_ENCHANTMENTS||type==DataComponents.DAMAGE||type==DataComponents.CUSTOM_NAME||type==DataComponents.REPAIR_COST)continue;
            var key=BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type);parts.add((entry.getValue().isPresent()?"":"-")+(key==null?"component":key.toString()));
        }
        return parts.isEmpty()?id:id+"["+String.join(",",parts)+"]";
    }
    private static void enchantments(ItemEnchantments enchantments,String label,List<String> parts) {
        if(enchantments==null||enchantments.isEmpty())return;
        List<String> list=new ArrayList<>();
        for(var entry:enchantments.entrySet())list.add(entry.getKey().unwrapKey().map(k->k.location().toString()).orElse("?")+" "+entry.getIntValue());
        Collections.sort(list);parts.add(label+"="+String.join("+",list));
    }
    /** A stack for a receipt: key, count and, for gear, durability left. */
    static JsonObject describe(ItemStack stack) {
        JsonObject result=obj("item",key(stack),"count",stack.getCount());
        if(stack.isDamageableItem())result.addProperty("durability",stack.getMaxDamage()-stack.getDamageValue()+"/"+stack.getMaxDamage());
        return result;
    }
    /** All of the body's stacks counted by {@link #key}. */
    static Map<String,Integer> counts(Inventory inventory) {
        Map<String,Integer> result=new TreeMap<>();
        for(int i=0;i<inventory.getContainerSize();i++){ItemStack s=inventory.getItem(i);if(!s.isEmpty())result.merge(key(s),s.getCount(),Integer::sum);}
        return result;
    }
}
