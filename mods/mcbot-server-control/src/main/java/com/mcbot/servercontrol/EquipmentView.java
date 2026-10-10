package com.mcbot.servercontrol;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * What a nearby living entity holds and wears, for the model to read ("an iron-armoured zombie", "a skeleton with a
 * bow"). Only non-empty slots are listed and an entity with none gets no field. Every part is bounded: the slots, each
 * item's text, the number of entities and the total bytes. An entity whose gear is left out gets equipmentOmitted, so a
 * missing field still means "nothing equipped". Plain values only; reading the native slots is in {@link ItemDescriptions}.
 */
final class EquipmentView {
    /** Vanilla EquipmentSlot names (1.21.1), hands first; body is horse and wolf armour. */
    static final List<String> SLOTS=List.of("mainhand","offhand","head","chest","legs","feet","body");
    static final int MAX_ENTITIES=16,MAX_BYTES=8192,MAX_ENCHANTMENTS=4,MAX_NAME=32,MAX_ID=64;
    private EquipmentView() {}

    /** One equipped stack: enchantments as "id level" (sorted), the custom name if any, damage out of the maximum (0 for undamageable). */
    record Item(String id,int count,List<String> enchantments,String name,int damage,int maxDamage) {}
    /** An entity's observation entry, how far it is (any monotonic measure) and its equipment, or null when reading it failed. */
    record Entry(JsonObject target,double distance,JsonObject equipment) {}

    static JsonObject item(Item item) {
        JsonObject result=obj("id",cut(item.id(),MAX_ID),"count",item.count());
        List<String> enchantments=item.enchantments()==null?List.of():item.enchantments();
        if(!enchantments.isEmpty()) {
            JsonArray listed=new JsonArray();
            for(String enchantment:enchantments.subList(0,Math.min(enchantments.size(),MAX_ENCHANTMENTS)))listed.add(cut(enchantment,MAX_ID));
            result.add("enchantments",listed);
            if(enchantments.size()>MAX_ENCHANTMENTS)result.addProperty("enchantmentsMore",enchantments.size()-MAX_ENCHANTMENTS);
        }
        if(item.name()!=null&&!item.name().isEmpty())result.addProperty("name",cut(item.name(),MAX_NAME));
        // Same "left/max" text as ItemDescriptions.describe, but only once worn: no field means undamaged or unbreakable.
        if(item.maxDamage()>0&&item.damage()>0)result.addProperty("durability",(item.maxDamage()-item.damage())+"/"+item.maxDamage());
        return result;
    }
    /** {slot: item} in {@link #SLOTS} order, or null when every slot is empty; unknown slot names are ignored. */
    static JsonObject equipment(Map<String,Item> slots) {
        JsonObject result=new JsonObject();
        for(String slot:SLOTS) {
            Item item=slots.get(slot);
            if(item!=null&&item.count()>0&&item.id()!=null&&!item.id().equals("minecraft:air"))result.add(slot,item(item));
        }
        return result.size()==0?null:result;
    }
    /**
     * Adds equipment to the nearest entries, at most {@link #MAX_ENTITIES} and {@link #MAX_BYTES} of equipment JSON in
     * all; the rest, and entries whose reading failed, get equipmentOmitted:true instead. Returns the bytes added.
     */
    static int attach(List<Entry> entries) {
        List<Entry> sorted=new ArrayList<>(entries);sorted.sort(Comparator.comparingDouble(Entry::distance));
        int shown=0,bytes=0;
        for(Entry entry:sorted) {
            if(entry.equipment()==null){entry.target().addProperty("equipmentOmitted",true);continue;}
            int size=entry.equipment().toString().getBytes(StandardCharsets.UTF_8).length;
            if(shown>=MAX_ENTITIES||bytes+size>MAX_BYTES){entry.target().addProperty("equipmentOmitted",true);continue;}
            entry.target().add("equipment",entry.equipment());shown++;bytes+=size;
        }
        return bytes;
    }
    /** At most max code points, the last one replaced by an ellipsis when cut. */
    static String cut(String text,int max) {
        if(text.codePointCount(0,text.length())<=max)return text;
        return text.substring(0,text.offsetByCodePoints(0,max-1))+"…";
    }
}
