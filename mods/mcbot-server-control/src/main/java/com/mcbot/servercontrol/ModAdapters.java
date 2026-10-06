package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.mcbot.servercontrol.api.ContainerAdapter;
import com.mcbot.servercontrol.api.ItemInteraction;
import com.mcbot.servercontrol.api.McbotApi;
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
    record Loaded(List<ContainerAdapter> containers,List<ItemInteraction> interactions,List<String> problems) {}
    private static final List<ContainerAdapter> BUILTIN_CONTAINERS=List.of(IronFurnaceAdapter.INSTANCE);
    private static final List<ItemInteraction> BUILTIN_INTERACTIONS=List.of(ItemInteractions.COMPOSTER);
    // Before a server starts only the built-ins are known; installed containers are resolved lazily then.
    private static volatile Loaded loaded=null;

    /** Freezes add-on registration and loads JSON interactions from {@code <config>/interactions}. */
    static synchronized Loaded load(Path configDirectory) {
        McbotApi.Registered registered=McbotApi.freeze();
        List<String> problems=new ArrayList<>();
        List<ItemInteraction> fromJson=JsonInteractions.loadDirectory(configDirectory.resolve("interactions"),problems);
        loaded=combine(BUILTIN_CONTAINERS,registered.containers(),BUILTIN_INTERACTIONS,fromJson,registered.interactions(),problems);
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
    static MenuSlotSources.Source playerSource(ContainerAdapter adapter,Slot slot,Inventory inventory) {
        try {
            OptionalInt index=adapter.playerSlot(slot,inventory);
            if(index.isPresent()&&index.getAsInt()>=0&&index.getAsInt()<inventory.getContainerSize()) return new MenuSlotSources.Source("player",index.getAsInt());
        } catch(RuntimeException | LinkageError broken) { /* unknown */ }
        return new MenuSlotSources.Source("unknown",null);
    }
}
