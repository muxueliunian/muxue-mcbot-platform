package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ComposterBlock;
import net.minecraft.world.level.block.state.BlockState;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Registered held-item interactions. Right-click effects depend entirely on the block and the held item,
 * so nothing is sent unless an adapter declares the interaction, its held requirement and its expected effects.
 */
final class ItemInteractions {
    private ItemInteractions() {}
    static final String BLOCK=ItemInteraction.BLOCK,ITEM=ItemInteraction.ITEM;
    record Verdict(String status,String code,String summary,int consumed,JsonArray gained,JsonArray unexpected) {}

    static final ItemInteraction COMPOSTER=new ItemInteraction() {
        public String id() {return "minecraft:composter/add";}
        public String kind() {return BLOCK;}
        public boolean installed() {return true;}
        public boolean block(BlockState state) {return state.is(Blocks.COMPOSTER);}
        public boolean emptyHand() {return false;}
        public boolean accepts(ItemStack held) {return !held.isEmpty()&&ComposterBlock.COMPOSTABLES.containsKey(held.getItem());}
        public void precondition(ServerPlayer player,BlockPos position,BlockState state,ItemStack held) {
            if(state.getValue(ComposterBlock.LEVEL)>=7) throw error("INTERACTION_NOT_READY","Composter is full or ready to harvest; adding is not this interaction");
        }
        public Expected expected() {return new Expected(1,1,false,Set.of("level"),Set.of(),Set.of(),false);}
        public boolean consistent(JsonObject before,JsonObject after) {return composterLevelStep(before,after);}
    };

    static List<ItemInteraction> installed(List<ItemInteraction> candidates) {
        List<ItemInteraction> result=new ArrayList<>();
        for(ItemInteraction interaction:candidates) {
            try { if(interaction.installed()) result.add(interaction); }
            catch(RuntimeException | LinkageError unavailable) { /* A changed optional mod is treated as absent. */ }
        }
        return result;
    }
    /** Built-in, JSON-configured and add-on interactions whose mods are present at the verified versions. */
    static List<ItemInteraction> installed() {return installed(ModAdapters.interactions());}
    /** Capabilities are advertised only when at least one interaction of that kind is actually available. */
    static List<String> capabilities(List<ItemInteraction> available) {
        List<String> result=new ArrayList<>();
        if(available.stream().anyMatch(i->i.kind().equals(BLOCK))) result.add("use-item-on-block");
        if(available.stream().anyMatch(i->i.kind().equals(ITEM))) result.add("use-item");
        return result;
    }
    static List<String> capabilities() {return capabilities(installed());}
    static JsonArray ids(List<ItemInteraction> available) {
        JsonArray result=new JsonArray();for(ItemInteraction interaction:available) result.add(interaction.id());return result;
    }
    static JsonArray ids() {return ids(installed());}
    /** Ids of the in-air ({@link #ITEM}) interactions, so the runtime can offer them separately from block right-clicks. */
    static JsonArray itemIds(List<ItemInteraction> available) {
        JsonArray result=new JsonArray();for(ItemInteraction interaction:available) if(ITEM.equals(interaction.kind())) result.add(interaction.id());return result;
    }
    static ItemInteraction require(List<ItemInteraction> available,String id,String kind) {
        for(ItemInteraction interaction:available) if(interaction.id().equals(id)) {
            if(!interaction.kind().equals(kind)) throw error("UNSUPPORTED","Interaction "+id+" is not a "+kind+" interaction");
            return interaction;
        }
        throw error("UNSUPPORTED","Interaction is not registered or its mod version is not verified: "+id);
    }
    static ItemInteraction require(String id,String kind) {return require(installed(),id,kind);}
    /** Empty hand only when the interaction itself requires it; an item interaction never falls back to an empty hand. */
    static void requireHeld(boolean emptyHandRequested,ItemInteraction interaction,ItemStack held) {
        boolean accepted;
        try { accepted=!held.isEmpty()&&interaction.accepts(held); }
        catch(RuntimeException | LinkageError broken) { throw error("UNSUPPORTED","Interaction adapter failed while checking the held item"); }
        requireHeld(emptyHandRequested,interaction.emptyHand(),held.isEmpty(),accepted);
    }
    /** Adapter precondition; add-on refusals keep their code only when it is one the agent understands. */
    static void precondition(ItemInteraction interaction,ServerPlayer player,BlockPos position,BlockState state,ItemStack held) {
        try { interaction.precondition(player,position,state,held); }
        catch(Protocol.Error refused) { throw refused; }
        catch(McbotApi.Refused refused) { throw error(Set.of("INTERACTION_NOT_READY","UNSUPPORTED").contains(refused.code)?refused.code:"INTERACTION_NOT_READY",String.valueOf(refused.getMessage())); }
        catch(RuntimeException | LinkageError broken) { throw error("UNSUPPORTED","Interaction adapter failed its precondition check"); }
    }
    /** Adapter summary; a broken adapter before the native call refuses, after it the receipt must become unknown. */
    static JsonObject summary(ItemInteraction interaction,ServerPlayer player,BlockPos position,boolean afterNativeCall) {
        try { JsonObject summary=interaction.summary(player,position);return summary==null?new JsonObject():summary; }
        catch(RuntimeException | LinkageError broken) {
            if(!afterNativeCall) throw error("UNSUPPORTED","Interaction adapter failed to observe its target");
            return obj("adapterError","summary failed after the native call");
        }
    }
    /** Envelope for this use; null when the adapter cannot give one, which makes the receipt unknown. */
    static ItemInteraction.Expected expected(ItemInteraction interaction,JsonObject beforeSummary) {
        try { return interaction.expectedFor(beforeSummary==null?new JsonObject():beforeSummary.deepCopy()); }
        catch(RuntimeException | LinkageError broken) { return null; }
    }
    static boolean consistent(ItemInteraction interaction,JsonObject before,JsonObject after) {
        try { return interaction.consistent(before,after); } catch(RuntimeException | LinkageError broken) { return false; }
    }
    static void requireHeld(boolean emptyHandRequested,boolean ruleEmptyHand,boolean heldEmpty,boolean accepted) {
        if(emptyHandRequested!=ruleEmptyHand) throw error("UNSUPPORTED",ruleEmptyHand?"This interaction requires an empty hand":"This interaction requires a declared held item; empty hand is not a fallback");
        if(ruleEmptyHand) { if(!heldEmpty) throw error("STALE_ITEM","Empty hand slot is no longer empty"); return; }
        if(heldEmpty||!accepted) throw error("UNSUPPORTED","Held item is not accepted by this interaction");
    }

