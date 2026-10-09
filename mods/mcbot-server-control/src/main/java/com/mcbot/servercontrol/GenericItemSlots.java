package com.mcbot.servercontrol;

import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.function.*;

/**
 * 8b generic item-slot access for mod machines without a dedicated adapter: list, insert and extract through the
 * loader's item handler of one side of the block, without opening a menu. Off by default; the server owner enables
 * it per mod (pinned version) in {@code config/mcbot-server-control/item-handlers.json}. The pure parts live here
 * (config, dispatch decision, slot loops) so they test without a game; {@link MachineItems} binds them to the world.
 *
 * <p>The slot loops follow the handler's own rules: {@code isItemValid} first, then a simulated insert or extract,
 * then the real call for exactly what the simulation accepted. Counts are what really moved. A handler that throws
 * or answers out of contract before anything really moved refuses the action; during a real call it is unknown.</p>
 */
final class GenericItemSlots {
    private GenericItemSlots() {}
    static final String FILE="item-handlers.json";
    /** Handler sides to look at: unsided (null) first, then the six faces by their vanilla names. */
    static final List<String> SIDES=Collections.unmodifiableList(Arrays.asList(null,"down","up","north","south","west","east"));
    static final int MAX_SLOTS=256;

    // ---------- config ----------
    /** {@code {"mods":{"modid":"exact version"},"note":"..."}}; unknown keys or bad values reject the whole file. */
    static Map<String,String> parse(JsonObject json) {
        for(String key:json.keySet()) if(!key.equals("mods")&&!key.equals("note")) throw new IllegalArgumentException("unknown key "+key);
        if(!json.has("mods")||!json.get("mods").isJsonObject()) throw new IllegalArgumentException("mods must be an object of mod id to exact version");
        if(json.has("note")&&!(json.get("note").isJsonPrimitive()&&json.getAsJsonPrimitive("note").isString())) throw new IllegalArgumentException("note must be a string");
        Map<String,String> mods=new TreeMap<>();
        for(var entry:json.getAsJsonObject("mods").entrySet()) {
            String mod=entry.getKey();JsonElement version=entry.getValue();
            if(!mod.matches("[a-z0-9_.-]{1,64}")) throw new IllegalArgumentException("bad mod id "+mod);
            if(mod.equals("minecraft")) throw new IllegalArgumentException("vanilla blocks are never generic: minecraft");
            if(!version.isJsonPrimitive()||!version.getAsJsonPrimitive().isString()||version.getAsString().isBlank()) throw new IllegalArgumentException("version of "+mod+" must be a non-empty string");
            mods.put(mod,version.getAsString());
        }
        return Map.copyOf(mods);
    }
    /** Pinned mods from the config file; a missing file enables nothing, a broken one is reported and enables nothing. */
    static Map<String,String> load(Path file,List<String> problems) {
        if(!Files.isRegularFile(file)) return Map.of();
        try { return parse(JsonParser.parseString(Files.readString(file,StandardCharsets.UTF_8)).getAsJsonObject()); }
        catch(Exception broken) { problems.add(FILE+" skipped: "+broken.getMessage());return Map.of(); }
    }
    /** Mods whose installed version is exactly the pinned one; a mismatch stays off and is reported. */
    static Set<String> enabled(Map<String,String> pinned,BiPredicate<String,String> versionsMatch,List<String> problems) {
        Set<String> result=new TreeSet<>();
        for(var entry:pinned.entrySet()) {
            if(versionsMatch.test(entry.getKey(),entry.getValue())) result.add(entry.getKey());
            else problems.add("generic item handler for "+entry.getKey()+" "+entry.getValue()+" stays off: not that version or not installed");
        }
        return Collections.unmodifiableSet(result);
    }

    // ---------- dispatch ----------
    /**
     * Why a block may not use generic access, or null when it may. Vanilla blocks go through their menus and built-in
     * workstations; a block with a dedicated adapter uses that adapter; other mods only when enabled.
     */
    static String refusal(String namespace,String dedicatedAdapter,Set<String> enabled) {
        if(namespace.equals("minecraft")) return "Vanilla blocks are used through open-container or the workstation tools";
        if(dedicatedAdapter!=null) return "Block has the dedicated adapter "+dedicatedAdapter+"; use open-container or the workstation tools";
        if(!enabled.contains(namespace)) return "Generic item access is off for mod "+namespace+"; the server owner can enable it in config/mcbot-server-control/"+FILE;
        return null;
    }
    /** A side argument: absent means unsided (null); otherwise one of the six faces. */
    static String side(String requested) {
        if(requested==null) return null;
        if(!SIDES.contains(requested)) throw Protocol.error("INVALID_ARGUMENT","side must be one of down, up, north, south, west, east (omit it for the unsided handler)");
        return requested;
    }

