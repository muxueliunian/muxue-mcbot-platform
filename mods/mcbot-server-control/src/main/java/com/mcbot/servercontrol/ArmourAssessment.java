package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ArmorItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ShieldItem;
import net.minecraft.world.item.enchantment.EnchantmentEffectComponents;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.core.component.DataComponents;
import net.minecraft.tags.EnchantmentTags;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Read-only: for the given item ids found in the main inventory (slots 0..35), which would be an improvement over what
 * the body wears now (capability assess-armour). Only vanilla humanoid {@link ArmorItem}s (head, chest, legs, feet) and
 * a {@link ShieldItem} for an empty off hand are candidates; elytra, pumpkins, heads, horse and wolf armour are not.
 * Reading stacks is here, the decision is {@link ArmourChoice}. Nothing is equipped or moved.
 */
final class ArmourAssessment {
    static final int MAX_ITEMS=8;
    private ArmourAssessment() {}

    static JsonObject assess(ServerPlayer player,JsonObject params) {
        JsonArray asked=params.has("items")&&params.get("items").isJsonArray()?params.getAsJsonArray("items"):null;
        if(asked==null||asked.size()==0||asked.size()>MAX_ITEMS)throw error("INVALID_ARGUMENT","assess-armour takes 1.."+MAX_ITEMS+" item ids");
        Set<String> ids=new HashSet<>();
        for(JsonElement element:asked){
            if(!element.isJsonPrimitive()||!element.getAsJsonPrimitive().isString())throw error("INVALID_ARGUMENT","assess-armour items must be item id strings");
            ids.add(element.getAsString());
        }
        Inventory inventory=player.getInventory();
        List<ArmourChoice.Candidate> candidates=new ArrayList<>();
        boolean free=false;
        for(int slot=0;slot<36;slot++) {
            ItemStack stack=inventory.getItem(slot);
            if(stack.isEmpty()){free=true;continue;}
            String id=NativeWorkstation.id(stack);
            if(!ids.contains(id))continue;
            String part=part(stack);
            if(part==null)continue;
            candidates.add(new ArmourChoice.Candidate(slot,id,stack.getCount(),part,piece(stack,part)));
        }
        Map<String,ArmourChoice.Piece> worn=new HashMap<>();
        Map<String,String> wornIds=new HashMap<>();
        for(EquipmentSlot slot:List.of(EquipmentSlot.HEAD,EquipmentSlot.CHEST,EquipmentSlot.LEGS,EquipmentSlot.FEET,EquipmentSlot.OFFHAND)) {
            ItemStack stack=player.getItemBySlot(slot);
            if(stack.isEmpty())continue;
            String part=slot==EquipmentSlot.OFFHAND?"offhand":slot.getName();
            worn.put(part,piece(stack,slot==EquipmentSlot.OFFHAND?null:part));
            wornIds.put(part,NativeWorkstation.id(stack));
        }
        JsonArray listed=new JsonArray();
        for(ArmourChoice.Assessment verdict:ArmourChoice.assess(candidates,worn,free)) {
            ArmourChoice.Candidate candidate=verdict.candidate();
            JsonObject entry=obj("slot",candidate.slot(),"item",candidate.id(),"count",candidate.count(),"part",candidate.part(),"verdict",verdict.verdict(),"reason",verdict.reason());
            if(wornIds.containsKey(candidate.part()))entry.addProperty("wearing",wornIds.get(candidate.part()));
            listed.add(entry);
        }
        return obj("candidates",listed);
    }
    /** head/chest/legs/feet for vanilla humanoid armour, offhand for a shield, else null. */
    static String part(ItemStack stack) {
        if(stack.getItem() instanceof ArmorItem armor&&armor.getEquipmentSlot().getType()==EquipmentSlot.Type.HUMANOID_ARMOR)return armor.getEquipmentSlot().getName();
        if(stack.getItem() instanceof ShieldItem)return "offhand";
        return null;
    }
    /** slotPart is the armour slot name whose attribute modifiers count, null for the off hand (no armour points). */
    private static ArmourChoice.Piece piece(ItemStack stack,String slotPart) {
        double[] sums={0,0};
        if(slotPart!=null) {
            EquipmentSlot slot=EquipmentSlot.byName(slotPart);
            stack.forEachModifier(slot,(attribute,modifier)->{
                if(modifier.operation()!=AttributeModifier.Operation.ADD_VALUE)return;
                if(attribute.value()==Attributes.ARMOR.value())sums[0]+=modifier.amount();
                else if(attribute.value()==Attributes.ARMOR_TOUGHNESS.value())sums[1]+=modifier.amount();
            });
        }
        int levels=0;
        ItemEnchantments enchantments=stack.get(DataComponents.ENCHANTMENTS);
        // Curses (binding, vanishing) are not worth anything; binding is judged on its own below.
        if(enchantments!=null)for(var entry:enchantments.entrySet())if(!entry.getKey().is(EnchantmentTags.CURSE))levels+=entry.getIntValue();
        int left=stack.isDamageableItem()?stack.getMaxDamage()-stack.getDamageValue():Integer.MAX_VALUE;
        return new ArmourChoice.Piece(sums[0],sums[1],levels,left,EnchantmentHelper.has(stack,EnchantmentEffectComponents.PREVENT_ARMOR_CHANGE));
    }
}