    static boolean composterLevelStep(JsonObject before,JsonObject after) {
        try {
            int from=Integer.parseInt(before.getAsJsonObject("block").getAsJsonObject("properties").get("level").getAsString());
            int to=Integer.parseInt(after.getAsJsonObject("block").getAsJsonObject("properties").get("level").getAsString());
            return to==from||to==from+1;
        } catch(RuntimeException malformed) {return false;}
    }

    private static Map<Integer,JsonObject> slots(JsonObject snapshot) {
        Map<Integer,JsonObject> result=new TreeMap<>();
        for(JsonElement entry:snapshot.getAsJsonArray("inventory")) {JsonObject stack=entry.getAsJsonObject();result.put(stack.get("slot").getAsInt(),stack);}
        return result;
    }
    private static Map<String,JsonObject> drops(JsonObject snapshot) {
        Map<String,JsonObject> result=new TreeMap<>();
        for(JsonElement entry:snapshot.getAsJsonArray("drops")) {JsonObject drop=entry.getAsJsonObject();result.put(drop.get("entityId").getAsString(),drop);}
        return result;
    }
    private static boolean empty(JsonObject stack) {return stack==null||stack.get("count").getAsInt()==0||stack.get("id").getAsString().equals("minecraft:air");}
    private static JsonObject without(JsonObject components,Set<String> keys) {JsonObject copy=components.deepCopy();for(String key:keys) copy.remove(key);return copy;}
    private static JsonObject member(JsonObject object,String key) {return object.has(key)&&object.get(key).isJsonObject()?object.getAsJsonObject(key):new JsonObject();}
    private static void changedKeys(JsonObject before,JsonObject after,Set<String> allowed,String label,JsonArray unexpected) {
        Set<String> keys=new TreeSet<>(before.keySet());keys.addAll(after.keySet());
        for(String key:keys) if(!Objects.equals(before.get(key),after.get(key))&&!allowed.contains(key)) unexpected.add(label+" "+key+" changed");
    }

