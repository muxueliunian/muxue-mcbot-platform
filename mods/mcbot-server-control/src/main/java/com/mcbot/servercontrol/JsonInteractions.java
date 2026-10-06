package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

/**
 * Simple block right-click interactions declared by the server owner in {@code config/mcbot-server-control/interactions/*.json},
 * for cases that need no code: "hold one of these items, right-click one of these blocks, these effects may happen".
 * Strict format, unknown keys rejected, exact mod versions required. Anything that needs adapter logic
 * (menus, item-use in the air, value checks) belongs in a Java adapter instead.
 */
final class JsonInteractions {
    private JsonInteractions() {}
    private static final Pattern ID=Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");
    private static final Pattern PROPERTY=Pattern.compile("[a-z0-9_]{1,64}");
    private static final Set<String> KEYS=Set.of("id","note","requires","blocks","held","emptyHand","consume","heldDamage","changes","gains","refuseWhen");
    private static final int MAX_LIST=64;

    /** Parsed and validated declaration; matching is on plain ids so it can be checked without a running game. */
    record Rule(String id,Map<String,String> requires,Set<String> blocks,Set<String> heldItems,Set<String> heldTags,boolean emptyHand,
                int minConsumed,int maxConsumed,boolean heldDamage,Set<String> changes,Set<String> gains,Map<String,Set<String>> refuseWhen) {
        boolean matchesBlock(String blockId) {return blocks.contains(blockId);}
        boolean acceptsItem(String itemId,Predicate<String> inTag) {return heldItems.contains(itemId)||heldTags.stream().anyMatch(inTag);}
        /** Why the target is not ready, or null. A missing property is a refusal too (fail closed). */
        String refusal(Map<String,String> properties) {
            for(var entry:refuseWhen.entrySet()) {
                String value=properties.get(entry.getKey());
                if(value==null) return "Block has no property "+entry.getKey();
                if(entry.getValue().contains(value)) return "Block property "+entry.getKey()+"="+value+" is declared not ready";
            }
            return null;
        }
        ItemInteraction.Expected expected() {return new ItemInteraction.Expected(minConsumed,maxConsumed,heldDamage,changes,Set.of(),gains,false);}
    }

