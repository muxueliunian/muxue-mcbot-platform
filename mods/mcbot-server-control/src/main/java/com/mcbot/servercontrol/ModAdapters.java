package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.mcbot.servercontrol.api.AppearanceSource;
import com.mcbot.servercontrol.api.ContainerAdapter;
import com.mcbot.servercontrol.api.EmoteSource;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
import com.mcbot.servercontrol.api.PickupSink;
import com.mcbot.servercontrol.api.workstation.Template;
import com.mcbot.servercontrol.api.workstation.WorkstationAdapter;
import net.minecraft.core.registries.BuiltInRegistries;
import java.nio.file.Path;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.MenuProvider;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Single dispatch point for mod adapters: built-in ones, JSON-configured interactions and add-on registrations.
 * Unknown blocks and menus stay unsupported. An adapter that throws is treated as not matching, never as a pass.
 */
final class ModAdapters {
    private ModAdapters() {}
    record Loaded(List<ContainerAdapter> containers,List<ItemInteraction> interactions,List<String> problems,List<PickupSink> pickupSinks) {
        Loaded(List<ContainerAdapter> containers,List<ItemInteraction> interactions,List<String> problems) {this(containers,interactions,problems,List.of());}
    }
    private static final List<ContainerAdapter> BUILTIN_CONTAINERS=List.of(IronFurnaceAdapter.INSTANCE);
    private static final List<ItemInteraction> BUILTIN_INTERACTIONS=List.of(ItemInteractions.COMPOSTER);
    // Before a server starts only the built-ins are known; installed containers are resolved lazily then.
    private static volatile Loaded loaded=null;
    private static volatile List<WorkstationAdapter> addonWorkstations=List.of();
    private static volatile List<EmoteSource> emoteSources=List.of();
    private static volatile List<AppearanceSource> appearances=List.of();
    private static volatile Set<String> itemHandlerMods=Set.of();

    /** Freezes add-on registration and loads JSON interactions from {@code <config>/interactions}. */
    static synchronized Loaded load(Path configDirectory) {
        McbotApi.Registered registered=McbotApi.freeze();
        List<String> problems=new ArrayList<>();
        List<ItemInteraction> fromJson=JsonInteractions.loadDirectory(configDirectory.resolve("interactions"),problems);
        Loaded combined=combine(BUILTIN_CONTAINERS,registered.containers(),BUILTIN_INTERACTIONS,fromJson,registered.interactions(),problems);
        Set<String> ids=new HashSet<>();for(var a:combined.containers())ids.add(safeId(a::id));for(var i:combined.interactions())ids.add(safeId(i::id));
        addonWorkstations=workstations(registered.workstations(),ids,problems);
        for(var w:addonWorkstations)ids.add(safeId(w::id));
        emoteSources=installedUnique(registered.emotes(),EmoteSource::id,EmoteSource::installed,ids,problems,"emote source");
        appearances=installedUnique(registered.appearances(),AppearanceSource::id,AppearanceSource::installed,ids,problems,"appearance source");
        itemHandlerMods=GenericItemSlots.enabled(GenericItemSlots.load(configDirectory.resolve(GenericItemSlots.FILE),problems),McbotApi::versionsMatch,problems);
        loaded=new Loaded(combined.containers(),combined.interactions(),List.copyOf(problems),installedSinks(registered.pickupSinks()));
        return loaded;
    }

    /** Built-ins first, then JSON, then add-ons; a repeated id keeps the first one and is reported. */
    static Loaded combine(List<ContainerAdapter> builtinContainers,List<ContainerAdapter> addonContainers,
                          List<ItemInteraction> builtinInteractions,List<ItemInteraction> jsonInteractions,List<ItemInteraction> addonInteractions,List<String> problems) {
        Set<String> seen=new HashSet<>();
        List<ContainerAdapter> containers=new ArrayList<>();
        for(ContainerAdapter adapter:concat(builtinContainers,addonContainers)) {
            String id=safeId(adapter::id);
            if(id==null) { problems.add("container adapter with a broken id() skipped");continue; }
            if(!seen.add(id)) { problems.add("duplicate adapter id "+id+" skipped");continue; }
            if(installed(adapter::installed)) containers.add(adapter);
        }
        List<ItemInteraction> interactions=new ArrayList<>();
        for(ItemInteraction interaction:concat(concat(builtinInteractions,jsonInteractions),addonInteractions)) {
            String id=safeId(interaction::id);
            if(id==null) { problems.add("interaction with a broken id() skipped");continue; }
            if(!seen.add(id)) { problems.add("duplicate adapter id "+id+" skipped");continue; }
            interactions.add(interaction);
        }
        return new Loaded(List.copyOf(containers),List.copyOf(interactions),List.copyOf(problems));
    }
    private static <T> List<T> concat(List<? extends T> a,List<? extends T> b) {List<T> r=new ArrayList<>(a);r.addAll(b);return r;}
    private static String safeId(java.util.function.Supplier<String> id) {
        try { return id.get(); } catch(RuntimeException | LinkageError broken) { return null; }
    }
    private static boolean installed(java.util.function.BooleanSupplier check) {
        try { return check.getAsBoolean(); } catch(RuntimeException | LinkageError broken) { return false; }
    }