    // ---------- slots ----------
    interface Stacks<S> { boolean empty(S stack);int count(S stack);S copy(S stack,int count);boolean same(S a,S b); }
    /** One side's item handler (NeoForge IItemHandler semantics). */
    interface Slots<S> {
        int size();S get(int slot);int limit(int slot);boolean valid(int slot,S stack);
        S insert(int slot,S stack,boolean simulate);S extract(int slot,int amount,boolean simulate);
    }
    /** The body's side of an insert: items leave before the real insert, the handler's remainder comes back. */
    interface Pocket<S> { void take(int count);void giveBack(S rest); }
    /** The body's side of an extract: how many more of a stack fit, and storing it (returns what did not fit). */
    interface Room<S> { int room(S stack);S put(S stack);void spill(S stack); }
    record Step(int slot,int count) {}
    /** What really moved; uncertain counts items whose fate is unknown after a faulty real call. */
    static final class Moved {
        /** withheld: matching items the handler holds but would not give out (this side, or not finished yet). */
        final List<Step> steps=new ArrayList<>();int count,invalidSlots,uncertain,withheld;String fault;boolean unknown;
        Moved add(int slot,int n){if(n>0){steps.add(new Step(slot,n));count+=n;}return this;}
    }
    /** A handler that failed or broke its contract; afterWrite when a real (non-simulated) call was involved. */
    private static final class Fault extends RuntimeException { final boolean afterWrite;Fault(String message,boolean afterWrite){super(message,null,false,false);this.afterWrite=afterWrite;} }
    private static <T> T ask(Supplier<T> call,String what,boolean real) {
        try { return call.get(); }
        catch(RuntimeException | LinkageError broken) { throw new Fault(what+" threw "+broken.getClass().getSimpleName()+(broken.getMessage()==null?"":": "+broken.getMessage()),real); }
    }
    static <S> int size(Slots<S> slots) {
        int size=ask(slots::size,"getSlots",false);
        if(size<0) throw Protocol.error("UNSUPPORTED","Item handler reports a negative slot count");
        return size;
    }
    private static List<Integer> order(int size,int onlySlot) {
        if(onlySlot>=0) { if(onlySlot>=size) throw Protocol.error("INVALID_ARGUMENT","slot "+onlySlot+" is outside the handler's "+size+" slots");return List.of(onlySlot); }
        List<Integer> all=new ArrayList<>();for(int i=0;i<Math.min(size,MAX_SLOTS);i++)all.add(i);return all;
    }
    /** A failure before anything moved refuses; otherwise the moves so far are kept and the fault is recorded. */
    private static Moved fault(Moved moved,Fault fault) {
        if(moved.count==0&&!fault.afterWrite) throw Protocol.error("UNSUPPORTED","Item handler refused the generic contract: "+fault.getMessage());
        moved.fault=fault.getMessage();moved.unknown|=fault.afterWrite;return moved;
    }
    /** Count left in a handler's answer that must be empty or the same item with at most {@code limit}. */
    private static <S> int rest(Stacks<S> stacks,S answer,S template,int limit,String what,boolean real) {
        if(answer==null||stacks.empty(answer)) return 0;
        int n=stacks.count(answer);
        if(!stacks.same(answer,template)||n>limit||n<0) throw new Fault(what+" returned a different item or more than it was given",real);
        return n;
    }

    /**
     * Insert up to {@code wanted} of the template (into one slot, or slot by slot): isItemValid, simulate, then
     * really insert exactly what the simulation accepted. The pocket gives the items up just before the real call.
     */
    static <S> Moved insert(Slots<S> slots,Stacks<S> stacks,S template,int wanted,int onlySlot,Pocket<S> pocket) {
        Moved moved=new Moved();
        try {
            for(int slot:order(size(slots),onlySlot)) {
                int want=wanted-moved.count;if(want<=0)break;
                final int i=slot;
                if(!ask(()->slots.valid(i,stacks.copy(template,1)),"isItemValid",false)) {moved.invalidSlots++;continue;}
                S simulated=ask(()->slots.insert(i,stacks.copy(template,want),true),"simulated insertItem",false);
                int accepted=want-rest(stacks,simulated,template,want,"simulated insertItem",false);
                if(accepted<=0) continue;
                pocket.take(accepted);
                S real;
                try { real=slots.insert(i,stacks.copy(template,accepted),false); }
                catch(RuntimeException | LinkageError broken) { moved.uncertain+=accepted;throw new Fault("insertItem threw "+broken.getClass().getSimpleName(),true); }
                int left;
                try { left=rest(stacks,real,template,accepted,"insertItem",true); }
                catch(Fault bad) { moved.uncertain+=accepted;throw bad; }
                if(left>0) pocket.giveBack(stacks.copy(template,left));
                moved.add(i,accepted-left);
            }
        } catch(Fault failure) { return fault(moved,failure); }
        return moved;
    }