    static Rule parse(JsonObject o) {
        for(String key:o.keySet()) if(!KEYS.contains(key)) throw new IllegalArgumentException("unknown key \""+key+"\"");
        String id=id(o,"id");
        Map<String,String> requires=new TreeMap<>();
        if(o.has("requires")) {
            if(!o.get("requires").isJsonObject()) throw new IllegalArgumentException("requires must be an object of modId: exact version");
            for(var entry:o.getAsJsonObject("requires").entrySet()) {
                if(!Pattern.matches("[a-z0-9_.-]{1,64}",entry.getKey())||!entry.getValue().isJsonPrimitive()||!entry.getValue().getAsJsonPrimitive().isString()||entry.getValue().getAsString().isBlank())
                    throw new IllegalArgumentException("requires."+entry.getKey()+" must be an exact version string");
                requires.put(entry.getKey(),entry.getValue().getAsString());
            }
        }
        String namespace=id.substring(0,id.indexOf(':'));
        if(!namespace.equals("minecraft")&&!requires.containsKey(namespace)) throw new IllegalArgumentException("id namespace "+namespace+" must be listed in requires with its exact version");
        Set<String> blocks=ids(o,"blocks",true);
        boolean emptyHand=o.has("emptyHand")&&bool(o,"emptyHand");
        Set<String> items=new TreeSet<>(),tags=new TreeSet<>();
        if(o.has("held")) for(JsonElement e:list(o,"held")) {
            String value=string(e,"held");
            if(value.startsWith("#")) { if(!ID.matcher(value.substring(1)).matches()) throw new IllegalArgumentException("bad item tag "+value);tags.add(value.substring(1)); }
            else { if(!ID.matcher(value).matches()) throw new IllegalArgumentException("bad item id "+value);items.add(value); }
        }
        if(emptyHand&&!(items.isEmpty()&&tags.isEmpty())) throw new IllegalArgumentException("emptyHand interactions cannot list held items");
        if(!emptyHand&&items.isEmpty()&&tags.isEmpty()) throw new IllegalArgumentException("held must list item ids or #tags (or set emptyHand)");
        if(!o.has("consume")||!o.get("consume").isJsonArray()||o.getAsJsonArray("consume").size()!=2) throw new IllegalArgumentException("consume must be [min, max]");
        int min=count(o.getAsJsonArray("consume").get(0)),max=count(o.getAsJsonArray("consume").get(1));
        if(min>max) throw new IllegalArgumentException("consume min is greater than max");
        if(emptyHand&&max>0) throw new IllegalArgumentException("an empty hand cannot consume items");
        boolean heldDamage=o.has("heldDamage")&&bool(o,"heldDamage");
        Set<String> changes=new TreeSet<>();
        if(o.has("changes")) for(JsonElement e:list(o,"changes")) { String p=string(e,"changes");if(!PROPERTY.matcher(p).matches()) throw new IllegalArgumentException("bad property name "+p);changes.add(p); }
        Set<String> gains=o.has("gains")?ids(o,"gains",false):Set.of();
        Map<String,Set<String>> refuseWhen=new TreeMap<>();
        if(o.has("refuseWhen")) {
            if(!o.get("refuseWhen").isJsonObject()) throw new IllegalArgumentException("refuseWhen must be an object of property: [values]");
            for(var entry:o.getAsJsonObject("refuseWhen").entrySet()) {
                if(!PROPERTY.matcher(entry.getKey()).matches()||!entry.getValue().isJsonArray()) throw new IllegalArgumentException("refuseWhen."+entry.getKey()+" must list values");
                Set<String> values=new TreeSet<>();for(JsonElement v:entry.getValue().getAsJsonArray()) values.add(string(v,"refuseWhen."+entry.getKey()));
                refuseWhen.put(entry.getKey(),Set.copyOf(values));
            }
        }
        if(max==0&&changes.isEmpty()&&gains.isEmpty()&&!heldDamage) throw new IllegalArgumentException("declares no possible effect; it could never succeed");
        return new Rule(id,Map.copyOf(requires),Set.copyOf(blocks),Set.copyOf(items),Set.copyOf(tags),emptyHand,min,max,heldDamage,Set.copyOf(changes),Set.copyOf(gains),Map.copyOf(refuseWhen));
    }

    /** A file holds one declaration object or an array of them. Broken files are skipped as a whole and reported. */
    static List<Rule> parseFile(String name,String text,List<String> problems) {
        try {
            JsonElement root=JsonParser.parseString(text);
            List<JsonElement> entries=root.isJsonArray()?root.getAsJsonArray().asList():List.of(root);
            List<Rule> rules=new ArrayList<>();
            for(int i=0;i<entries.size();i++) {
                if(!entries.get(i).isJsonObject()) throw new IllegalArgumentException("entry "+i+" is not an object");
                try { rules.add(parse(entries.get(i).getAsJsonObject())); }
                catch(IllegalArgumentException bad) { throw new IllegalArgumentException("entry "+i+": "+bad.getMessage()); }
            }
            return rules;
        } catch(JsonParseException | IllegalArgumentException | IllegalStateException bad) {
            problems.add("interactions/"+name+" skipped: "+bad.getMessage());
            return List.of();
        }
    }

    static List<ItemInteraction> loadDirectory(Path directory,List<String> problems) {
        if(!Files.isDirectory(directory)) return List.of();
        List<ItemInteraction> result=new ArrayList<>();
        try(var files=Files.list(directory)) {
            for(Path file:files.filter(p->p.getFileName().toString().endsWith(".json")).sorted().toList()) {
                String text;
                try { text=Files.readString(file,StandardCharsets.UTF_8); }
                catch(IOException unreadable) { problems.add("interactions/"+file.getFileName()+" unreadable: "+unreadable.getMessage());continue; }
                for(Rule rule:parseFile(file.getFileName().toString(),text,problems)) result.add(interaction(rule));
            }
        } catch(IOException unreadable) { problems.add("interactions directory unreadable: "+unreadable.getMessage()); }
        return result;
    }