    /** Add-on workstations that are installed, with unique ids not taken by a built-in or another adapter. */
    static List<WorkstationAdapter> workstations(List<WorkstationAdapter> addons,Set<String> taken,List<String> problems) {
        Set<String> seen=new HashSet<>(taken);for(WorkstationAdapter a:VanillaWorkstations.ALL)seen.add(a.id());seen.add(VanillaWorkstations.INVENTORY.id());
        List<WorkstationAdapter> result=new ArrayList<>();
        for(WorkstationAdapter adapter:addons) {
            String id=safeId(adapter::id);
            if(id==null) { problems.add("workstation adapter with a broken id() skipped");continue; }
            if(!seen.add(id)) { problems.add("duplicate adapter id "+id+" skipped");continue; }
            if(installed(adapter::installed)) result.add(adapter);
        }
        return List.copyOf(result);
    }
    static List<String> workstationIds() {List<String> ids=new ArrayList<>();for(var a:VanillaWorkstations.ALL)ids.add(a.id());for(var a:addonWorkstations)ids.add(safeId(a::id));return ids;}
    /**
     * The workstation adapter for a block state and template, or null. Vanilla blocks only ever match the built-in
     * adapters; add-ons are asked about other blocks only. An adapter that throws does not match.
     */
    static WorkstationAdapter workstation(BlockState state,Template template) {
        boolean vanilla=BuiltInRegistries.BLOCK.getKey(state.getBlock()).getNamespace().equals("minecraft");
        for(WorkstationAdapter adapter:vanilla?VanillaWorkstations.ALL:addonWorkstations) {
            try { if(adapter.template()==template&&adapter.block(state)) return adapter; } catch(RuntimeException | LinkageError broken) { /* not a match */ }
        }
        return null;
    }

    /** Whether an open menu is a verified workstation menu (built-in or add-on); such menus are observed read-only. */
    static boolean workstationMenu(AbstractContainerMenu menu) {
        if(menu instanceof net.minecraft.world.inventory.InventoryMenu)return false;
        List<WorkstationAdapter> all=new ArrayList<>(VanillaWorkstations.ALL);all.addAll(addonWorkstations);
        for(WorkstationAdapter adapter:all) {
            try { if(adapter.menu(menu)&&adapter.layout(menu)!=null) return true; } catch(RuntimeException | LinkageError broken) { /* not a match */ }
        }
        return false;
    }

    /** Installed add-ons with a working, unused id; the rest are reported or silently absent (not installed). */
    static <T> List<T> installedUnique(List<T> addons,java.util.function.Function<T,String> id,java.util.function.Predicate<T> installed,Set<String> taken,List<String> problems,String kind) {
        List<T> result=new ArrayList<>();
        for(T addon:addons) {
            String name=safeId(()->id.apply(addon));
            if(name==null) { problems.add(kind+" with a broken id() skipped");continue; }
            if(!taken.add(name)) { problems.add("duplicate adapter id "+name+" skipped");continue; }
            if(installed(()->installed.test(addon))) result.add(addon);
        }
        return List.copyOf(result);
    }
    static List<EmoteSource> emoteSources() {return emoteSources;}
    static List<AppearanceSource> appearances() {return appearances;}

    static List<PickupSink> installedSinks(List<PickupSink> sinks) {
        List<PickupSink> result=new ArrayList<>();
        for(PickupSink sink:sinks) if(safeId(sink::id)!=null&&installed(sink::installed)) result.add(sink);
        return List.copyOf(result);
    }
    static List<PickupSink> pickupSinks() {Loaded current=loaded;return current==null?List.of():current.pickupSinks();}
    /** Each installed sink's stored counts; null when any sink fails, so nothing can be attributed. */
    static Map<String,Map<String,Integer>> stored(ServerPlayer player) {
        Map<String,Map<String,Integer>> result=new LinkedHashMap<>();
        for(PickupSink sink:pickupSinks()) {
            try {
                Map<String,Integer> counts=sink.stored(player);
                if(counts==null) return null;
                result.put(sink.id(),Map.copyOf(counts));
            } catch(RuntimeException | LinkageError broken) { return null; }
        }
        return result;
    }
    /**
     * The sink that took exactly {@code count} of {@code item}: the only change across all sinks must be that one item id
     * growing by that count in one sink. Null otherwise.
     */
    static String absorbedBy(Map<String,Map<String,Integer>> before,Map<String,Map<String,Integer>> after,String item,int count) {
        if(before==null||after==null||count<=0||!before.keySet().equals(after.keySet())) return null;
        String sink=null;
        for(String id:before.keySet()) {
            Map<String,Integer> b=before.get(id),a=after.get(id);
            Set<String> keys=new HashSet<>(b.keySet());keys.addAll(a.keySet());
            for(String key:keys) {
                int delta=a.getOrDefault(key,0)-b.getOrDefault(key,0);
                if(delta==0) continue;
                if(sink!=null||!key.equals(item)||delta!=count) return null;
                sink=id;
            }
        }
        return sink;
    }