    /**
     * Pure receipt classification. failed only when nothing at all changed; succeeded only when every
     * difference lies inside the declared envelope and held consumption is within range; otherwise unknown.
     */
    static Verdict judge(JsonObject before,JsonObject after,int heldSlot,ItemInteraction.Expected expected,java.util.function.BiPredicate<JsonObject,JsonObject> consistent) {
        JsonArray unexpected=new JsonArray(),gained=new JsonArray();
        if(before.equals(after)) return new Verdict("failed","NO_EFFECT","Native interaction produced no observable change",0,gained,unexpected);
        JsonElement blockBefore=before.get("block"),blockAfter=after.get("block");
        if(blockBefore!=null&&blockBefore.isJsonObject()&&blockAfter!=null&&blockAfter.isJsonObject()) {
            JsonObject b=blockBefore.getAsJsonObject(),a=blockAfter.getAsJsonObject();
            if(!b.get("id").equals(a.get("id"))) unexpected.add("block replaced by "+a.get("id").getAsString());
            else changedKeys(member(b,"properties"),member(a,"properties"),expected.properties(),"property",unexpected);
        } else if(!Objects.equals(blockBefore,blockAfter)) unexpected.add("block observation changed shape");
        changedKeys(member(before,"summary"),member(after,"summary"),expected.summaryFields(),"summary",unexpected);
        Map<Integer,JsonObject> slotsBefore=slots(before),slotsAfter=slots(after);
        Set<Integer> slotKeys=new TreeSet<>(slotsBefore.keySet());slotKeys.addAll(slotsAfter.keySet());
        int consumed=0;
        for(int slot:slotKeys) {
            JsonObject b=slotsBefore.get(slot),a=slotsAfter.get(slot);
            if(Objects.equals(b,a)) continue;
            boolean sameKind=!empty(b)&&!empty(a)&&b.get("id").equals(a.get("id"));
            if(slot==heldSlot&&!empty(b)&&(empty(a)||sameKind)) {
                int lost=b.get("count").getAsInt()-(empty(a)?0:a.get("count").getAsInt());
                if(lost<0) { unexpected.add("held stack grew");continue; }
                consumed=lost;
                Set<String> mayChange=new HashSet<>(expected.heldComponents());if(expected.heldDamageAllowed()) mayChange.add("minecraft:damage");
                if(sameKind&&!without(b.getAsJsonObject("components"),mayChange).equals(without(a.getAsJsonObject("components"),mayChange)))
                    unexpected.add("held item components changed");
                continue;
            }
            boolean grew=!empty(a)&&expected.gainedItems().contains(a.get("id").getAsString())&&
                (empty(b)||(sameKind&&b.getAsJsonObject("components").equals(a.getAsJsonObject("components"))&&a.get("count").getAsInt()>b.get("count").getAsInt()));
            if(grew) gained.add(obj("slot",slot,"id",a.get("id").getAsString(),"count",a.get("count").getAsInt()-(empty(b)?0:b.get("count").getAsInt())));
            else unexpected.add("inventory slot "+slot+" changed");
        }
        if(!Objects.equals(before.get("menu"),after.get("menu"))&&!(expected.opensMenu()&&"none".equals(before.get("menu").getAsString()))) unexpected.add("menu changed to "+after.get("menu"));
        Map<String,JsonObject> dropsBefore=drops(before),dropsAfter=drops(after);
        for(String id:dropsBefore.keySet()) if(!Objects.equals(dropsBefore.get(id),dropsAfter.get(id))) unexpected.add("nearby drop "+id+" changed or vanished");
        for(var entry:dropsAfter.entrySet()) if(!dropsBefore.containsKey(entry.getKey())) {
            JsonObject stack=entry.getValue().getAsJsonObject("stack");
            if(expected.gainedItems().contains(stack.get("id").getAsString())) gained.add(obj("dropped",true,"id",stack.get("id").getAsString(),"count",stack.get("count").getAsInt()));
            else unexpected.add("unexpected drop "+stack.get("id").getAsString());
        }
        if(consumed<expected.minConsumed()||consumed>expected.maxConsumed()) unexpected.add("held consumption "+consumed+" outside "+expected.minConsumed()+".."+expected.maxConsumed());
        if(unexpected.isEmpty()&&!consistent.test(before,after)) unexpected.add("adapter consistency check failed");
        if(unexpected.isEmpty()) return new Verdict("succeeded",null,"Native interaction effects confirmed within the declared envelope",consumed,gained,unexpected);
        return new Verdict("unknown","NATIVE_UNKNOWN","Native interaction produced effects outside the declared envelope; observe again, do not replay",consumed,gained,unexpected);
    }
}