    static ItemInteraction interaction(Rule rule) {
        return new ItemInteraction() {
            public String id() {return rule.id();}
            public String kind() {return BLOCK;}
            public boolean installed() {
                if(rule.requires().isEmpty()) return McbotApi.MINECRAFT.equals(McbotApi.modVersion("minecraft"))&&McbotApi.NEOFORGE.equals(McbotApi.modVersion("neoforge"));
                return rule.requires().entrySet().stream().allMatch(e->McbotApi.versionsMatch(e.getKey(),e.getValue()));
            }
            public boolean block(BlockState state) {return rule.matchesBlock(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());}
            public boolean emptyHand() {return rule.emptyHand();}
            public boolean accepts(ItemStack held) {
                return rule.acceptsItem(BuiltInRegistries.ITEM.getKey(held.getItem()).toString(),tag->held.is(TagKey.create(Registries.ITEM,ResourceLocation.parse(tag))));
            }
            public void precondition(ServerPlayer player,BlockPos position,BlockState state,ItemStack held) {
                String refusal=rule.refusal(properties(state));
                if(refusal!=null) throw McbotApi.refuse("INTERACTION_NOT_READY",refusal);
            }
            public Expected expected() {return rule.expected();}
        };
    }
    static Map<String,String> properties(BlockState state) {
        Map<String,String> result=new TreeMap<>();
        for(Property<?> property:state.getProperties()) result.put(property.getName(),valueName(state,property));
        return result;
    }
    private static <T extends Comparable<T>> String valueName(BlockState state,Property<T> property) {return property.getName(state.getValue(property));}

    private static String id(JsonObject o,String key) {
        String value=o.has(key)?string(o.get(key),key):null;
        if(value==null||!ID.matcher(value).matches()) throw new IllegalArgumentException(key+" must look like namespace:path");
        return value;
    }
    private static Set<String> ids(JsonObject o,String key,boolean required) {
        if(!o.has(key)) { if(required) throw new IllegalArgumentException(key+" is required");return Set.of(); }
        Set<String> result=new TreeSet<>();
        for(JsonElement e:list(o,key)) { String v=string(e,key);if(!ID.matcher(v).matches()) throw new IllegalArgumentException("bad id in "+key+": "+v);result.add(v); }
        if(required&&result.isEmpty()) throw new IllegalArgumentException(key+" must not be empty");
        return result;
    }
    private static JsonArray list(JsonObject o,String key) {
        if(!o.get(key).isJsonArray()) throw new IllegalArgumentException(key+" must be a list");
        JsonArray array=o.getAsJsonArray(key);
        if(array.size()>MAX_LIST) throw new IllegalArgumentException(key+" lists more than "+MAX_LIST+" entries");
        return array;
    }
    private static String string(JsonElement e,String key) {
        if(!e.isJsonPrimitive()||!e.getAsJsonPrimitive().isString()||e.getAsString().isBlank()||e.getAsString().length()>128) throw new IllegalArgumentException(key+" must contain non-empty strings");
        return e.getAsString();
    }
    private static boolean bool(JsonObject o,String key) {
        if(!o.get(key).isJsonPrimitive()||!o.getAsJsonPrimitive(key).isBoolean()) throw new IllegalArgumentException(key+" must be true or false");
        return o.get(key).getAsBoolean();
    }
    private static int count(JsonElement e) {
        if(!e.isJsonPrimitive()||!e.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException("consume values must be integers 0..64");
        double v=e.getAsDouble();
        if(v!=Math.rint(v)||v<0||v>64) throw new IllegalArgumentException("consume values must be integers 0..64");
        return (int)v;
    }
}
