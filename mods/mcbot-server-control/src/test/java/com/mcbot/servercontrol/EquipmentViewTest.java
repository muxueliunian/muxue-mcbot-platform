package com.mcbot.servercontrol;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Equipment of nearby entities and gift receipts, as plain values without a world. */
final class EquipmentViewTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    private static EquipmentView.Item plain(String id){return new EquipmentView.Item(id,1,List.of(),null,0,0);}
    private static EquipmentView.Item fresh(String id,int max){return new EquipmentView.Item(id,1,List.of(),null,0,max);}
    private static int bytes(JsonElement value){return value.toString().getBytes(StandardCharsets.UTF_8).length;}
    static void run(){
        // A player showing off a named, enchanted, worn sword, with a shield and diamond armour.
        Map<String,EquipmentView.Item> playerSlots=new HashMap<>();
        playerSlots.put("mainhand",new EquipmentView.Item("minecraft:netherite_sword",1,List.of("minecraft:sharpness 5","minecraft:unbreaking 3"),"屠龙",31,2031));
        playerSlots.put("offhand",fresh("minecraft:shield",336));
        for(String slot:List.of("head","chest","legs","feet"))playerSlots.put(slot,fresh("minecraft:diamond_"+Map.of("head","helmet","chest","chestplate","legs","leggings","feet","boots").get(slot),500));
        JsonObject player=EquipmentView.equipment(playerSlots);
        JsonObject sword=player.getAsJsonObject("mainhand");
        check(sword.get("id").getAsString().equals("minecraft:netherite_sword")&&sword.get("count").getAsInt()==1,"held item id and count");
        check(sword.getAsJsonArray("enchantments").size()==2&&sword.getAsJsonArray("enchantments").get(0).getAsString().equals("minecraft:sharpness 5"),"enchantments as id level");
        check(sword.get("name").getAsString().equals("屠龙")&&sword.get("durability").getAsString().equals("2000/2031"),"custom name and durability left");
        check(!player.getAsJsonObject("chest").has("durability")&&!player.getAsJsonObject("chest").has("enchantments")&&!player.getAsJsonObject("chest").has("name"),"undamaged plain armour is only id and count");
        check(new ArrayList<>(player.keySet()).equals(List.of("mainhand","offhand","head","chest","legs","feet")),"slots in fixed order, hands first, no empty body slot");

        // A zombie in iron armour with an iron sword; a skeleton with a bow.
        JsonObject zombie=EquipmentView.equipment(Map.of("mainhand",fresh("minecraft:iron_sword",250),"head",fresh("minecraft:iron_helmet",165),"chest",fresh("minecraft:iron_chestplate",240)));
        check(zombie.keySet().equals(Set.of("mainhand","head","chest"))&&zombie.getAsJsonObject("chest").get("id").getAsString().equals("minecraft:iron_chestplate"),"armoured zombie lists only its worn and held slots");
        JsonObject skeleton=EquipmentView.equipment(Map.of("mainhand",fresh("minecraft:bow",384)));
        check(skeleton.keySet().equals(Set.of("mainhand"))&&skeleton.getAsJsonObject("mainhand").get("id").getAsString().equals("minecraft:bow"),"skeleton holding a bow");
        JsonObject horse=EquipmentView.equipment(Map.of("body",plain("minecraft:diamond_horse_armor")));
        check(horse.getAsJsonObject("body").get("id").getAsString().equals("minecraft:diamond_horse_armor"),"body slot carries horse and wolf armour");

        // Nothing equipped: no field at all.
        check(EquipmentView.equipment(Map.of())==null,"all slots empty gives no equipment");
        check(EquipmentView.equipment(Map.of("mainhand",new EquipmentView.Item("minecraft:air",0,List.of(),null,0,0)))==null,"air and zero counts are empty slots");
        check(EquipmentView.equipment(Map.of("saddle",plain("minecraft:saddle")))==null,"unknown slot names are ignored");
        JsonObject cow=obj("type","minecraft:cow"),zombieEntry=obj("type","minecraft:zombie"),skeletonEntry=obj("type","minecraft:skeleton"),playerEntry=obj("type","minecraft:player");
        List<EquipmentView.Entry> nearby=new ArrayList<>(List.of(new EquipmentView.Entry(zombieEntry,9,zombie),new EquipmentView.Entry(skeletonEntry,25,skeleton),new EquipmentView.Entry(playerEntry,4,player)));
        int added=EquipmentView.attach(nearby);
        check(!cow.has("equipment")&&!cow.has("equipmentOmitted"),"an entity without gear is never touched");
        check(zombieEntry.has("equipment")&&skeletonEntry.has("equipment")&&playerEntry.has("equipment")&&!zombieEntry.has("equipmentOmitted"),"all three shown under the limits");
        check(added==bytes(zombie)+bytes(skeleton)+bytes(player),"attach reports the bytes it added");
        System.out.println("EquipmentViewTest: typical scene (player with enchanted sword, shield and armour; armoured zombie; skeleton with bow) adds "+added+" bytes of equipment JSON");

        // Per-item limits: at most 4 enchantments listed, names and ids cut.
        List<String> many=List.of("minecraft:a 1","minecraft:b 2","minecraft:c 3","minecraft:d 4","minecraft:e 5","minecraft:f 6");
        JsonObject loaded=EquipmentView.item(new EquipmentView.Item("x".repeat(200),64,many,"名".repeat(100),1,10));
        check(loaded.getAsJsonArray("enchantments").size()==EquipmentView.MAX_ENCHANTMENTS&&loaded.get("enchantmentsMore").getAsInt()==2,"enchantments cut to four with the rest counted");
        check(loaded.get("name").getAsString().codePointCount(0,loaded.get("name").getAsString().length())==EquipmentView.MAX_NAME&&loaded.get("name").getAsString().endsWith("…"),"long custom name cut with an ellipsis");
        check(loaded.get("id").getAsString().length()==EquipmentView.MAX_ID,"overlong id cut");
        check(EquipmentView.cut("😀".repeat(40),EquipmentView.MAX_NAME).codePointCount(0,EquipmentView.cut("😀".repeat(40),EquipmentView.MAX_NAME).length())==EquipmentView.MAX_NAME,"cutting never splits a surrogate pair");
        Map<String,EquipmentView.Item> worst=new HashMap<>();
        for(String slot:EquipmentView.SLOTS)worst.put(slot,new EquipmentView.Item("x".repeat(200),64,many.stream().map(e->e+"x".repeat(200)).toList(),"名".repeat(100),1,100000));
        int worstEntity=bytes(EquipmentView.equipment(worst));
        check(worstEntity<4096,"one entity's equipment is bounded: "+worstEntity);

        // Over the entity limit: the nearest 16 shown, the rest marked as omitted.
        List<EquipmentView.Entry> crowd=new ArrayList<>();List<JsonObject> zombies=new ArrayList<>();
        for(int i=0;i<20;i++){JsonObject entry=obj("n",i);zombies.add(entry);crowd.add(new EquipmentView.Entry(entry,20-i,zombie));}
        EquipmentView.attach(crowd);
        check(zombies.stream().filter(z->z.has("equipment")).count()==EquipmentView.MAX_ENTITIES,"at most sixteen entities get equipment");
        check(zombies.subList(0,4).stream().allMatch(z->z.has("equipmentOmitted")&&!z.has("equipment"))&&zombies.subList(4,20).stream().allMatch(z->z.has("equipment")),"the farthest are the ones omitted");
        // Over the byte budget: worst-case entities stop before 8 KiB.
        List<EquipmentView.Entry> heavy=new ArrayList<>();List<JsonObject> heavyEntries=new ArrayList<>();
        for(int i=0;i<16;i++){JsonObject entry=obj("n",i);heavyEntries.add(entry);heavy.add(new EquipmentView.Entry(entry,i,EquipmentView.equipment(worst)));}
        int heavyBytes=EquipmentView.attach(heavy);
        check(heavyBytes<=EquipmentView.MAX_BYTES&&heavyEntries.get(15).has("equipmentOmitted")&&heavyEntries.get(0).has("equipment"),"total equipment stays within the byte budget: "+heavyBytes);
        // A read that failed is marked omitted, not shown as unarmed.
        JsonObject broken=obj("type","othermod:golem");EquipmentView.attach(List.of(new EquipmentView.Entry(broken,1,null)));
        check(broken.has("equipmentOmitted")&&!broken.has("equipment"),"failed reads are marked omitted");

        // Threat list: only threats whose gear tells how dangerous they are.
        check(ThreatSense.showsEquipment("hostile")&&ThreatSense.showsEquipment("attacking_self")&&ThreatSense.showsEquipment("unknown"),"hostile and unknown threats show gear");
        check(!ThreatSense.showsEquipment("player")&&!ThreatSense.showsEquipment("friendly")&&!ThreatSense.showsEquipment("neutral"),"players, friends and neutral mobs do not repeat gear in the threat list");

        // Gift receipts: only a player other than the body counts as the thrower.
        UUID body=UUID.randomUUID(),muxue=UUID.randomUUID();
        check("muxue".equals(PickupLedger.thrownBy(muxue,"muxue",true,body)),"a player's throw names the player");
        check(PickupLedger.thrownBy(body,"ServerBot",true,body)==null,"what the body itself dropped is no gift");
        check(PickupLedger.thrownBy(null,null,false,body)==null,"mined blocks and mob loot have no thrower");
        check(PickupLedger.thrownBy(UUID.randomUUID(),null,false,body)==null,"a non-player thrower (a mob, a dispenser's entity) is no gift");
        PickupLedger ledger=new PickupLedger();
        JsonObject stack=obj("id","minecraft:netherite_sword","count",1,"maxStackSize",1,"components",obj());
        JsonObject gift=ledger.record("item",obj(),stack,obj("id","minecraft:air","count",0,"components",obj()),"session",1,"overworld",null,"muxue");
        JsonObject own=ledger.record("item2",obj(),stack,obj("id","minecraft:air","count",0,"components",obj()),"session",1,"overworld",null);
        check(gift.get("thrownBy").getAsString().equals("muxue")&&!own.has("thrownBy"),"receipt records the thrower only when there is one");
        check(ledger.observation().getAsJsonArray("pickupReceipts").get(0).getAsJsonObject().get("thrownBy").getAsString().equals("muxue"),"observation carries thrownBy");

        check(ServerController.CAPABILITIES.contains("gift-receipts")&&ServerController.CAPABILITIES.contains("entity-equipment"),"both capabilities advertised");
        check(!ServerController.atomicAction("gift-receipts")&&!ServerController.atomicAction("entity-equipment")&&!ServerController.atomicAction("last-death"),"capabilities are reads, never actions");
        System.out.println("EquipmentViewTest: "+checks+" checks passed");
    }
}