    /**
     * Extract up to {@code wanted} matching items (from one slot, or slot by slot), never more than the body can hold:
     * simulate, then really extract what the simulation offered. Whatever does not fit goes back into the slot; only
     * if the slot refuses it too is it spilled, and the result becomes unknown.
     */
    static <S> Moved extract(Slots<S> slots,Stacks<S> stacks,Predicate<S> wantedItem,int wanted,int onlySlot,Room<S> room) {
        Moved moved=new Moved();
        try {
            for(int slot:order(size(slots),onlySlot)) {
                int want=wanted-moved.count;if(want<=0)break;
                final int i=slot;
                S present=ask(()->slots.get(i),"getStackInSlot",false);
                if(present==null||stacks.empty(present)||!wantedItem.test(present)) continue;
                int amount=Math.min(want,room.room(present));
                if(amount<=0) { if(moved.fault==null)moved.fault="Inventory is full";continue; }
                S simulated=ask(()->slots.extract(i,amount,true),"simulated extractItem",false);
                int offered=rest(stacks,simulated,present,amount,"simulated extractItem",false);
                if(offered<=0) { moved.withheld+=stacks.count(present);continue; }
                S real;
                try { real=slots.extract(i,offered,false); }
                catch(RuntimeException | LinkageError broken) { moved.uncertain+=offered;throw new Fault("extractItem threw "+broken.getClass().getSimpleName(),true); }
                if(real==null||stacks.empty(real)) continue;
                boolean contract=stacks.same(real,present)&&stacks.count(real)<=offered;
                S over=room.put(real);
                int notStored=over==null||stacks.empty(over)?0:stacks.count(over);
                moved.add(i,stacks.count(real)-notStored);
                if(notStored>0) {
                    S still;
                    try { still=slots.insert(i,over,false); }
                    catch(RuntimeException | LinkageError broken) { moved.uncertain+=notStored;throw new Fault("insertItem (putting back) threw "+broken.getClass().getSimpleName(),true); }
                    if(still!=null&&!stacks.empty(still)) { room.spill(still);moved.uncertain+=stacks.count(still);throw new Fault("Extracted items did not fit and the slot refused them back; spilled at the body",true); }
                }
                if(!contract) throw new Fault("extractItem returned a different item or more than simulated",true);
            }
        } catch(Fault failure) { return fault(moved,failure); }
        return moved;
    }

    /** Slot contents for a listing: index, stack (null when empty) and the slot limit. */
    record Content<S>(int slot,S stack,int limit) {}
    static <S> List<Content<S>> contents(Slots<S> slots,Stacks<S> stacks) {
        List<Content<S>> result=new ArrayList<>();
        try {
            int size=size(slots);
            for(int i=0;i<Math.min(size,MAX_SLOTS);i++) {
                final int slot=i;S stack=ask(()->slots.get(slot),"getStackInSlot",false);
                result.add(new Content<>(i,stack==null||stacks.empty(stack)?null:stack,ask(()->slots.limit(slot),"getSlotLimit",false)));
            }
        } catch(Fault failure) { throw Protocol.error("UNSUPPORTED","Item handler refused the generic contract: "+failure.getMessage()); }
        return result;
    }
    /** Which sides expose a handler and how many slots each has; a side whose lookup throws is left out. */
    static <S> List<Map.Entry<String,Integer>> sides(Function<String,Slots<S>> lookup) {
        List<Map.Entry<String,Integer>> result=new ArrayList<>();
        for(String side:SIDES) {
            try { Slots<S> slots=lookup.apply(side);if(slots!=null)result.add(new AbstractMap.SimpleImmutableEntry<>(side,slots.size())); }
            catch(RuntimeException | LinkageError broken) { /* not offered */ }
        }
        return result;
    }
}