    static List<ContainerAdapter> containers() {
        Loaded current=loaded;
        if(current!=null) return current.containers();
        return BUILTIN_CONTAINERS.stream().filter(a->installed(a::installed)).toList();
    }
    /** Candidates only; {@link ItemInteractions#installed()} filters by installed version on each use. */
    static List<ItemInteraction> interactions() {
        Loaded current=loaded;
        return current==null?BUILTIN_INTERACTIONS:current.interactions();
    }
    static List<String> problems() {Loaded current=loaded;return current==null?List.of():current.problems();}
    static JsonArray containerIds() {
        JsonArray ids=new JsonArray();for(ContainerAdapter adapter:containers()) ids.add(adapter.id());return ids;
    }

    /** The adapter that supports this block state, or null. */
    static ContainerAdapter container(BlockState state) {
        if(NearbyBlocks.vanillaContainer(state)) return null;
        for(ContainerAdapter adapter:containers()) {
            try { if(adapter.block(state)) return adapter; } catch(RuntimeException | LinkageError broken) { /* not a match */ }
        }
        return null;
    }
    /** Mods the server owner enabled for generic item-handler access (pinned version installed). */
    static Set<String> itemHandlerMods() {return itemHandlerMods;}
    static JsonArray itemHandlerModIds() {JsonArray ids=new JsonArray();for(String mod:itemHandlerMods)ids.add(mod);return ids;}
    /** The dedicated storage adapter (container or add-on workstation) of a block, or null. */
    static String dedicatedAdapter(BlockState state) {
        ContainerAdapter container=container(state);
        if(container!=null) return safeId(container::id);
        for(Template template:Template.values()) { WorkstationAdapter station=workstation(state,template);if(station!=null) return safeId(station::id); }
        return null;
    }
    /** Why generic item-handler access is refused for this block, or null when it is allowed; dedicated adapters win. */
    static String itemHandlerRefusal(BlockState state) {
        return GenericItemSlots.refusal(BuiltInRegistries.BLOCK.getKey(state.getBlock()).getNamespace(),dedicatedAdapter(state),itemHandlerMods);
    }
    static boolean entityMatches(ContainerAdapter adapter,BlockEntity entity) {
        try { return adapter.entity(entity); } catch(RuntimeException | LinkageError broken) { return false; }
    }
    static MenuProvider provider(ServerPlayer player,BlockPos position,BlockState state) {
        ContainerAdapter adapter=container(state);
        if(adapter==null) return null;
        try { return adapter.provider(player,position,state); } catch(RuntimeException | LinkageError broken) { return null; }
    }
    /** The adapter whose verified menu this is, or null. */
    static ContainerAdapter menu(AbstractContainerMenu menu) {
        if(MenuSlotSources.vanilla(menu)) return null;
        for(ContainerAdapter adapter:containers()) {
            try { if(adapter.menu(menu)) return adapter; } catch(RuntimeException | LinkageError broken) { /* not a match */ }
        }
        return null;
    }
    /** Real storage behind a menu: the adapter's verified storage, otherwise the vanilla contracts. */
    static Container storage(AbstractContainerMenu menu,Inventory inventory) {
        ContainerAdapter adapter=menu(menu);
        if(adapter==null) return MenuSlotSources.storage(menu,inventory);
        try { return adapter.storage(menu,inventory); } catch(RuntimeException | LinkageError broken) { return null; }
    }
    static boolean storageSlot(ContainerAdapter adapter,Slot slot,Container storage) {
        if(storage==null) return false;
        try { return adapter.storageSlot(slot,storage); } catch(RuntimeException | LinkageError broken) { return false; }
    }
    /** Whether an opened menu's verified storage is the targeted block entity's: the entity itself, or vouched for by its adapter. */
    static boolean storageOf(AbstractContainerMenu menu,Container storage,Object entity) {
        if(storage==null) return false;
        if(storage==entity) return true;
        ContainerAdapter adapter=menu(menu);
        if(adapter==null) return false;
        try { return entity instanceof BlockEntity block&&adapter.storageOf(storage,block); } catch(RuntimeException | LinkageError broken) { return false; }
    }
    static MenuSlotSources.Source playerSource(ContainerAdapter adapter,Slot slot,Inventory inventory) {
        try {
            OptionalInt index=adapter.playerSlot(slot,inventory);
            if(index.isPresent()&&index.getAsInt()>=0&&index.getAsInt()<inventory.getContainerSize()) return new MenuSlotSources.Source("player",index.getAsInt());
        } catch(RuntimeException | LinkageError broken) { /* unknown */ }
        return new MenuSlotSources.Source("unknown",null);
    }
}
